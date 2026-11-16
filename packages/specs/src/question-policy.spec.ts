import { describe, it, expect } from "vitest";
import { COVERAGE_DIMENSIONS } from "./coverage-dimensions";
import { createCoverageRecord, deferDimension, recordCoverage, type SpecCoverageRecord } from "./coverage";
import { QUESTION_PROMPTS } from "./question-prompts";
import { nextQuestionBatch, type QuestionPolicy } from "./question-policy";

/**
 * Question batching: 2–4 per turn, ordered by information value with
 * gating dimensions first, a default offered for every question, and a covered
 * or deferred dimension NEVER re-asked — enforced here in code rather than
 * left to the model to remember.
 */

const POLICY: QuestionPolicy = {
  mandatoryDimensions: [...COVERAGE_DIMENSIONS],
  minDimensionConfidence: 0.7,
  minQuestionsPerTurn: 2,
  maxQuestionsPerTurn: 4,
  offerDefaultForEveryQuestion: true,
  neverReaskCoveredDimensions: true,
};

function cover(record: SpecCoverageRecord, ...dimensions: (typeof COVERAGE_DIMENSIONS)[number][]) {
  return dimensions.reduce(
    (acc, dimension) => recordCoverage(acc, dimension, { state: "COVERED", confidence: 1 }),
    record,
  );
}

describe("question prompts", () => {
  it("has a prompt and a default for all nine dimensions", () => {
    for (const dimension of COVERAGE_DIMENSIONS) {
      const prompt = QUESTION_PROMPTS[dimension];
      expect(prompt.question.length).toBeGreaterThan(0);
      // "Every question ships a default" — silence still moves the spec
      // forward instead of stalling on a non-reply.
      expect(prompt.defaultAnswer.length).toBeGreaterThan(0);
    }
  });

  it("defaults platforms to mobile-first, per the standing design rule", () => {
    expect(QUESTION_PROMPTS.platforms.defaultAnswer.toLowerCase()).toContain("mobile");
  });
});

describe("batch size", () => {
  it("asks no more than maxQuestionsPerTurn", () => {
    const batch = nextQuestionBatch(createCoverageRecord(), POLICY);
    expect(batch.questions).toHaveLength(4);
  });

  it("asks at least minQuestionsPerTurn while enough dimensions are open", () => {
    // The three non-mandatory dimensions are settled alongside the mandatory
    // ones so this test still isolates what it is about — the minimum batch
    // size — rather than incidentally asserting where they sort in the queue.
    const record = cover(createCoverageRecord(), "problem", "users", "scope", "non_goals", "acceptance_criteria", "platforms", "dependencies", "journey_states", "api_contract", "performance_plan");
    const batch = nextQuestionBatch(record, POLICY);

    expect(batch.questions.length).toBeGreaterThanOrEqual(2);
    expect(batch.questions.map((q) => q.dimension)).toEqual(["risks", "rollout"]);
  });

  it("asks the single remaining question rather than padding to the minimum", () => {
    let record = createCoverageRecord();
    for (const dimension of COVERAGE_DIMENSIONS) {
      if (dimension === "rollout") continue;
      record = recordCoverage(record, dimension, { state: "COVERED", confidence: 1 });
    }

    const batch = nextQuestionBatch(record, POLICY);

    expect(batch.questions).toHaveLength(1);
    expect(batch.questions[0].dimension).toBe("rollout");
  });

  it("returns an empty batch when everything is settled", () => {
    let record = createCoverageRecord();
    for (const dimension of COVERAGE_DIMENSIONS) {
      record = recordCoverage(record, dimension, { state: "COVERED", confidence: 1 });
    }

    const batch = nextQuestionBatch(record, POLICY);

    expect(batch.questions).toEqual([]);
    expect(batch.exhausted).toBe(true);
  });
});

