import type { CoverageDimension } from "@lexi/contracts";
import { isDimensionSettled, type SpecCoverageRecord } from "./coverage";
import { QUESTION_PROMPTS } from "./question-prompts";
import type { SpecPolicy } from "./load-spec-policy";

/**
 * The deterministic stop condition.
 *
 * This is the function that decides when Lexi stops interrogating someone, and
 * it is plain code with **zero** LLM calls. Asking a model "have I heard
 * enough?" would be non-deterministic, unreplayable, billable on every turn,
 * and — worst of all — capable of quietly deciding differently on Tuesday. The
 * rule is: if plain code can answer it, no model call at all. It can.
 */

/** The slice of `spec-policy.yaml` the stop condition actually reads. */
export interface ReadinessPolicy {
  mandatoryDimensions: CoverageDimension[];
  maxQuestionTurns: number;
  minDimensionConfidence: number;
  /**
   * Dimensions a user may explicitly defer *without blocking the draft*.
   *
   * When present, a deferral of anything outside this list does not satisfy
   * the dimension. Without the check, "defer it" would be a universal escape
   * hatch: someone could defer `problem` and leave with a spec that states no
   * problem, and `config/spec-policy.yaml` would be describing a restriction
   * it did not actually impose.
   *
   * Omitted entirely means unrestricted, which keeps callers that predate the
   * list working unchanged. An **empty array** is the opposite: an operator who
   * wrote `deferrableDimensions: []` has named zero deferrable dimensions, and
   * reading that as "no restriction" would invert their intent.
   */
  deferrableDimensions?: CoverageDimension[];
}

export interface ReadinessOptions {
  /** The user said "just draft it" — an explicit instruction, honoured. */
  userOverride?: boolean;
}

export type ReadinessReason =
  /** Every mandatory dimension is covered or explicitly deferred. */
  | "coverage_complete"
  /** The question-turn cap was reached; draft with the gaps marked blocking. */
  | "question_turn_cap"
  /** The user asked for a draft regardless of coverage. */
  | "user_override"
  /** Not ready — keep asking. */
  | "coverage_incomplete";

export interface ReadinessResult {
  ready: boolean;
  reason: ReadinessReason;
  /** Mandatory dimensions still unsettled, in policy order. */
  unsatisfied: CoverageDimension[];
  /**
   * The open questions that must travel with the draft, phrased for the spec's
   * "Open questions" section and marked blocking.
   *
   * Empty when coverage is complete. Non-empty means the spec is being drafted
   * over known gaps — which is allowed, but never silently: drafting early
   * must leave a visible trace, or "we ran out of turns" becomes "we agreed".
   */
  blockingOpenQuestions: string[];
}

/** Narrows a full policy to the fields the stop condition reads. */
export function readinessPolicyFrom(policy: SpecPolicy): ReadinessPolicy {
  return {
    mandatoryDimensions: [...policy.coverage.mandatoryDimensions],
    maxQuestionTurns: policy.coverage.maxQuestionTurns,
    minDimensionConfidence: policy.coverage.minDimensionConfidence,
    deferrableDimensions: [...policy.coverage.deferrableDimensions],
  };
}

export function isReadyToDraft(
  coverage: SpecCoverageRecord,
  policy: ReadinessPolicy,
  options: ReadinessOptions = {},
): ReadinessResult {
  const unsatisfied = policy.mandatoryDimensions.filter((dimension) => {
    const entry = coverage.dimensions[dimension];

    // A deferral only satisfies a dimension the policy allows to be deferred.
    if (entry?.state === "EXPLICITLY_DEFERRED" && !isDeferrable(dimension, policy)) {
      return true;
    }

    return !isDimensionSettled(entry, policy.minDimensionConfidence);
  });

  // Coverage first, so a session that genuinely finished is never mislabelled
  // as having merely run out of turns — the reason is what the announcement
  // and the audit trail report, and "we asked everything" is a materially
  // different claim from "we gave up".
  if (unsatisfied.length === 0) {
    return { ready: true, reason: "coverage_complete", unsatisfied: [], blockingOpenQuestions: [] };
  }

  const blockingOpenQuestions = unsatisfied.map(openQuestionFor);

  if (options.userOverride === true) {
    return { ready: true, reason: "user_override", unsatisfied, blockingOpenQuestions };
  }

  if (coverage.questionTurns >= policy.maxQuestionTurns) {
    return { ready: true, reason: "question_turn_cap", unsatisfied, blockingOpenQuestions };
  }

  return { ready: false, reason: "coverage_incomplete", unsatisfied, blockingOpenQuestions };
}

/**
 * Renders one unsettled dimension as a blocking open question. Uses the same
 * prompt text the clarification loop would have asked, so the spec's open
 * questions read as the questions nobody answered rather than as a list of
 * internal dimension keys.
 */
function openQuestionFor(dimension: CoverageDimension): string {
  return `${dimension}: ${QUESTION_PROMPTS[dimension].question}`;
}

/** No whitelist configured means deferral is unrestricted. */
function isDeferrable(dimension: CoverageDimension, policy: ReadinessPolicy): boolean {
  if (!policy.deferrableDimensions) return true;
  return policy.deferrableDimensions.includes(dimension);
}
