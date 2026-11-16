/**
 * Unified Intake Decision Contract.
 *
 * A new report is NOT an instruction to create a GitHub issue.
 * It is a request for Lexi to determine the correct engineering disposition.
 *
 * Only ACCEPT_NEW, REGRESSION, and LOW_CONFIDENCE_ACCEPT normally create issues.
 * POSSIBLE_DUPLICATE involves the reporter rather than letting the model silently decide.
 */

export type IntakeDisposition =
  | "ACCEPT_NEW"
  | "MATCH_EXISTING"
  | "POSSIBLE_DUPLICATE"
  | "REGRESSION"
  | "PREVIOUSLY_FIXED_NEEDS_VERIFICATION"
  | "NEEDS_INFO"
  | "LOW_CONFIDENCE_ACCEPT"
  | "SECURITY_BYPASS"
  | "NEEDS_HUMAN_REVIEW"
  | "REJECT_NON_BUG";

/** Whether this disposition creates a new canonical issue */
export function createsNewIssue(disposition: IntakeDisposition): boolean {
  return disposition === "ACCEPT_NEW" || disposition === "REGRESSION" || disposition === "LOW_CONFIDENCE_ACCEPT";
}

/** Whether this disposition requires human involvement before proceeding */
export function requiresHumanInput(disposition: IntakeDisposition): boolean {
  return disposition === "POSSIBLE_DUPLICATE" || disposition === "NEEDS_INFO" || disposition === "NEEDS_HUMAN_REVIEW";
}

export interface IntakeDecisionResult {
  disposition: IntakeDisposition;
  confidence: number;
  reasoning: string;

  /** Matched existing issue (for MATCH_EXISTING, POSSIBLE_DUPLICATE) */
  matchedIssue?: {
    number: number;
    title: string;
    url: string;
    similarity: number;
    state: "open" | "closed";
  };

  /** For REGRESSION: the original fixed issue */
  regressionOf?: {
    number: number;
    fixPR?: number;
  };

  /** For PREVIOUSLY_FIXED_NEEDS_VERIFICATION */
  fixEvidence?: {
    prNumber: number;
    prRepo: string;
  };

  /** Missing fields (for NEEDS_INFO) */
  missingFields?: string[];

  /** Coaching questions (for NEEDS_INFO) */
  coachingQuestions?: string[];

  /** Why this was rejected (for REJECT_NON_BUG) */
  rejectionReason?: string;

  /** Recourse path — always present */
  recourse: string;

  /** Corpus freshness at decision time */
  corpusFreshness: {
    complete: boolean;
    staleRepositories: string[];
    note?: string;
  };

  /** Policy/model versions used */
  policyVersion: string;
  modelVersion?: string;
}

/**
 * Intake draft status — the multi-turn coaching lifecycle.
 */
export type IntakeDraftStatus =
  | "COLLECTING"       // Gathering fields from reporter
  | "VALIDATING"       // Running validity/duplicate checks
  | "AWAITING_HUMAN"   // Waiting for reporter to adjudicate duplicate
  | "DECIDED"          // Final disposition reached
  | "CREATED"          // Canonical issue created
  | "ABANDONED"        // Reporter did not complete within budget
  | "EXPIRED";         // Draft expired (TTL)

export interface IntakeDraftFields {
  title?: string;
  stepsToReproduce?: string[];
  expectedBehaviour?: string;
  actualBehaviour?: string;
  environment?: Record<string, string>;
  platform?: string;
  appVersion?: string;
  accountType?: string;
  region?: string;
  currency?: string;
  evidenceUrls?: string[];
  labels?: string[];
  component?: string;
  severity?: string;
}

export interface IntakeDraft {
  id: string;
  /** Slack channel where the conversation is happening */
  channel: string;
  /** Slack thread timestamp */
  threadTs: string;
  /** Reporter's Slack ID */
  reporterSlackId: string;
  /** Current collected fields */
  fields: IntakeDraftFields;
  /** Which fields are still missing */
  missingFields: string[];
  /** How many coaching rounds have happened */
  coachingRounds: number;
  /** Maximum coaching rounds before routing to human review */
  maxCoachingRounds: number;
  /** Current status */
  status: IntakeDraftStatus;
  /** Decision (populated when status is DECIDED or CREATED) */
  decision?: IntakeDecisionResult;
  /** Created canonical issue number (populated when status is CREATED) */
  canonicalIssueNumber?: number;
  /** Source type */
  sourceType: "slack" | "api" | "github_intake" | "canonical_watcher";
  /** Created/updated timestamps */
  createdAt: Date;
  updatedAt: Date;
  /** Expires at (drafts don't live forever) */
  expiresAt: Date;
}
