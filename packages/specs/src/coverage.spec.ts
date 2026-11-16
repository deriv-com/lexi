import { describe, it, expect } from "vitest";
import type { CoverageDimension, CoverageRecord } from "@lexi/contracts";
import { COVERAGE_DIMENSIONS } from "./coverage-dimensions";
import {
  coverageStatusFor,
  createCoverageRecord,
  deferDimension,
  isDimensionSettled,
  normalizeCoverageRecord,
  openDimensions,
  recordCoverage,
  settledDimensions,
} from "./coverage";

/**
 * Coverage is held as *machine-readable state*, not prose, precisely so the
 * stop condition and the never-re-ask rule are decided by code rather than by
 * the model re-reading a transcript and forming an opinion.
 */

describe("coverage dimensions", () => {
  /**
   * The nine mandatory dimensions lead, in policy order. Asserted as a prefix
   * rather than as the whole array: `SpecSession.coverage` is persisted against
   * these keys, so what must never change is that they are all still here under
   * these names. Later, non-mandatory dimensions append after them and are
   * covered by their own test — pinning the entire array would make every
   * addition look like a breakage of the nine.
   */
  it("keeps the nine frozen dimensions, in policy order, at the head", () => {
    expect(COVERAGE_DIMENSIONS.slice(0, 9)).toEqual([
      "problem",
      "users",
      "scope",
      "non_goals",
      "acceptance_criteria",
      "platforms",
      "dependencies",
      "risks",
      "rollout",
    ]);
  });

  it("appends the three later dimensions that back the previously dead sections", () => {
    expect(COVERAGE_DIMENSIONS.slice(9)).toEqual([
      "journey_states",
      "api_contract",
      "performance_plan",
    ]);
  });

  it("is a closed set — no duplicates, every member a frozen CoverageDimension", () => {
    const dimensions: CoverageDimension[] = [...COVERAGE_DIMENSIONS];
    expect(new Set(dimensions).size).toBe(COVERAGE_DIMENSIONS.length);
  });
});

describe("coverage record construction", () => {
  it("starts every dimension UNKNOWN at zero confidence", () => {
    const record = createCoverageRecord();

    expect(Object.keys(record.dimensions)).toHaveLength(COVERAGE_DIMENSIONS.length);
    for (const dimension of COVERAGE_DIMENSIONS) {
      const entry = record.dimensions[dimension];
      expect(entry?.state).toBe("UNKNOWN");
      expect(entry?.confidence).toBe(0);
      expect(entry?.status).toBe("open");
    }
    expect(record.questionTurns).toBe(0);
    expect(record.readyToDraft).toBe(false);
  });

  it("is assignable to the frozen CoverageRecord contract", () => {
    // The compile-time assignment is the real assertion — SpecSession.coverage
    // persists against the shared shape, so a spec-pipeline record that could not
    // widen to it would orphan stored sessions.
    const frozen: CoverageRecord = createCoverageRecord();
    expect(frozen.dimensions.problem?.status).toBe("open");
  });
});

describe("recording coverage", () => {
  it("derives the frozen status from the richer state", () => {
    expect(coverageStatusFor("UNKNOWN")).toBe("open");
    expect(coverageStatusFor("PARTIAL")).toBe("open");
    expect(coverageStatusFor("COVERED")).toBe("covered");
    expect(coverageStatusFor("EXPLICITLY_DEFERRED")).toBe("deferred");
  });

  it("stores state, confidence, evidence and notes together", () => {
    const record = recordCoverage(createCoverageRecord(), "problem", {
      state: "COVERED",
      confidence: 0.9,
      evidence: "thread",
      sourceTurnId: "C1:1.1:3",
      notes: "Deposit CTA is dead on mobile web.",
    });

    const entry = record.dimensions.problem;
    expect(entry?.state).toBe("COVERED");
    expect(entry?.confidence).toBe(0.9);
    expect(entry?.evidence).toBe("thread");
    expect(entry?.sourceTurnId).toBe("C1:1.1:3");
    expect(entry?.notes).toBe("Deposit CTA is dead on mobile web.");
    expect(entry?.status).toBe("covered");
  });

  it("does not mutate the record it was given", () => {
    const before = createCoverageRecord();
    const after = recordCoverage(before, "scope", { state: "COVERED", confidence: 1 });

    expect(before.dimensions.scope?.state).toBe("UNKNOWN");
    expect(after.dimensions.scope?.state).toBe("COVERED");
    expect(after).not.toBe(before);
  });

  it("clamps confidence into 0..1 rather than trusting a caller", () => {
    const high = recordCoverage(createCoverageRecord(), "users", { state: "COVERED", confidence: 4 });
    const low = recordCoverage(createCoverageRecord(), "users", { state: "PARTIAL", confidence: -2 });

    expect(high.dimensions.users?.confidence).toBe(1);
    expect(low.dimensions.users?.confidence).toBe(0);
  });

  it("defaults confidence to 1 for a dimension covered by a direct answer", () => {
    const record = recordCoverage(createCoverageRecord(), "rollout", { state: "COVERED" });
    expect(record.dimensions.rollout?.confidence).toBe(1);
  });

  it("forces confidence to 0 for UNKNOWN — an unknown cannot be confident", () => {
    const record = recordCoverage(createCoverageRecord(), "risks", {
      state: "UNKNOWN",
      confidence: 0.9,
    });
    expect(record.dimensions.risks?.confidence).toBe(0);
  });
});

