import type { IssueAnalysis, IssueAnalysisInput } from "./issue-analysis.types";
import type { ObservationAssessment } from "./evidence-assessment.types";
import type { EngineeringInvestigation } from "./engineering-investigation.types";
import type { FixAssessment } from "./fix-assessment.types";
import type { ReproductionDecision } from "./reproduction-necessity-policy.types";
import type { IssueAnalysisResult, IssueAnalysisService } from "./issue-analysis.service";
import type { EngineeringChangeInvestigationService } from "./engineering-investigation.service";
import { assessEvidence, type EvidenceAssessmentInput } from "./evidence-assessment.service";
import { assessFixLikelihood } from "./fix-assessment.service";
import { evaluateReproductionNecessity } from "./reproduction-necessity-policy";

/**
 * Routing outcome from the evidence-first pipeline.
 * The orchestrator uses this to decide what transition to make.
 */
export interface EvidenceRoutingOutcome {
  /** The workflow target state */
  routeTo: "QUEUED" | "SLACK_NOTIFIED" | "RETEST" | "CLOSED" | "WRITE_BLOCKED";
  /** Human-readable explanation */
  reason: string;
  /** The reproduction necessity decision */
  reproductionDecision: ReproductionDecision;
  /** All persisted stage results for the assessment record */
  stages: {
    issueAnalysis: IssueAnalysisResult;
    observationAssessment: ObservationAssessment;
    engineeringInvestigation: EngineeringInvestigation & { repositoriesChecked: string[]; activeEngineeringWork: boolean; errors: Array<{ stage: string; message: string; recoverable: boolean }> };
    fixAssessment: FixAssessment;
    reproductionDecision: ReproductionDecision;
  };
}

export interface EvidenceFirstRouterConfig {
  enabled: boolean;
  writesEnabled: boolean;
  /** Staff login conventions, passed to the evidence assessment. See {@link EvidenceAssessmentInput}. */
  developerLoginPatterns?: readonly RegExp[];
}

/**
 * The Evidence-First Router runs the full assessment pipeline and returns
 * a routing outcome. The orchestrator calls this instead of going directly
 * to reproduction.
 *
 * Flow:
 *   1. Claude issue analysis (or deterministic fallback)
 *   2. Evidence quality + source trust assessment
 *   3. Engineering change investigation (GitHub)
 *   4. Fix likelihood assessment
 *   5. Reproduction necessity policy
 *   6. Route to appropriate workflow state
 */
export class EvidenceFirstRouter {
  constructor(
    private readonly analysisService: IssueAnalysisService,
    private readonly investigationService: EngineeringChangeInvestigationService,
    private readonly config: EvidenceFirstRouterConfig,
  ) {}

  async evaluate(input: IssueAnalysisInput): Promise<EvidenceRoutingOutcome> {
    // Stage 1: Issue analysis (Claude or fallback)
    const analysisResult = await this.analysisService.analyse(input);
    const analysis = analysisResult.analysis;

    // Stage 2: Evidence assessment (deterministic)
    const observationAssessment = assessEvidence({
      authorLogin: input.authorLogin,
      labels: input.labels,
      body: input.body,
      analysis,
      developerLoginPatterns: this.config.developerLoginPatterns,
    });

    // Stage 3: Engineering investigation (GitHub API)
    const investigation = await this.investigationService.investigate(
      input.issueNumber,
      analysis.codeSearchTerms,
    );

    // Stage 4: Fix assessment (deterministic synthesis)
    const fixAssessment = assessFixLikelihood(investigation);

    // Stage 5: Reproduction necessity policy (deterministic)
    const issueAgeInDays = Math.floor((Date.now() - input.createdAt.getTime()) / (1000 * 60 * 60 * 24));
    const reproductionDecision = evaluateReproductionNecessity({
      evidenceStrength: observationAssessment.evidenceStrength,
      reporterTrust: observationAssessment.reporterTrust,
      likelyFalsePositive: analysis.likelyFalsePositive,
      reproductionValue: analysis.reproductionValue,
      fixStatus: fixAssessment.status,
      fixConfidence: fixAssessment.confidence,
      hasActivePR: investigation.linkedPullRequests.some((pr) => pr.state === "open"),
      hasLinkedImplementation: investigation.linkedIssues.some((i) => i.relationship === "implementation"),
      teamIsWorkingOnIt: investigation.activeEngineeringWork,
      isIncompleteReport: analysis.reportCompleteness === "minimal" && observationAssessment.evidenceStrength < 0.3,
      isDuplicate: false, // Duplicate detection is a separate system — not handled here
      isUnsupported: false, // Determined by reproduction scenario availability — not here
      issueAgeInDays,
    });

    // Stage 6: Route
    const routeTo = this.determineRoute(reproductionDecision, fixAssessment);

    return {
      routeTo,
      reason: reproductionDecision.reason,
      reproductionDecision,
      stages: {
        issueAnalysis: analysisResult,
        observationAssessment,
        engineeringInvestigation: investigation,
        fixAssessment,
        reproductionDecision,
      },
    };
  }

  private determineRoute(
    decision: ReproductionDecision,
    fixAssessment: FixAssessment,
  ): EvidenceRoutingOutcome["routeTo"] {
    // Write gate check
    if (!this.config.writesEnabled && decision.required) {
      return "WRITE_BLOCKED";
    }

    if (decision.required) {
      // Route to reproduction pipeline
      if (decision.priority === "after_release") {
        return "RETEST"; // Will wait for release trigger
      }
      return "QUEUED"; // Standard reproduction path
    }

    // Not requiring reproduction — route based on alternative action
    switch (decision.alternativeAction) {
      case "TRIAGE_AND_ASSIGN":
        return "SLACK_NOTIFIED"; // Assign and notify team
      case "MONITOR_PR":
        return "SLACK_NOTIFIED"; // Notify team, track PR
      case "AWAIT_RELEASE":
        return "RETEST"; // Wait for release, then retest
      case "RETEST_AFTER_DEPLOY":
        return "RETEST";
      case "REQUEST_MORE_INFO":
        return "SLACK_NOTIFIED"; // Notify requesting more info
      case "MANUAL_INVESTIGATION":
        return "SLACK_NOTIFIED"; // Team notification for manual handling
      case "GOVERNED_CLOSURE":
        return "CLOSED";
      default:
        return "QUEUED"; // Conservative: send to reproduction if unclear
    }
  }
}
