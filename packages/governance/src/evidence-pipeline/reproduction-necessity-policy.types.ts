/**
 * Reproduction necessity policy (Stage 5).
 * Deterministic policy that decides whether reproduction reproduction is needed.
 */

export type ReproductionAlternativeAction =
  | "TRIAGE_AND_ASSIGN"
  | "MONITOR_PR"
  | "AWAIT_RELEASE"
  | "RETEST_AFTER_DEPLOY"
  | "REQUEST_MORE_INFO"
  | "MANUAL_INVESTIGATION"
  | "GOVERNED_CLOSURE";

export type ReproductionPriority =
  | "immediate"
  | "after_release"
  | "scheduled"
  | "not_needed";

export interface ReproductionDecision {
  /** Whether reproduction reproduction should run */
  required: boolean;
  /** Explanation of the decision */
  reason: string;
  /** What to do instead of reproduction (when required=false) */
  alternativeAction?: ReproductionAlternativeAction;
  /** When to reproduce (if required=true) */
  priority: ReproductionPriority;
}

export interface ReproductionNecessityInput {
  evidenceStrength: number;
  reporterTrust: number;
  likelyFalsePositive: boolean;
  reproductionValue: "high" | "medium" | "low";
  fixStatus: string;
  fixConfidence: number;
  hasActivePR: boolean;
  hasLinkedImplementation: boolean;
  teamIsWorkingOnIt: boolean;
  isIncompleteReport: boolean;
  isDuplicate: boolean;
  isUnsupported: boolean;
  issueAgeInDays: number;
  lastReproducedAt?: Date;
}
