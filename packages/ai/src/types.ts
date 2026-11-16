export const CLASSIFICATIONS = [
  "VERIFIED",
  "LIKELY_FIXED",
  "CANNOT_REPRODUCE",
  "DUPLICATE",
  "NEEDS_MORE_INFO",
  "NEEDS_MANUAL_INVESTIGATION",
  "NOT_OBSERVED_WITH_COMPLETE_COVERAGE",
  "BLOCKED_BY_OTP",
  "BLOCKED_BY_KYC",
  "BLOCKED_BY_PAYMENT",
  "BLOCKED_BY_CREDENTIALS",
  "BLOCKED_BY_ENVIRONMENT",
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

/**
 * The single output contract of the AI Decision Engine. AI produces this
 * object only -- no side effects. Deterministic code downstream (workflows
 * package) is solely responsible for turning a Decision into GitHub/Slack
 * mutations and DB writes.
 */
export interface Decision {
  classification: Classification;
  component: string;
  team: string;
  owner?: string | null;
  confidence: number;
  labels: string[];
  summary: string;
  reasoning: string;
  nextAction: string;
}

export interface AiIssueContext {
  number: number;
  title: string;
  body: string | null;
  url: string;
  authorLogin: string | null;
  labels: string[];
}

export interface AiReproductionContext {
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "TIMEOUT" | "CANCELLED";
  resultSummary?: string | null;
  resultDetails?: Record<string, unknown> | null;
  logsUrl?: string | null;
}

export interface AiDecisionInput {
  issue: AiIssueContext;
  reproduction: AiReproductionContext | null;
  existingComments?: string[];
  metadata?: Record<string, unknown>;
}
