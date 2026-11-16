import { describe, it, expect } from "vitest";
import { COVERAGE_DIMENSIONS } from "./coverage-dimensions";
import { createCoverageRecord, deferDimension, recordCoverage, type SpecCoverageRecord } from "./coverage";
import { isReadyToDraft, type ReadinessPolicy } from "./readiness";

/**
 * The stop condition is PURE CODE with zero LLM calls: "can plain code
 * answer this?" — it can, so no model is asked whether it has heard enough.
 *
 * Ready when either
 *   (a) every mandatory dimension is COVERED at or above minDimensionConfidence,
 *       or EXPLICITLY_DEFERRED by the user; or
 *   (b) maxQuestionTurns is reached — draft anyway, with the unmet dimensions
 *       marked as blocking open questions; or
 *   (c) the user said "just draft it".
 */

const POLICY: ReadinessPolicy = {
  mandatoryDimensions: [...COVERAGE_DIMENSIONS],
  maxQuestionTurns: 5,
  minDimensionConfidence: 0.7,
};

function coverAll(confidence = 1): SpecCoverageRecord {
  let record = createCoverageRecord();
  for (const dimension of COVERAGE_DIMENSIONS) {
    record = recordCoverage(record, dimension, { state: "COVERED", confidence });
  }
  return record;
}

describe("isReadyToDraft — not ready", () => {
  it("is not ready on a fresh session", () => {
    const result = isReadyToDraft(createCoverageRecord(), POLICY);

    expect(result.ready).toBe(false);
    expect(result.reason).toBe("coverage_incomplete");
    expect(result.unsatisfied).toEqual([...COVERAGE_DIMENSIONS]);
  });

  it("is not ready while one mandatory dimension is still open", () => {
    let record = coverAll();
    record = recordCoverage(record, "rollout", { state: "UNKNOWN" });

    const result = isReadyToDraft(record, POLICY);

    expect(result.ready).toBe(false);
    expect(result.unsatisfied).toEqual(["rollout"]);
  });

  it("is not ready when a dimension is only PARTIAL, however confident", () => {
    let record = coverAll();
    record = recordCoverage(record, "scope", { state: "PARTIAL", confidence: 0.99 });

    const result = isReadyToDraft(record, POLICY);

    expect(result.ready).toBe(false);
    expect(result.unsatisfied).toEqual(["scope"]);
  });

  it("is not ready when a dimension is COVERED below the confidence floor", () => {
    let record = coverAll();
    record = recordCoverage(record, "platforms", { state: "COVERED", confidence: 0.5 });

    const result = isReadyToDraft(record, POLICY);

    expect(result.ready).toBe(false);
    expect(result.unsatisfied).toEqual(["platforms"]);
  });
});

describe("isReadyToDraft — coverage complete", () => {
  it("is ready when every mandatory dimension is covered at the floor", () => {
    const result = isReadyToDraft(coverAll(0.7), POLICY);

    expect(result.ready).toBe(true);
    expect(result.reason).toBe("coverage_complete");
    expect(result.unsatisfied).toEqual([]);
    expect(result.blockingOpenQuestions).toEqual([]);
  });

  it("counts an explicit deferral as satisfying a mandatory dimension", () => {
    let record = coverAll();
    record = deferDimension(record, "dependencies", "no upstream work for v1");
    record = deferDimension(record, "risks", "accepted, revisit post-launch");

    const result = isReadyToDraft(record, POLICY);

    expect(result.ready).toBe(true);
    expect(result.reason).toBe("coverage_complete");
  });

  it("ignores dimensions the policy does not make mandatory", () => {
    // A shorter mandatory list must genuinely shorten the loop — otherwise the
    // policy file is decorative.
    const narrow: ReadinessPolicy = { ...POLICY, mandatoryDimensions: ["problem", "scope"] };
    let record = createCoverageRecord();
    record = recordCoverage(record, "problem", { state: "COVERED", confidence: 1 });
    record = recordCoverage(record, "scope", { state: "COVERED", confidence: 1 });

    const result = isReadyToDraft(record, narrow);

    expect(result.ready).toBe(true);
    expect(result.reason).toBe("coverage_complete");
  });
});

