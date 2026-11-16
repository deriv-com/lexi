import type { CoverageDimension } from "@lexi/contracts";
import { isDimensionSettled, type SpecCoverageRecord } from "./coverage";
import { COVERAGE_DIMENSIONS } from "./coverage-dimensions";
import { QUESTION_PROMPTS } from "./question-prompts";
import type { SpecPolicy } from "./load-spec-policy";

/**
 * Question batching. Deterministic: same coverage record in, same
 * batch out, with no model call — selecting which questions to ask is
 * bookkeeping over structured state, which is exactly the case code should
 * handle.
 *
 * The rule that most needs to live here rather than in a prompt is **never
 * re-ask a settled dimension**. Asking a model to "remember what you already
 * know" fails the moment a thread gets long enough for the earlier turn to
 * fall out of the window — which is precisely when a user is least willing to
 * answer the same question a third time.
 */

export interface QuestionPolicy {
  mandatoryDimensions: CoverageDimension[];
  minDimensionConfidence: number;
  minQuestionsPerTurn: number;
  maxQuestionsPerTurn: number;
  offerDefaultForEveryQuestion: boolean;
  neverReaskCoveredDimensions: boolean;
}

export interface PendingQuestion {
  dimension: CoverageDimension;
  question: string;
  /** Empty when the policy disables defaults. */
  defaultAnswer: string;
  /** True when a dimension this depends on is still unsettled. */
  gated: boolean;
}

export interface QuestionBatch {
  questions: PendingQuestion[];
  /** Mandatory dimensions still unsettled, including the ones asked here. */
  remaining: number;
  /** Nothing left to ask — the caller should draft rather than prompt. */
  exhausted: boolean;
}

/** Narrows a full policy to the fields batching reads. */
export function questionPolicyFrom(policy: SpecPolicy): QuestionPolicy {
  return {
    mandatoryDimensions: [...policy.coverage.mandatoryDimensions],
    minDimensionConfidence: policy.coverage.minDimensionConfidence,
    minQuestionsPerTurn: policy.questioning.minQuestionsPerTurn,
    maxQuestionsPerTurn: policy.questioning.maxQuestionsPerTurn,
    offerDefaultForEveryQuestion: policy.questioning.offerDefaultForEveryQuestion,
    neverReaskCoveredDimensions: policy.questioning.neverReaskCoveredDimensions,
  };
}

/**
 * The next 2–4 questions, ordered by information value.
 *
 * Gating affects *order*, not eligibility: unblocked dimensions sort ahead of
 * ones whose gate is still open, but a gated dimension is still asked if there
 * is room in the batch. Excluding them outright would shrink a four-question
 * turn to one on a fresh session, and a user who is willing to answer four
 * questions now should not be dripped one per round.
 *
 * `minQuestionsPerTurn` is a floor that only binds when fewer dimensions than
 * that remain — in which case the batch is simply everything left, rather than
 * padded with questions that have already been answered.
 */
export function nextQuestionBatch(
  coverage: SpecCoverageRecord,
  policy: QuestionPolicy,
): QuestionBatch {
  const askable = policy.mandatoryDimensions.filter((dimension) => {
    if (!policy.neverReaskCoveredDimensions) return true;
    return !isDimensionSettled(coverage.dimensions[dimension], policy.minDimensionConfidence);
  });

  if (askable.length === 0) {
    return { questions: [], remaining: 0, exhausted: true };
  }

  const isSettled = (dimension: CoverageDimension) =>
    isDimensionSettled(coverage.dimensions[dimension], policy.minDimensionConfidence);

  const isGated = (dimension: CoverageDimension) =>
    !QUESTION_PROMPTS[dimension].gates.every((gate) => isSettled(gate));

  const selected = [...askable]
    .sort((a, b) => {
      const gateOrder = Number(isGated(a)) - Number(isGated(b));
      if (gateOrder !== 0) return gateOrder;
      return QUESTION_PROMPTS[a].priority - QUESTION_PROMPTS[b].priority;
    })
    .slice(0, policy.maxQuestionsPerTurn);

  const questions: PendingQuestion[] = selected.map((dimension) => ({
    dimension,
    question: QUESTION_PROMPTS[dimension].question,
    defaultAnswer: policy.offerDefaultForEveryQuestion ? QUESTION_PROMPTS[dimension].defaultAnswer : "",
    gated: isGated(dimension),
  }));

  return { questions, remaining: askable.length, exhausted: false };
}

/**
 * Dimensions a turn's answers actually moved, for audit and for telling
 * whether a round made progress or merely burned one of the five.
 */
export function coverageDelta(
  before: SpecCoverageRecord,
  after: SpecCoverageRecord,
): CoverageDimension[] {
  return COVERAGE_DIMENSIONS.filter(
    (dimension) => before.dimensions[dimension]?.state !== after.dimensions[dimension]?.state,
  );
}
