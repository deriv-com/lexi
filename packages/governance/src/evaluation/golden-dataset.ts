/**
 * Golden Dataset Schema and Runner
 *
 * A golden case is a frozen, human-labelled expected outcome for a real issue.
 * Lexi is executed against these cases and scored by disagreement category.
 *
 * Key rules:
 * - Lexi does NOT generate its own expected labels
 * - Humans (Engineering/QA/Security) establish ground truth independently
 * - Labels are immutable once approved
 * - Each case has reviewer identity and rationale
 * - Disagreements are decomposed by failure category
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Golden case schema
// ---------------------------------------------------------------------------

export type IntakeDisposition =
  | "ACCEPT_NEW"
  | "MATCH_EXISTING"
  | "POSSIBLE_DUPLICATE"
  | "REGRESSION"
  | "SECURITY_BYPASS"
  | "REJECT_NON_BUG"
  | "NEEDS_HUMAN_REVIEW";

export type ExpectedClassification =
  | "VERIFIED"
  | "LIKELY_FIXED"
  | "CANNOT_REPRODUCE"
  | "DUPLICATE"
  | "NEEDS_MORE_INFO"
  | "NEEDS_MANUAL_INVESTIGATION"
  | "NOT_OBSERVED_WITH_COMPLETE_COVERAGE"
  | "BLOCKED_BY_OTP"
  | "BLOCKED_BY_KYC"
  | "BLOCKED_BY_PAYMENT"
  | "BLOCKED_BY_CREDENTIALS"
  | "BLOCKED_BY_ENVIRONMENT";

export type ExpectedPolicyAction =
  | "auto_close"
  | "pending_closure"
  | "assign_and_notify"
  | "escalate_manual"
  | "request_more_info"
  | "retest_after_release"
  | "no_action";

export interface GoldenCase {
  /** Immutable identifier. */
  goldenId: string;
  /** GitHub issue reference (frozen at specific revision). */
  issue: {
    number: number;
    repository: string;
    /** SHA or timestamp identifying the exact revision of the issue at labelling time. */
    revision: string;
    title: string;
    body: string;
    labels: string[];
    state: string;
    authorLogin: string;
  };
  /** Expected outcomes (human-established ground truth). */
  expected: {
    intakeDisposition?: IntakeDisposition;
    duplicateOutcome?: { isDuplicate: boolean; canonicalNumber?: number };
    evidenceAssessment?: { evidenceStrength: number; reporterTrust: number };
    engineeringState?: { hasLinkedPR: boolean; fixMerged: boolean; fixDeployed: boolean };
    reproductionRequired?: boolean;
    verificationVerdict?: "OBSERVED" | "NOT_OBSERVED_COMPLETE_COVERAGE" | "INCONCLUSIVE" | "UNSUPPORTED";
    classification: ExpectedClassification;
    ownership?: { team: string; owner?: string };
    priority?: string;
    severity?: string;
    policyAction: ExpectedPolicyAction;
    expectedFinalState?: string;
    rollbackExpected?: boolean;
  };
  /** Why this case is labelled this way (reviewer rationale). */
  rationale: string;
  /** What makes this case a useful test (difficult-negative explanation). */
  difficultNegativeRationale?: string;
  /** Reviewer approvals. */
  approvals: Array<{
    reviewer: string;
    role: "engineering" | "qa" | "security";
    approvedAt: string;
  }>;
  /** When this case was frozen. */
  frozenAt: string;
  /** Dataset version. */
  datasetVersion: string;
}

// ---------------------------------------------------------------------------
// Disagreement categories
// ---------------------------------------------------------------------------

export type DisagreementCategory =
  | "false_rejection"          // Lexi rejected a valid issue
  | "false_duplicate"          // Lexi called it a duplicate when it isn't
  | "missed_duplicate"         // Lexi missed a real duplicate
  | "false_closure"            // Lexi allowed closure when it shouldn't
  | "missed_closure"           // Lexi blocked closure when it should have closed
  | "ownership_error"          // Wrong team/owner assignment
  | "priority_error"           // Wrong priority/severity
  | "unnecessary_reproduction" // Reproduction ran but wasn't needed
  | "missed_existing_fix"      // Lexi missed an already-merged fix
  | "policy_mismatch"          // Policy produced different action than expected
  | "classification_error"     // Wrong classification
  | "environmental_failure"    // Infra/env failure caused wrong outcome
  | "correct";                 // Lexi agreed with human ground truth