describe("never re-asking", () => {
  it("never asks a COVERED dimension", () => {
    const record = cover(createCoverageRecord(), "problem", "scope");
    const batch = nextQuestionBatch(record, POLICY);

    expect(batch.questions.map((q) => q.dimension)).not.toContain("problem");
    expect(batch.questions.map((q) => q.dimension)).not.toContain("scope");
  });

  it("never asks an EXPLICITLY_DEFERRED dimension", () => {
    const record = deferDimension(createCoverageRecord(), "risks", "accepted for v1");

    // Force risks to the front of the queue by settling everything before it.
    const settled = cover(record, "problem", "users", "scope", "non_goals", "acceptance_criteria", "platforms", "dependencies", "journey_states", "api_contract", "performance_plan");
    const batch = nextQuestionBatch(settled, POLICY);

    expect(batch.questions.map((q) => q.dimension)).toEqual(["rollout"]);
  });

  it("does re-ask a PARTIAL dimension — half an answer is not an answer", () => {
    let record = createCoverageRecord();
    record = recordCoverage(record, "problem", { state: "PARTIAL", confidence: 0.5 });

    const batch = nextQuestionBatch(record, POLICY);

    expect(batch.questions.map((q) => q.dimension)).toContain("problem");
  });

  it("re-asks a COVERED dimension whose confidence sits below the floor", () => {
    let record = createCoverageRecord();
    record = recordCoverage(record, "problem", { state: "COVERED", confidence: 0.3 });

    const batch = nextQuestionBatch(record, POLICY);

    expect(batch.questions.map((q) => q.dimension)).toContain("problem");
  });
});

describe("ordering by information value", () => {
  it("leads with problem and scope — the dimensions that gate the rest", () => {
    const batch = nextQuestionBatch(createCoverageRecord(), POLICY);
    const asked = batch.questions.map((q) => q.dimension);

    expect(asked[0]).toBe("problem");
    expect(asked).toContain("scope");
  });

  it("asks platforms before the dimensions platforms gates", () => {
    const batch = nextQuestionBatch(createCoverageRecord(), POLICY);
    const asked = batch.questions.map((q) => q.dimension);

    // rollout/dependencies/risks all depend on knowing the target platform, so
    // asking them first spends a turn on an answer that platform choice may
    // invalidate.
    for (const gated of ["dependencies", "risks", "rollout"] as const) {
      if (asked.includes(gated)) {
        expect(asked.indexOf("platforms")).toBeLessThan(asked.indexOf(gated));
      }
    }
  });

  it("prefers ungated dimensions over ones whose gate is still open", () => {
    // With everything open, a gated dimension must not displace an ungated one.
    const batch = nextQuestionBatch(createCoverageRecord(), POLICY);
    expect(batch.questions.map((q) => q.dimension)).toEqual([
      "problem",
      "scope",
      "platforms",
      "users",
    ]);
  });

  it("promotes a gated dimension once its gate is settled", () => {
    const record = cover(createCoverageRecord(), "problem", "scope", "platforms", "users");
    const batch = nextQuestionBatch(record, POLICY);

    expect(batch.questions.map((q) => q.dimension)).toEqual([
      "acceptance_criteria",
      "non_goals",
      "dependencies",
      "risks",
    ]);
  });
});

describe("batch contents", () => {
  it("ships a default with every question", () => {
    const batch = nextQuestionBatch(createCoverageRecord(), POLICY);

    for (const question of batch.questions) {
      expect(question.defaultAnswer.length).toBeGreaterThan(0);
    }
  });

  it("omits defaults when the policy turns them off", () => {
    const batch = nextQuestionBatch(createCoverageRecord(), {
      ...POLICY,
      offerDefaultForEveryQuestion: false,
    });

    for (const question of batch.questions) {
      expect(question.defaultAnswer).toBe("");
    }
  });

  it("reports the remaining count so the caller can say how much is left", () => {
    const batch = nextQuestionBatch(createCoverageRecord(), POLICY);

    expect(batch.remaining).toBe(COVERAGE_DIMENSIONS.length);
    expect(batch.exhausted).toBe(false);
  });

  it("is deterministic for the same record", () => {
    const record = cover(createCoverageRecord(), "problem");
    expect(nextQuestionBatch(record, POLICY)).toEqual(nextQuestionBatch(record, POLICY));
  });
});

describe("policy honours the never-re-ask switch", () => {
  it("re-asks covered dimensions when the switch is off", () => {
    // The switch exists in config; if flipping it changed nothing the config
    // would be lying about what it controls.
    const record = cover(createCoverageRecord(), "problem");
    const batch = nextQuestionBatch(record, { ...POLICY, neverReaskCoveredDimensions: false });

    expect(batch.questions.map((q) => q.dimension)).toContain("problem");
  });
});
