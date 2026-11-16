/**
 * Fix likelihood assessment (Stage 4).
 * Synthesizes investigation results into a structured fix status.
 */

export type FixStatus =
  | "NO_FIX_EVIDENCE"
  | "FIX_IN_PROGRESS"
  | "PR_MERGED_NOT_RELEASED"
  | "RELEASED_NOT_VERIFIED"
  | "LIKELY_FIXED"
  | "FIX_CONFIRMED";

export interface FixAssessment {
  status: FixStatus;
  /** Confidence in this assessment (0.0 - 1.0) */
  confidence: number;
  /** Issue numbers that are linked as fix implementations */
  linkedIssues: string[];
  /** PR references that may contain the fix */
  linkedPullRequests: string[];
  /** Files changed in fix PRs */
  changedFiles: string[];
  /** Evidence that the fix was released */
  releaseEvidence: string[];
  /** What evidence is still missing to confirm */
  missingEvidence: string[];
  /** Whether reproduction reproduction is required to resolve uncertainty */
  reproductionRequired: boolean;
  /** Human-readable explanation */
  reasoning: string;
  /** When this assessment was computed */
  assessedAt: Date;
}
