/**
 * Review-verdict ledger types consumed by the review gate.
 *
 * One permission ("may record a review verdict") plus a `domain` column, rather
 * than one role per domain: the question the gate must answer — "has this actor
 * already reviewed this change in another domain?" — is about the ledger, not
 * about the actor's grants, so it cannot be expressed as a role check.
 */

/** The three review domains every change needs, each with a distinct owner. */
export const REVIEW_DOMAINS = ["design", "engineering", "security"] as const;
export type ReviewDomain = (typeof REVIEW_DOMAINS)[number];

/** `exception` is a non-pass accepted for a bounded time by an accountable owner. */
export type ReviewVerdictOutcome = "pass" | "fail" | "exception";

/** A link to whatever the reviewer looked at. `kind` marks evidence the gate reads specially. */
export interface ReviewEvidence {
  label: string;
  uri: string;
  kind?: "performance" | "accessibility" | "security" | "other";
}

/**
 * The terms of a time-bounded exception. All four fields are required; the gate
 * re-checks them at evaluation time because a stored JSON column can be `{}`.
 */
export interface ReviewException {
  /** ISO-8601 instant after which the exception no longer counts. */
  expiresAt: string;
  /** How the residual risk is watched while the exception stands. */
  monitoring: string;
  /** What will remove the need for the exception. */
  remediation: string;
  /** The accountable person. Must not be the change author. */
  ownerId: string;
}

export interface ReviewVerdictRecord {
  id: string;
  /** Identifies the change under review, for example `pr/acme/web#42`. */
  changeRef: string;
  domain: ReviewDomain;
  outcome: ReviewVerdictOutcome;
  /** Who recorded the verdict. */
  actorId: string;
  /** The change author as stamped on the row, when the store knows it. */
  authorId?: string;
  /** ISO-8601 instant, stamped by the store clock on write. */
  recordedAt: string;
  rationale?: string;
  evidence?: ReviewEvidence[];
  exception?: ReviewException | null;
}

export interface ReviewGateInput {
  changeRef: string;
  /** The change author, as the caller knows it. */
  authorId: string;
  /** Verdicts to evaluate. Rows for other changeRefs are ignored. */
  verdicts: readonly ReviewVerdictRecord[];
  /** ISO-8601 evaluation instant, injected so expiry is testable. */
  now: string;
  /** True when a performance budget was set at spec time. */
  performanceBudgetSet?: boolean;
}

export type ReviewGateRefusalCode =
  | "DOMAIN_UNCOVERED"
  | "SELF_VERDICT_FORBIDDEN"
  | "CROSS_DOMAIN_ACTOR"
  | "BLOCKING_FAILURE"
  | "EVIDENCE_REQUIRED"
  | "PERFORMANCE_EVIDENCE_REQUIRED"
  | "EXCEPTION_INCOMPLETE"
  | "EXCEPTION_OWNER_IS_AUTHOR"
  | "EXCEPTION_EXPIRED";

export interface ReviewGateRefusal {
  code: ReviewGateRefusalCode;
  domain?: ReviewDomain;
  actorId?: string;
  detail: string;
}

export interface ReviewGateEvaluation {
  allowed: boolean;
  refusals: ReviewGateRefusal[];
  /** Domains with at least one verdict on this change, in REVIEW_DOMAINS order. */
  coveredDomains: ReviewDomain[];
}