describe("explicit deferral", () => {
  it("records a reason and satisfies the dimension", () => {
    const record = deferDimension(createCoverageRecord(), "dependencies", "no upstream work for v1");

    const entry = record.dimensions.dependencies;
    expect(entry?.state).toBe("EXPLICITLY_DEFERRED");
    expect(entry?.status).toBe("deferred");
    expect(entry?.reason).toBe("no upstream work for v1");
  });

  it("refuses a deferral without a reason — silent deferral is scope creep", () => {
    expect(() => deferDimension(createCoverageRecord(), "risks", "  ")).toThrow(/reason/i);
  });
});

describe("settled vs open", () => {
  const MIN = 0.7;

  it("treats COVERED above the threshold as settled", () => {
    expect(isDimensionSettled({ state: "COVERED", confidence: 0.8, status: "covered" }, MIN)).toBe(true);
  });

  it("treats COVERED below the threshold as still open", () => {
    // A low-confidence guess must not close a dimension: that is the
    // difference between "answered" and "inferred and hoped".
    expect(isDimensionSettled({ state: "COVERED", confidence: 0.4, status: "covered" }, MIN)).toBe(false);
  });

  it("treats an explicit deferral as settled regardless of confidence", () => {
    expect(
      isDimensionSettled(
        { state: "EXPLICITLY_DEFERRED", confidence: 0, status: "deferred", reason: "out of scope" },
        MIN,
      ),
    ).toBe(true);
  });

  it("treats PARTIAL and UNKNOWN as open however confident", () => {
    expect(isDimensionSettled({ state: "PARTIAL", confidence: 0.99, status: "open" }, MIN)).toBe(false);
    expect(isDimensionSettled({ state: "UNKNOWN", confidence: 0, status: "open" }, MIN)).toBe(false);
  });

  it("treats a missing entry as open", () => {
    expect(isDimensionSettled(undefined, MIN)).toBe(false);
  });

  it("partitions a record into open and settled dimensions", () => {
    let record = createCoverageRecord();
    record = recordCoverage(record, "problem", { state: "COVERED", confidence: 0.9 });
    record = recordCoverage(record, "scope", { state: "PARTIAL", confidence: 0.5 });
    record = deferDimension(record, "risks", "accepted for v1");

    expect(settledDimensions(record, MIN)).toEqual(["problem", "risks"]);
    expect(openDimensions(record, MIN)).toEqual([
      "users",
      "scope",
      "non_goals",
      "acceptance_criteria",
      "platforms",
      "dependencies",
      "rollout",
      // Non-mandatory, and untouched by this record — open like any other
      // dimension nobody has answered. They appear here because `openDimensions`
      // partitions the whole checklist, not just the blocking part; whether an
      // open dimension holds a draft is `isReadyToDraft`'s question, not this
      // function's.
      "journey_states",
      "api_contract",
      "performance_plan",
    ]);
  });
});

describe("normalizing a persisted record", () => {
  it("rehydrates a full record unchanged", () => {
    const record = recordCoverage(createCoverageRecord(), "problem", { state: "COVERED", confidence: 0.8 });
    const roundTripped = normalizeCoverageRecord(JSON.parse(JSON.stringify(record)));

    expect(roundTripped.dimensions.problem?.state).toBe("COVERED");
    expect(roundTripped.dimensions.problem?.confidence).toBe(0.8);
  });

  it("back-fills state from a frozen-shape entry that has only a status", () => {
    // SpecSession.coverage is Json, and the frozen CoverageEntry has no
    // `state`. A record written by another stream (or by an older revision of
    // this one) must not read back as UNKNOWN and get re-asked.
    const normalized = normalizeCoverageRecord({
      dimensions: {
        problem: { status: "covered", evidence: "thread" },
        users: { status: "deferred", reason: "v2" },
        scope: { status: "open" },
      },
      questionTurns: 2,
      readyToDraft: false,
    });

    expect(normalized.dimensions.problem?.state).toBe("COVERED");
    expect(normalized.dimensions.problem?.confidence).toBe(1);
    expect(normalized.dimensions.users?.state).toBe("EXPLICITLY_DEFERRED");
    expect(normalized.dimensions.scope?.state).toBe("UNKNOWN");
    expect(normalized.questionTurns).toBe(2);
  });

  it("fills absent dimensions and survives junk input", () => {
    const normalized = normalizeCoverageRecord(null);

    expect(Object.keys(normalized.dimensions)).toHaveLength(COVERAGE_DIMENSIONS.length);
    expect(normalized.questionTurns).toBe(0);
    expect(normalized.readyToDraft).toBe(false);
  });

  it("drops a dimension key that is not one of the frozen nine", () => {
    const normalized = normalizeCoverageRecord({
      dimensions: { problem: { status: "covered" }, telepathy: { status: "covered" } },
    });

    expect(normalized.dimensions.problem?.state).toBe("COVERED");
    expect((normalized.dimensions as Record<string, unknown>).telepathy).toBeUndefined();
  });
});
