/**
 * Unified Verification Contract
 *
 * This is the SINGLE canonical type that:
 * - All verification adapters produce (automated, assisted, manual)
 * - All downstream consumers read (policy, auto-close, escalation, replay)
 *
 * Design principles:
 * - Policy does not care WHERE evidence came from (executor abstraction)
 * - Policy cares about verdict quality, lifecycle coverage, completeness,
 *   freshness, and limitations
 * - UNSUPPORTED / infra-failure / no-result can NEVER become negative evidence
 * - Lifecycle coverage is preserved across all adapters
 * - Capability gaps are recorded whenever verdict is UNSUPPORTED
 *
 * Contract version is included so consumers can detect schema evolution.
 */

import type { LifecycleCoverage } from "./lifecycle-coverage";

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * The four possible verification verdicts. These replace the scattered
 * `reproduced: boolean | null` + `outcomeKind` + `classification` logic.
 *
 * OBSERVED: The bug was reproduced — it exists.
 * NOT_OBSERVED_COMPLETE_COVERAGE: Full lifecycle coverage reached the
 *   reported state and the bug was not seen. This IS valid negative evidence.
 * INCONCLUSIVE: Evidence is incomplete — reached some states but not all
 *   required ones. NOT valid negative evidence. NOT valid positive evidence.
 * UNSUPPORTED: No verification capability exists for this issue class.
 *   NOT evidence of anything — records a capability gap.
 */
export type VerificationVerdict =
  | "OBSERVED"
  | "NOT_OBSERVED_COMPLETE_COVERAGE"
  | "INCONCLUSIVE"
  | "UNSUPPORTED";

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Which verification executor produced this result.
 * Policy doesn't branch on this — it's metadata for audit/replay.
 */
export type VerificationExecutor =
  | "automated"
  | "assisted"
  | "manual"
  | "llm"
  | "none";

// ---------------------------------------------------------------------------
// Blocked-by
// ---------------------------------------------------------------------------

/**
 * When verdict is INCONCLUSIVE, the reason verification couldn't complete.
 * Maps directly to the existing BLOCKED_BY_* classifications.
 */
export type VerificationBlocker =
  | "OTP"
  | "KYC"
  | "PAYMENT"
  | "CREDENTIALS"
  | "ENVIRONMENT"
  | "EXTERNAL_SERVICE"
  | "INFRA_FAILURE";

// ---------------------------------------------------------------------------
// Evidence artifacts
// ---------------------------------------------------------------------------

export interface EvidenceReference {
  type: "screenshot" | "video" | "log" | "console" | "network_trace" | "report" | "other";
  url: string;
  description?: string;
  capturedAt?: string;
}

// ---------------------------------------------------------------------------
// The canonical contract
// ---------------------------------------------------------------------------

export const VERIFICATION_CONTRACT_VERSION = "1.0.0";

export interface VerificationResult {
  /** The verdict — the ONLY field policy should branch on for evidence quality. */
  verdict: VerificationVerdict;

  /** Whether evidence is sufficient for decision-making. */
  evidenceComplete: boolean;

  /** Lifecycle state coverage (which states were required vs reached). */
  lifecycleCoverage: LifecycleCoverage;

  /** Evidence artifacts produced during verification. */
  artifacts: EvidenceReference[];

  /** Which executor produced this result (audit/replay only — not for branching). */
  executor: VerificationExecutor;

  /** When the verification observation was made. */
  observedAt: string;

  /** Contract version for schema evolution detection. */
  contractVersion: string;

  /** What blocked verification when verdict is INCONCLUSIVE. */
  blockedBy?: VerificationBlocker;

  /** Human-readable limitations of this verification. */
  limitations?: string[];

  /** Confidence in the verdict (0-1). */
  confidence: number;

  /** Summary of what was verified and what was observed. */
  summary: string;

  /** Detailed reasoning for the verdict. */
  reasoning: string;

  /** Scenario fit score (how well did the verification match the reported issue). */
  scenarioFit?: number;

  /** Whether a retry is recommended (transient failure, not a definitive result). */
  retryRecommended: boolean;

  /** The original external ID from the reproduction adapter (for correlation). */
  externalId?: string;

  /** Run IDs for audit trail (planner sessions, etc.). */
  runIds?: string[];
}

// ---------------------------------------------------------------------------
// Safety rules
// ---------------------------------------------------------------------------

/**
 * INVARIANT: These verdicts can NEVER be treated as valid negative evidence.
 * Policy must not auto-close based on them.
 */