describe("isReadyToDraft — deferrable whitelist", () => {
  // config/spec-policy.yaml lists `deferrableDimensions` as the dimensions a
  // user may defer "without blocking the draft". Ignoring that whitelist would
  // let someone defer `problem` and walk away with an empty spec, and would
  // make the config lie about what it controls.
  const WHITELISTED: ReadinessPolicy = { ...POLICY, deferrableDimensions: ["dependencies", "risks"] };

  it("accepts a deferral of a whitelisted dimension", () => {
    let record = coverAll();
    record = deferDimension(record, "risks", "accepted for v1");

    expect(isReadyToDraft(record, WHITELISTED).ready).toBe(true);
  });

  it("refuses to let a non-deferrable dimension be deferred away", () => {
    let record = coverAll();
    record = deferDimension(record, "problem", "cannot be bothered");

    const result = isReadyToDraft(record, WHITELISTED);

    expect(result.ready).toBe(false);
    expect(result.unsatisfied).toEqual(["problem"]);
  });

  it("allows any deferral when the policy names no whitelist", () => {
    // Back-compat: a policy without the list keeps the permissive behaviour.
    let record = coverAll();
    record = deferDimension(record, "problem", "out of scope");

    expect(isReadyToDraft(record, POLICY).ready).toBe(true);
  });

  it("treats an EMPTY whitelist as nothing deferrable, not everything", () => {
    // An absent list and an empty list are different statements. A config that
    // says `deferrableDimensions: []` has named zero deferrable dimensions, and
    // reading that as "no restriction" would invert the operator's intent —
    // the same fail-closed reading the rest of this build's policy files take.
    let record = coverAll();
    record = deferDimension(record, "risks", "accepted for v1");

    const result = isReadyToDraft(record, { ...POLICY, deferrableDimensions: [] });

    expect(result.ready).toBe(false);
    expect(result.unsatisfied).toEqual(["risks"]);
  });
});

describe("isReadyToDraft — question turn cap", () => {
  it("drafts anyway once the cap is reached, flagging what is still missing", () => {
    const record: SpecCoverageRecord = { ...createCoverageRecord(), questionTurns: 5 };

    const result = isReadyToDraft(record, POLICY);

    expect(result.ready).toBe(true);
    expect(result.reason).toBe("question_turn_cap");
    // Drafting is not the same as knowing: the gaps travel with the spec as
    // blocking open questions rather than vanishing.
    expect(result.unsatisfied).toEqual([...COVERAGE_DIMENSIONS]);
    expect(result.blockingOpenQuestions.length).toBe(COVERAGE_DIMENSIONS.length);
    expect(result.blockingOpenQuestions[0]).toContain("problem");
  });

  it("treats exceeding the cap the same as reaching it", () => {
    const record: SpecCoverageRecord = { ...createCoverageRecord(), questionTurns: 9 };
    expect(isReadyToDraft(record, POLICY).reason).toBe("question_turn_cap");
  });

  it("is not ready one turn below the cap", () => {
    const record: SpecCoverageRecord = { ...createCoverageRecord(), questionTurns: 4 };

    const result = isReadyToDraft(record, POLICY);

    expect(result.ready).toBe(false);
    expect(result.reason).toBe("coverage_incomplete");
  });

  it("prefers coverage_complete over the cap when both hold", () => {
    const record: SpecCoverageRecord = { ...coverAll(), questionTurns: 5 };

    const result = isReadyToDraft(record, POLICY);

    expect(result.ready).toBe(true);
    expect(result.reason).toBe("coverage_complete");
    expect(result.blockingOpenQuestions).toEqual([]);
  });
});

describe("isReadyToDraft — user override", () => {
  it("drafts on demand when the user says just draft it", () => {
    const result = isReadyToDraft(createCoverageRecord(), POLICY, { userOverride: true });

    expect(result.ready).toBe(true);
    expect(result.reason).toBe("user_override");
    expect(result.blockingOpenQuestions.length).toBe(COVERAGE_DIMENSIONS.length);
  });

  it("still reports coverage_complete when the override was unnecessary", () => {
    const result = isReadyToDraft(coverAll(), POLICY, { userOverride: true });

    expect(result.reason).toBe("coverage_complete");
    expect(result.blockingOpenQuestions).toEqual([]);
  });

  it("does not let an override erase what is still unknown", () => {
    const result = isReadyToDraft(createCoverageRecord(), POLICY, { userOverride: true });
    expect(result.unsatisfied).toEqual([...COVERAGE_DIMENSIONS]);
  });
});

describe("isReadyToDraft — determinism", () => {
  it("returns the identical verdict for the identical record", () => {
    const record = coverAll(0.8);
    expect(isReadyToDraft(record, POLICY)).toEqual(isReadyToDraft(record, POLICY));
  });

  it("does not mutate the record it evaluates", () => {
    const record = createCoverageRecord();
    const snapshot = JSON.stringify(record);
    isReadyToDraft(record, POLICY, { userOverride: true });
    expect(JSON.stringify(record)).toBe(snapshot);
  });
});
