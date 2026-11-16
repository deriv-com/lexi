/**
 * Evidence quality and source trust assessment (Stage 2).
 * Evaluates whether the report itself is credible and what level
 * of verification is needed.
 */

export type IssueSourceType =
  | "human_qa"
  | "developer"
  | "customer_support"
  | "automated_test"
  | "ai_generated"
  | "unknown";

export interface ObservationAssessment {
  /** Whether the bug was credibly observed (true/false/null=unknown) */
  observed: boolean | null;
  /** Classified source of the report */
  sourceType: IssueSourceType;
  /** Quality of evidence in the report (0.0 - 1.0) */
  evidenceStrength: number;
  /** Trust level of the reporter/source (0.0 - 1.0) */
  reporterTrust: number;
  /** Whether reproduction is needed to validate this report */
  requiresReproduction: boolean;
  /** Explanation of the assessment */
  reasons: string[];
}

/**
 * Default trust levels by source type. These are starting points —
 * the assessment service may adjust based on reporter history,
 * evidence artifacts (videos, screenshots), and report completeness.
 */
export const SOURCE_TRUST_DEFAULTS: Record<IssueSourceType, number> = {
  human_qa: 0.8,
  developer: 0.9,
  customer_support: 0.5,
  automated_test: 0.7,
  ai_generated: 0.3,
  unknown: 0.2,
};
