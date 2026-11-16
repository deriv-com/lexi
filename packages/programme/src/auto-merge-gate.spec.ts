import { describe, it, expect } from "vitest";
import {
  criterionReason,
  evaluateAutoMergeGate,
  parseCriterionReason,
  type AutoMergeGateInput,
  type EvidenceRow,
} from "./auto-merge-gate";

/**
 * The gate is the last deterministic word before an unattended merge, so
 * every test here is a refusal case with a named reason — the passing case
 * exists once, to prove the reasons list is the only thing standing between
 * evidence and a merge.
 */

const at = (minute: number): Date => new Date(Date.UTC(2026, 0, 1, 12, minute));

const HEAD_SHA = "abc123def456";

function greenPath(): EvidenceRow[] {
  return [
    { phase: "red", failingTests: [{ testName: "t1", failureOutput: "boom" }], commitSha: HEAD_SHA, receivedAt: at(0) },
    { phase: "green", commitSha: HEAD_SHA, receivedAt: at(5) },
    {
      phase: "checks",
      checks: [
        { name: "types", status: "passed" },
        { name: "unit", status: "passed" },
      ],
      commitSha: HEAD_SHA,
      receivedAt: at(10),
    },
  ];
}

function baseInput(overrides: Partial<AutoMergeGateInput> = {}): AutoMergeGateInput {
  return {
    evidence: greenPath(),
    acceptanceCriterionIds: ["AC-11112222"],
    acStatuses: [{ criterionId: "AC-11112222", status: "green" }],
    policy: {
      requiredEvidencePhases: ["red", "green", "checks"],
      requiredChecks: ["types", "unit"],
      requireAcMatrixGreen: true,
      requireHeadShaMatch: true,
    },
    pr: { headSha: HEAD_SHA, open: true, mergeable: true },
    ...overrides,
  };
}

describe("evaluateAutoMergeGate", () => {
  it("allows only when every gate passes, with an empty reasons list", () => {
    const verdict = evaluateAutoMergeGate(baseInput());
    expect(verdict.reasons).toEqual([]);
    expect(verdict.allowed).toBe(true);
    expect(verdict.redBeforeGreen).toBe(true);
  });

  it("refuses with NO evidence at all — absence is a refusal, not a pass", () => {
    const verdict = evaluateAutoMergeGate(baseInput({ evidence: [] }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it("refuses green-without-red", () => {
    const evidence = greenPath().filter((row) => row.phase !== "red");
    const verdict = evaluateAutoMergeGate(baseInput({ evidence }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.redBeforeGreen).toBe(false);
    expect(verdict.reasons).toContain("no red evidence bundle received before the first green one");
  });

  it("refuses red received AFTER green — ordering by the store's clock", () => {
    const evidence: EvidenceRow[] = [
      { phase: "green", commitSha: HEAD_SHA, receivedAt: at(0) },
      { phase: "red", commitSha: HEAD_SHA, receivedAt: at(5) },
      { phase: "checks", checks: [{ name: "types", status: "passed" }, { name: "unit", status: "passed" }], commitSha: HEAD_SHA, receivedAt: at(10) },
    ];
    const verdict = evaluateAutoMergeGate(baseInput({ evidence }));
    expect(verdict.redBeforeGreen).toBe(false);
    expect(verdict.allowed).toBe(false);
  });

  it("refuses a failed required check, named", () => {
    const evidence = greenPath();
    evidence[2] = {
      ...evidence[2],
      checks: [
        { name: "types", status: "passed" },
        { name: "unit", status: "failed" },
      ],
    };
    const verdict = evaluateAutoMergeGate(baseInput({ evidence }));
    expect(verdict.reasons).toContain("required check unit: failed");
  });

  it("refuses a missing required check — skipped is not passed", () => {
    const evidence = greenPath();
    evidence[2] = { ...evidence[2], checks: [{ name: "types", status: "passed" }, { name: "unit", status: "skipped" }] };
    const verdict = evaluateAutoMergeGate(baseInput({ evidence }));
    expect(verdict.reasons).toContain("required check unit: missing");
  });

  it("refuses an unbound or non-green acceptance criterion", () => {
    const verdict = evaluateAutoMergeGate(
      baseInput({
        acceptanceCriterionIds: ["AC-11112222", "AC-33334444"],
        acStatuses: [{ criterionId: "AC-11112222", status: "green" }],
      }),
    );
    expect(verdict.reasons).toContain("acceptance criterion AC-33334444: unbound");
  });

  it("refuses when no evidence carries the PR head SHA", () => {
    const verdict = evaluateAutoMergeGate(baseInput({ pr: { headSha: "other-sha", open: true, mergeable: true } }));
    expect(verdict.reasons).toContain("no evidence bundle carries the PR head SHA other-sha");
  });

  it("refuses a closed or unmergeable PR", () => {
    expect(evaluateAutoMergeGate(baseInput({ pr: { headSha: HEAD_SHA, open: false } })).reasons).toContain(
      "pull request is not open",
    );
    expect(
      evaluateAutoMergeGate(baseInput({ pr: { headSha: HEAD_SHA, open: true, mergeable: false } })).reasons,
    ).toContain("GitHub reports the pull request as not mergeable");
  });
});

describe("criterion reason wording", () => {
  it("round-trips, so persisted verdicts can be read back", () => {
    expect(parseCriterionReason(criterionReason("AC-1234abcd", "unbound"))).toEqual({ criterionId: "AC-1234abcd", status: "unbound" });
    expect(parseCriterionReason("required check lint: failed")).toBeNull();
  });
});
