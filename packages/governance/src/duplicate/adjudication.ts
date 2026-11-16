import type { SemanticIndexHealth } from "./semantic-index";

export type DuplicateVerdict = "DUPLICATE" | "POSSIBLE_DUPLICATE" | "NOT_DUPLICATE";

export interface DuplicateCandidateDecision {
  issueNumber: number;
  similarity: number;
  verdict: DuplicateVerdict;
  confidence: number;
  reasoning: string;
  overlappingSignals: string[];
  differingSignals: string[];
}

export interface DuplicateAdjudicationProvider {
  adjudicate(
    submissionSummary: string,
    candidates: Array<{ issueNumber: number; title: string; body?: string | null; similarity: number }>,
  ): Promise<DuplicateCandidateDecision[]>;
}

export interface DuplicatePolicyConfig {
  highConfidenceThreshold: number;
  mediumConfidenceThreshold: number;
  reviewDedupLabel: string;
}

export interface DuplicatePolicyOutcome {
  action: "REJECT_DUPLICATE" | "CREATE_WITH_REVIEW" | "CREATE_NEW";
  canonicalIssueNumber?: number;
  reasonCode: string;
  explanation: string;
  decisions: DuplicateCandidateDecision[];
  /** Semantic tier health. Callers must not present lexical-only results as two-tier. */
  semanticHealth?: SemanticIndexHealth;
}

/**
 * Pass 3 policy — deterministic decision from adjudication results.
 */
export function evaluateDuplicatePolicy(
  decisions: DuplicateCandidateDecision[],
  config: DuplicatePolicyConfig,
): DuplicatePolicyOutcome {
  if (decisions.length === 0) {
    return {
      action: "CREATE_NEW",
      reasonCode: "NO_CANDIDATES",
      explanation: "No similar issues found.",
      decisions,
    };
  }

  const top = decisions[0];
  if (top.verdict === "DUPLICATE" && top.confidence >= config.highConfidenceThreshold) {
    return {
      action: "REJECT_DUPLICATE",
      canonicalIssueNumber: top.issueNumber,
      reasonCode: "HIGH_CONFIDENCE_DUPLICATE",
      explanation: top.reasoning,
      decisions,
    };
  }

  if (
    top.verdict === "DUPLICATE" ||
    top.verdict === "POSSIBLE_DUPLICATE" ||
    top.confidence >= config.mediumConfidenceThreshold
  ) {
    return {
      action: "CREATE_WITH_REVIEW",
      reasonCode: "POSSIBLE_DUPLICATE",
      explanation: `${top.reasoning} Label ${config.reviewDedupLabel} will be applied.`,
      decisions,
    };
  }

  return {
    action: "CREATE_NEW",
    reasonCode: "NOT_DUPLICATE",
    explanation: "Candidates below duplicate confidence thresholds.",
    decisions,
  };
}

/**
 * Rule-based adjudication when no LLM provider is configured.
 */
export class HeuristicDuplicateAdjudicator implements DuplicateAdjudicationProvider {
  async adjudicate(
    submissionSummary: string,
    candidates: Array<{ issueNumber: number; title: string; body?: string | null; similarity: number }>,
  ): Promise<DuplicateCandidateDecision[]> {
    return candidates.map((c) => {
      let verdict: DuplicateVerdict = "NOT_DUPLICATE";
      let confidence = c.similarity;

      if (c.similarity >= 0.75) {
        verdict = "DUPLICATE";
        confidence = Math.min(0.95, c.similarity + 0.1);
      } else if (c.similarity >= 0.5) {
        verdict = "POSSIBLE_DUPLICATE";
      }

      return {
        issueNumber: c.issueNumber,
        similarity: c.similarity,
        verdict,
        confidence,
        reasoning: `Heuristic adjudication from similarity ${c.similarity.toFixed(2)}.`,
        overlappingSignals: tokenizeOverlap(submissionSummary, `${c.title} ${c.body ?? ""}`),
        differingSignals: [],
      };
    });
  }
}

function tokenizeOverlap(a: string, b: string): string[] {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  return [...setA].filter((t) => setB.has(t) && t.length >= 4).slice(0, 8);
}
