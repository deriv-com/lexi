/**
 * Duplicate Orchestrator — production-grade duplicate detection pipeline.
 *
 * Orchestrates the full lifecycle:
 * 1. Hybrid retrieval (structured + lexical + semantic)
 * 2. LLM adjudication (with heuristic fallback)
 * 3. Policy evaluation (DUPLICATE / POSSIBLE_DUPLICATE / NOT_DUPLICATE)
 * 4. Human adjudication for medium-confidence decisions
 * 5. Information-preserving consolidation before closure
 * 6. Reporter rejection handling
 * 7. Closed-issue semantics
 *
 * INVARIANTS:
 * - A duplicate may NEVER be closed until unique information is preserved on canonical
 * - Medium-confidence decisions REQUIRE human adjudication
 * - Reporters can reject a proposed duplicate
 */

import type { IssueSearchCandidate } from "./lexical-search";
import type { VectorIndexProvider, SemanticIndexHealth } from "./semantic-index";
import type { DuplicateAdjudicationProvider, DuplicateCandidateDecision, DuplicatePolicyOutcome } from "./adjudication";
import { evaluateDuplicatePolicy, HeuristicDuplicateAdjudicator } from "./adjudication";
import { hybridRetrieval, type HybridRetrievalConfig, type HybridRetrievalResult } from "./hybrid-retrieval";
import type { ConsolidationInput, ConsolidationResult } from "./consolidation.service";
import { ConsolidationService } from "./consolidation.service";
import type { HumanAdjudicationInput } from "./human-adjudication.service";
import { HumanAdjudicationService } from "./human-adjudication.service";
import { resolveClosedIssueAction, type ClosedIssueContext } from "./duplicate-engine";

export interface DuplicateOrchestratorConfig {
  /** Threshold above which auto-close is permitted (no human review). */
  highConfidenceThreshold: number;
  /** Threshold above which human adjudication is required. */
  mediumConfidenceThreshold: number;
  /** Label applied to issues pending duplicate review. */
  reviewDedupLabel: string;
  /** Hybrid retrieval configuration. */
  retrieval: Partial<HybridRetrievalConfig>;
  /** Whether LLM adjudication is enabled. */
  llmAdjudicationEnabled: boolean;
  /** Whether human adjudication is enabled (for medium-confidence). */
  humanAdjudicationEnabled: boolean;
  /** Whether consolidation is required before closure. */
  consolidationRequired: boolean;
  /** Whether closed-issue semantics are enabled. */
  closedIssueSemanticsEnabled: boolean;
  /**
   * Whether the calibrated 0-1 similarity is handed to the adjudicator as
   * `similarity`, instead of the legacy reciprocal-rank-fusion score.
   *
   * Defaults to FALSE, which preserves the legacy (broken) behaviour exactly.
   * The calibrated value is computed and reported either way — see
   * `HybridCandidate.calibratedSimilarity` — so the new scoring can be observed
   * against live traffic before it is allowed to decide anything.
   *
   * Off by default because turning it on changes live behaviour on three paths
   * at once: `HeuristicDuplicateAdjudicator`, `LlmDuplicateAdjudicator`'s
   * gateway-outage fallback, and the LLM prompt itself, which renders this
   * number to the model as "lexical similarity".
   */
  calibratedSimilarityEnabled?: boolean;
}

export interface DuplicateOrchestratorOutcome {
  /** Final pipeline action. */
  action: "REJECT_DUPLICATE" | "NEEDS_HUMAN_ADJUDICATION" | "CREATE_WITH_REVIEW" | "CREATE_NEW";
  /** Canonical issue number if duplicate identified. */
  canonicalIssueNumber?: number;
  /** Explanation for Lexi to communicate. */
  explanation: string;
  /** Detailed reasoning for audit. */
  reasoning: string;
  /** Adjudication decisions. */
  decisions: DuplicateCandidateDecision[];
  /** Hybrid retrieval results for audit/replay. */
  retrievalResult: HybridRetrievalResult;
  /** Semantic health for transparency. */
  semanticHealth: SemanticIndexHealth;
  /** Consolidation result (if consolidation was performed). */
  consolidation?: ConsolidationResult;
  /** Human adjudication request ID (if escalated). */
  humanAdjudicationId?: string;
  /** Closed-issue action (if canonical is closed). */
  closedIssueAction?: "REOPEN" | "REGRESSION" | "RESOLVE_CANONICAL" | "NONE";
  /** Confidence of top candidate. */
  topConfidence?: number;
  /**
   * Whether the calibrated similarity was authoritative for this evaluation
   * (i.e. handed to the adjudicator), or merely observed alongside the legacy
   * reciprocal-rank-fusion score.
   */
  calibratedSimilarityActive: boolean;
  /**
   * Calibrated 0-1 likeness of the top-ranked candidate, ALWAYS reported.
   *
   * While `calibratedSimilarityActive` is false this is the shadow signal:
   * compare it against the duplicate thresholds to see what the calibrated
   * scoring would have concluded, without letting it conclude anything yet.
   */
  topCalibratedSimilarity?: number;
}