export interface CaseResult {
  goldenId: string;
  /** What Lexi actually produced. */
  actual: {
    intakeDisposition?: string;
    duplicateOutcome?: { isDuplicate: boolean; canonicalNumber?: number };
    classification?: string;
    ownership?: { team: string; owner?: string };
    priority?: string;
    policyAction?: string;
    finalState?: string;
    confidence?: number;
  };
  /** Whether Lexi agreed with ground truth. */
  agreed: boolean;
  /** If disagreed, which category. */
  disagreementCategory?: DisagreementCategory;
  /** Explanation of the disagreement. */
  disagreementDetail?: string;
  /** Execution metadata. */
  executedAt: string;
  durationMs: number;
  /** Lexi's reasoning for its decision. */
  lexiReasoning?: string;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface DatasetScore {
  datasetVersion: string;
  totalCases: number;
  agreed: number;
  disagreed: number;
  agreementRate: number;
  /** Breakdown by disagreement category. */
  byCategory: Record<DisagreementCategory, number>;
  /** Most concerning disagreements (highest risk). */
  criticalDisagreements: CaseResult[];
  /** Pass/fail based on thresholds. */
  passed: boolean;
  passThresholds: {
    minAgreementRate: number;
    maxFalseClosures: number;
    maxFalseRejections: number;
    maxFalseDuplicates: number;
  };
  failReasons: string[];
  executedAt: string;
}

const DEFAULT_PASS_THRESHOLDS = {
  minAgreementRate: 0.9,
  maxFalseClosures: 0,
  maxFalseRejections: 2,
  maxFalseDuplicates: 1,
};

/**
 * Score a set of case results against thresholds.
 */
export function scoreDataset(
  results: CaseResult[],
  datasetVersion: string,
  thresholds = DEFAULT_PASS_THRESHOLDS,
): DatasetScore {
  const agreed = results.filter((r) => r.agreed).length;
  const disagreed = results.length - agreed;
  const agreementRate = results.length > 0 ? agreed / results.length : 0;

  const byCategory: Record<DisagreementCategory, number> = {
    false_rejection: 0,
    false_duplicate: 0,
    missed_duplicate: 0,
    false_closure: 0,
    missed_closure: 0,
    ownership_error: 0,
    priority_error: 0,
    unnecessary_reproduction: 0,
    missed_existing_fix: 0,
    policy_mismatch: 0,
    classification_error: 0,
    environmental_failure: 0,
    correct: agreed,
  };

  for (const r of results) {
    if (r.disagreementCategory && r.disagreementCategory !== "correct") {
      byCategory[r.disagreementCategory]++;
    }
  }

  const failReasons: string[] = [];
  if (agreementRate < thresholds.minAgreementRate) {
    failReasons.push(`Agreement rate ${(agreementRate * 100).toFixed(1)}% below threshold ${(thresholds.minAgreementRate * 100).toFixed(1)}%`);
  }
  if (byCategory.false_closure > thresholds.maxFalseClosures) {
    failReasons.push(`${byCategory.false_closure} false closure(s) exceed max ${thresholds.maxFalseClosures}`);
  }
  if (byCategory.false_rejection > thresholds.maxFalseRejections) {
    failReasons.push(`${byCategory.false_rejection} false rejection(s) exceed max ${thresholds.maxFalseRejections}`);
  }
  if (byCategory.false_duplicate > thresholds.maxFalseDuplicates) {
    failReasons.push(`${byCategory.false_duplicate} false duplicate(s) exceed max ${thresholds.maxFalseDuplicates}`);
  }

  // Critical: false closures and environmental failures that look like closures
  const criticalDisagreements = results.filter(
    (r) => r.disagreementCategory === "false_closure" || r.disagreementCategory === "false_rejection",
  );

  return {
    datasetVersion,
    totalCases: results.length,
    agreed,
    disagreed,
    agreementRate,
    byCategory,
    criticalDisagreements,
    passed: failReasons.length === 0,
    passThresholds: thresholds,
    failReasons,
    executedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type CaseExecutor = (goldenCase: GoldenCase) => Promise<CaseResult["actual"]>;

/**
 * Run Lexi against a golden dataset and produce scored results.
 */
export async function runGoldenDataset(
  cases: GoldenCase[],
  executor: CaseExecutor,
  datasetVersion: string,
): Promise<{ results: CaseResult[]; score: DatasetScore }> {
  const results: CaseResult[] = [];

  for (const goldenCase of cases) {
    const start = Date.now();
    try {
      const actual = await executor(goldenCase);
      const agreed = compareOutcome(goldenCase.expected, actual);
      const category = agreed ? "correct" : classifyDisagreement(goldenCase.expected, actual);

      results.push({
        goldenId: goldenCase.goldenId,
        actual,
        agreed,
        disagreementCategory: category,
        disagreementDetail: agreed ? undefined : describeDisagreement(goldenCase.expected, actual, category),
        executedAt: new Date().toISOString(),
        durationMs: Date.now() - start,
      });
    } catch (err) {
      results.push({
        goldenId: goldenCase.goldenId,
        actual: {},
        agreed: false,
        disagreementCategory: "environmental_failure",
        disagreementDetail: `Execution failed: ${err instanceof Error ? err.message : "unknown"}`,
        executedAt: new Date().toISOString(),
        durationMs: Date.now() - start,
      });
    }
  }

  const score = scoreDataset(results, datasetVersion);
  return { results, score };
}

// ---------------------------------------------------------------------------
// Comparison logic
// ---------------------------------------------------------------------------

function compareOutcome(expected: GoldenCase["expected"], actual: CaseResult["actual"]): boolean {
  // Classification must match
  if (actual.classification && actual.classification !== expected.classification) return false;

  // Policy action must match
  if (actual.policyAction && actual.policyAction !== expected.policyAction) return false;

  // Duplicate outcome must match
  if (expected.duplicateOutcome && actual.duplicateOutcome) {
    if (expected.duplicateOutcome.isDuplicate !== actual.duplicateOutcome.isDuplicate) return false;
  }

  // Ownership team must match (if specified)
  if (expected.ownership?.team && actual.ownership?.team) {
    if (expected.ownership.team.toLowerCase() !== actual.ownership.team.toLowerCase()) return false;
  }

  return true;
}

function classifyDisagreement(expected: GoldenCase["expected"], actual: CaseResult["actual"]): DisagreementCategory {
  // False closure: Lexi says close, human says don't
  if (actual.policyAction === "auto_close" && expected.policyAction !== "auto_close" && expected.policyAction !== "pending_closure") {
    return "false_closure";
  }

  // Missed closure: Lexi says don't close, human says should close
  if (expected.policyAction === "auto_close" && actual.policyAction !== "auto_close" && actual.policyAction !== "pending_closure") {
    return "missed_closure";
  }

  // False duplicate
  if (actual.duplicateOutcome?.isDuplicate && !expected.duplicateOutcome?.isDuplicate) {
    return "false_duplicate";
  }

  // Missed duplicate
  if (expected.duplicateOutcome?.isDuplicate && !actual.duplicateOutcome?.isDuplicate) {
    return "missed_duplicate";
  }

  // Ownership error
  if (expected.ownership?.team && actual.ownership?.team && expected.ownership.team.toLowerCase() !== actual.ownership.team.toLowerCase()) {
    return "ownership_error";
  }

  // Priority error
  if (expected.priority && actual.priority && expected.priority !== actual.priority) {
    return "priority_error";
  }

  // Classification error (catch-all for wrong classification)
  if (actual.classification && actual.classification !== expected.classification) {
    return "classification_error";
  }

  // Policy mismatch (catch-all)
  if (actual.policyAction && actual.policyAction !== expected.policyAction) {
    return "policy_mismatch";
  }

  return "policy_mismatch";
}

function describeDisagreement(
  expected: GoldenCase["expected"],
  actual: CaseResult["actual"],
  category: DisagreementCategory,
): string {
  switch (category) {
    case "false_closure":
      return `Lexi recommended closure (${actual.policyAction}) but expected: ${expected.policyAction}. Classification: ${actual.classification} vs expected ${expected.classification}.`;
    case "false_duplicate":
      return `Lexi marked as duplicate of #${actual.duplicateOutcome?.canonicalNumber} but ground truth says not a duplicate.`;
    case "ownership_error":
      return `Lexi assigned to ${actual.ownership?.team} but expected ${expected.ownership?.team}.`;
    default:
      return `Category: ${category}. Actual: ${JSON.stringify(actual).slice(0, 200)}. Expected: classification=${expected.classification}, action=${expected.policyAction}.`;
  }
}