export function isValidNegativeEvidence(result: VerificationResult): boolean {
  return result.verdict === "NOT_OBSERVED_COMPLETE_COVERAGE" && result.evidenceComplete;
}

/**
 * INVARIANT: These verdicts can be treated as valid positive evidence.
 */
export function isValidPositiveEvidence(result: VerificationResult): boolean {
  return result.verdict === "OBSERVED";
}

/**
 * INVARIANT: Unsupported and inconclusive results are not evidence of absence.
 * They must never flow into "cannot reproduce" → auto-close.
 */
export function canNeverBecomeNegativeEvidence(result: VerificationResult): boolean {
  return (
    result.verdict === "UNSUPPORTED" ||
    result.verdict === "INCONCLUSIVE" ||
    result.retryRecommended ||
    result.blockedBy === "INFRA_FAILURE" ||
    result.blockedBy === "ENVIRONMENT"
  );
}

/**
 * Whether this result represents a capability gap that should be recorded.
 */
export function isCapabilityGap(result: VerificationResult): boolean {
  return result.verdict === "UNSUPPORTED";
}

// ---------------------------------------------------------------------------
// Builder helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal UNSUPPORTED result (capability gap).
 */
export function unsupportedResult(
  executor: VerificationExecutor,
  reason: string,
  lifecycleCoverage: LifecycleCoverage = { requiredStates: [], reachedStates: [], coverageComplete: false, missingStates: [] },
): VerificationResult {
  return {
    verdict: "UNSUPPORTED",
    evidenceComplete: false,
    lifecycleCoverage,
    artifacts: [],
    executor,
    observedAt: new Date().toISOString(),
    contractVersion: VERIFICATION_CONTRACT_VERSION,
    limitations: [reason],
    confidence: 1.0,
    summary: `Verification unsupported: ${reason}`,
    reasoning: reason,
    retryRecommended: false,
  };
}

/**
 * Create an INCONCLUSIVE result (blocked by something).
 */
export function inconclusiveResult(
  executor: VerificationExecutor,
  blockedBy: VerificationBlocker,
  lifecycleCoverage: LifecycleCoverage,
  summary: string,
  artifacts: EvidenceReference[] = [],
): VerificationResult {
  return {
    verdict: "INCONCLUSIVE",
    evidenceComplete: false,
    lifecycleCoverage,
    artifacts,
    executor,
    observedAt: new Date().toISOString(),
    contractVersion: VERIFICATION_CONTRACT_VERSION,
    blockedBy,
    limitations: [`Blocked by ${blockedBy}: ${summary}`],
    confidence: 0.5,
    summary,
    reasoning: `Verification did not reach the required lifecycle states due to ${blockedBy}.`,
    retryRecommended: blockedBy === "INFRA_FAILURE" || blockedBy === "ENVIRONMENT",
  };
}

/**
 * Create a NOT_OBSERVED_COMPLETE_COVERAGE result (valid negative evidence).
 */
export function notObservedResult(
  executor: VerificationExecutor,
  lifecycleCoverage: LifecycleCoverage,
  summary: string,
  confidence: number,
  artifacts: EvidenceReference[] = [],
  scenarioFit?: number,
): VerificationResult {
  return {
    verdict: "NOT_OBSERVED_COMPLETE_COVERAGE",
    evidenceComplete: true,
    lifecycleCoverage,
    artifacts,
    executor,
    observedAt: new Date().toISOString(),
    contractVersion: VERIFICATION_CONTRACT_VERSION,
    confidence,
    summary,
    reasoning: `Bug was not observed with complete lifecycle coverage (all required states reached).`,
    scenarioFit,
    retryRecommended: false,
  };
}

/**
 * Create an OBSERVED result (valid positive evidence — bug confirmed).
 */
export function observedResult(
  executor: VerificationExecutor,
  lifecycleCoverage: LifecycleCoverage,
  summary: string,
  confidence: number,
  artifacts: EvidenceReference[] = [],
  scenarioFit?: number,
): VerificationResult {
  return {
    verdict: "OBSERVED",
    evidenceComplete: true,
    lifecycleCoverage,
    artifacts,
    executor,
    observedAt: new Date().toISOString(),
    contractVersion: VERIFICATION_CONTRACT_VERSION,
    confidence,
    summary,
    reasoning: `Bug was observed — the reported defect was confirmed.`,
    scenarioFit,
    retryRecommended: false,
  };
}