export class DuplicateOrchestrator {
  constructor(
    private readonly vectorIndex: VectorIndexProvider,
    private readonly adjudicator: DuplicateAdjudicationProvider,
    private readonly consolidation: ConsolidationService | null,
    private readonly humanAdjudication: HumanAdjudicationService | null,
    private readonly config: DuplicateOrchestratorConfig,
  ) {}

  /**
   * Full duplicate detection pipeline.
   */
  async evaluate(
    title: string,
    steps: string[],
    actualBehaviour: string,
    corpusCandidates: IssueSearchCandidate[],
    options?: {
      sourceIssueNumber?: number;
      sourceRepository?: string;
      reporterSlackId?: string;
    },
  ): Promise<DuplicateOrchestratorOutcome> {
    // Step 1: Hybrid retrieval
    const retrievalResult = await hybridRetrieval(
      title,
      steps,
      actualBehaviour,
      corpusCandidates,
      this.vectorIndex,
      this.config.retrieval,
    );

    const semanticHealth = retrievalResult.semanticHealth;

    // No candidates found
    if (retrievalResult.candidates.length === 0) {
      return {
        action: "CREATE_NEW",
        explanation: "No similar issues found in the corpus.",
        reasoning: "Hybrid retrieval returned zero candidates across all tiers.",
        decisions: [],
        retrievalResult,
        semanticHealth,
        calibratedSimilarityActive: this.config.calibratedSimilarityEnabled === true,
      };
    }

    // Step 2: Adjudicate candidates
    const queryText = `${title}\n${steps.join("\n")}\n${actualBehaviour}`;
    // `c.score` is a reciprocal-rank-fusion value — an ordering key whose
    // maximum is 1/61 — while every adjudicator thresholds `similarity` at
    // 0.75/0.5. Passing the RRF score is what made the heuristic path unable to
    // report a duplicate for any input. `calibratedSimilarity` is the 0-1
    // likeness derived from the per-tier scores and is what those thresholds
    // are expecting; it is only used once the flag is on.
    const useCalibrated = this.config.calibratedSimilarityEnabled === true;
    // Reported on every outcome regardless of the flag, so the new scoring can
    // be watched against live traffic before it is allowed to decide anything.
    const topCalibratedSimilarity = retrievalResult.candidates[0]?.calibratedSimilarity;
    const candidatesForAdjudication = retrievalResult.candidates.map((c) => {
      const corpus = corpusCandidates.find((cc) => cc.number === c.issueNumber);
      return {
        issueNumber: c.issueNumber,
        title: corpus?.title ?? "",
        body: corpus?.body,
        similarity: useCalibrated ? c.calibratedSimilarity : c.score,
      };
    });

    const decisions = await this.adjudicator.adjudicate(queryText, candidatesForAdjudication);

    // Step 3: Policy evaluation
    const policyOutcome = evaluateDuplicatePolicy(decisions, {
      highConfidenceThreshold: this.config.highConfidenceThreshold,
      mediumConfidenceThreshold: this.config.mediumConfidenceThreshold,
      reviewDedupLabel: this.config.reviewDedupLabel,
    });

    const topDecision = decisions[0];
    const topConfidence = topDecision?.confidence;

    // Step 4: Route based on confidence
    if (policyOutcome.action === "REJECT_DUPLICATE" && topDecision) {
      // HIGH confidence — check closed-issue semantics, then consolidate
      let closedIssueAction: "REOPEN" | "REGRESSION" | "RESOLVE_CANONICAL" | "NONE" | undefined;

      if (this.config.closedIssueSemanticsEnabled) {
        const canonical = corpusCandidates.find((c) => c.number === topDecision.issueNumber);
        if (canonical && canonical.state === "closed") {
          closedIssueAction = resolveClosedIssueAction({
            state: canonical.state,
            closedReason: canonical.closedReason,
            labels: canonical.labels,
          });
        }
      }

      // Consolidation is REQUIRED before closure
      let consolidation: ConsolidationResult | undefined;
      if (this.config.consolidationRequired && this.consolidation && options?.sourceIssueNumber) {
        const sourceCandidate = corpusCandidates.find((c) => c.number === options.sourceIssueNumber);
        const canonicalCandidate = corpusCandidates.find((c) => c.number === topDecision.issueNumber);

        if (canonicalCandidate) {
          const consolidationInput: ConsolidationInput = {
            sourceIssueNumber: options.sourceIssueNumber,
            sourceRepository: options.sourceRepository ?? "",
            sourceTitle: title,
            sourceBody: `${steps.join("\n")}\n\n${actualBehaviour}`,
            sourceLabels: [],
            canonicalIssueNumber: topDecision.issueNumber,
            canonicalRepository: options.sourceRepository ?? "",
            canonicalTitle: canonicalCandidate.title,
            canonicalBody: canonicalCandidate.body ?? "",
            canonicalLabels: canonicalCandidate.labels,
            adjudicationReasoning: topDecision.reasoning,
          };
          consolidation = await this.consolidation.consolidate(consolidationInput);
        }
      }

      return {
        action: "REJECT_DUPLICATE",
        canonicalIssueNumber: topDecision.issueNumber,
        explanation: this.buildExplanation(topDecision, semanticHealth),
        reasoning: topDecision.reasoning,
        decisions,
        retrievalResult,
        semanticHealth,
        consolidation,
        closedIssueAction,
        topConfidence,
        calibratedSimilarityActive: useCalibrated,
        topCalibratedSimilarity,
      };
    }

    if (policyOutcome.action === "CREATE_WITH_REVIEW" && topDecision) {
      // MEDIUM confidence — human adjudication required
      if (this.config.humanAdjudicationEnabled && this.humanAdjudication && options?.sourceIssueNumber) {
        const canonical = corpusCandidates.find((c) => c.number === topDecision.issueNumber);

        const adjInput: HumanAdjudicationInput = {
          sourceIssueNumber: options.sourceIssueNumber,
          sourceRepository: options.sourceRepository ?? "",
          sourceTitle: title,
          candidateIssueNumber: topDecision.issueNumber,
          candidateRepository: options.sourceRepository ?? "",
          candidateTitle: canonical?.title ?? "",
          confidence: topDecision.confidence,
          reasoning: topDecision.reasoning,
          reporterSlackId: options.reporterSlackId,
        };

        const adjId = await this.humanAdjudication.requestAdjudication(adjInput);

        return {
          action: "NEEDS_HUMAN_ADJUDICATION",
          canonicalIssueNumber: topDecision.issueNumber,
          explanation: `A possible duplicate was found (issue #${topDecision.issueNumber}, ${(topDecision.confidence * 100).toFixed(0)}% confidence). A reviewer has been asked to confirm. ${this.degradationNote(semanticHealth)}`,
          reasoning: topDecision.reasoning,
          decisions,
          retrievalResult,
          semanticHealth,
          humanAdjudicationId: adjId,
          topConfidence,
          calibratedSimilarityActive: useCalibrated,
          topCalibratedSimilarity,
        };
      }

      // Human adjudication not enabled — fall through to CREATE_WITH_REVIEW
      return {
        action: "CREATE_WITH_REVIEW",
        canonicalIssueNumber: topDecision.issueNumber,
        explanation: `Possible duplicate of #${topDecision.issueNumber} (${(topDecision.confidence * 100).toFixed(0)}% confidence). Issue created with ${this.config.reviewDedupLabel} label for review. ${this.degradationNote(semanticHealth)}`,
        reasoning: topDecision.reasoning,
        decisions,
        retrievalResult,
        semanticHealth,
        topConfidence,
        calibratedSimilarityActive: useCalibrated,
        topCalibratedSimilarity,
      };
    }

    // LOW confidence — create new
    return {
      action: "CREATE_NEW",
      explanation: `No strong duplicates found.${this.degradationNote(semanticHealth) ? ` ${this.degradationNote(semanticHealth)}` : ""}`,
      reasoning: policyOutcome.explanation,
      decisions,
      retrievalResult,
      semanticHealth,
      topConfidence,
      calibratedSimilarityActive: useCalibrated,
      topCalibratedSimilarity,
    };
  }

  private buildExplanation(decision: DuplicateCandidateDecision, health: SemanticIndexHealth): string {
    const confidence = (decision.confidence * 100).toFixed(0);
    let explanation = `This appears to be a duplicate of issue #${decision.issueNumber} (${confidence}% confidence). ${decision.reasoning}`;

    if (decision.overlappingSignals.length > 0) {
      explanation += ` Shared signals: ${decision.overlappingSignals.slice(0, 4).join(", ")}.`;
    }

    const note = this.degradationNote(health);
    if (note) explanation += ` ${note}`;

    return explanation;
  }

  private degradationNote(health: SemanticIndexHealth): string {
    if (health.status !== "operational") {
      return `Note: Semantic search did not contribute (${health.detail.slice(0, 100)}).`;
    }
    return "";
  }
}
