import { describe, it, expect } from "vitest";
import { infrastructureStageOf, isPreAgentHandback, refundForInfraFault, refundForMergeConflict } from "./attempt-accounting";

describe("infrastructureStageOf", () => {
  it("recognises the push-and-PR step", () => {
    // The reason a run reports when the branch push is refused.
    expect(
      infrastructureStageOf("the run failed during pushing the branch and opening the PR; see the job log"),
    ).toEqual({ label: "pushing the branch or opening the PR", consequence: "so its work never reached a PR" });
  });

  it("recognises the UI-source checkout", () => {
    // The reason a run reports when the UI-source checkout is refused.
    expect(
      infrastructureStageOf("the run failed during checking out the UI source to port from; see the job log"),
    ).toEqual({ label: "checking out the UI source", consequence: "so the agent never started" });
  });

  it("does not recognise failures at the stages where the agent's own work is judged", () => {
    for (const reason of [
      "the run failed during running the full checks; see the job log",
      "the run failed during the GREEN phase; see the job log",
      "the run failed during deriving the task branch; see the job log",
      "tests still failing after GREEN phase",
      "brief refused: brief fetch failed (last HTTP 401)",
    ]) {
      expect(infrastructureStageOf(reason), reason).toBeNull();
    }
    expect(infrastructureStageOf(null)).toBeNull();
    expect(infrastructureStageOf(undefined)).toBeNull();
  });
});

describe("isPreAgentHandback", () => {
  /**
   * The exact string programme-build.yml writes at the one point it hands back
   * without starting the agent (`HANDBACK_REASON=brief refused: ${REASON}`),
   * and the value a brief fetch refused with a 401 produces.
   */
  it("recognises the runner's pre-agent refusal", () => {
    expect(isPreAgentHandback("brief refused: brief fetch failed (last HTTP 401)")).toBe(true);
    expect(isPreAgentHandback("brief refused: schema validation failed")).toBe(true);
  });

  /**
   * Every other reason the workflow can emit means the agent RAN. Charging
   * those to the build budget is the whole point of the budget, so a refund
   * here would be the actual bug.
   */
  it("does not recognise reasons raised after the agent ran", () => {
    for (const reason of [
      "RED-phase agent reported an error",
      "RED-phase agent run failed",
      "RED phase produced no changes",
      "GREEN-phase agent reported an error",
      "GREEN-phase agent run failed",
      "tests still failing after GREEN phase",
    ]) {
      expect(isPreAgentHandback(reason), reason).toBe(false);
    }
  });

  it("fails safe on absent or unrecognised reasons", () => {
    expect(isPreAgentHandback(null)).toBe(false);
    expect(isPreAgentHandback(undefined)).toBe(false);
    expect(isPreAgentHandback("")).toBe(false);
    expect(isPreAgentHandback("something nobody has written yet")).toBe(false);
    // Not a prefix match anywhere in the string — only at the start.
    expect(isPreAgentHandback("agent said the brief refused: nonsense")).toBe(false);
  });

  it("tolerates the leading whitespace and casing a shell can introduce", () => {
    expect(isPreAgentHandback("  brief refused: x")).toBe(true);
    expect(isPreAgentHandback("Brief refused: x")).toBe(true);
  });
});

describe("refundForInfraFault", () => {
  it("gives the attempt back and counts the fault", () => {
    expect(refundForInfraFault({ storedAttempts: 1, priorInfraFaults: 0, maxInfraFaults: 3 })).toEqual({
      attempts: 0,
      infraFaults: 1,
    });
  });

  it("keeps refunding up to the cap", () => {
    expect(refundForInfraFault({ storedAttempts: 1, priorInfraFaults: 2, maxInfraFaults: 3 })).toEqual({
      attempts: 0,
      infraFaults: 3,
    });
  });

  /**
   * The half of the original reasoning that was right: a permanently broken
   * repository must terminate. Past the cap the fault is charged to the build
   * budget again and the task dies exactly as it used to.
   */
  it("refuses once the infrastructure budget is spent", () => {
    expect(refundForInfraFault({ storedAttempts: 3, priorInfraFaults: 3, maxInfraFaults: 3 })).toBeNull();
    expect(refundForInfraFault({ storedAttempts: 3, priorInfraFaults: 9, maxInfraFaults: 3 })).toBeNull();
  });

  it("restores the old behaviour exactly at maxInfraFaults: 0", () => {
    expect(refundForInfraFault({ storedAttempts: 1, priorInfraFaults: 0, maxInfraFaults: 0 })).toBeNull();
  });

  it("never drives the counter negative", () => {
    expect(refundForInfraFault({ storedAttempts: 0, priorInfraFaults: 0, maxInfraFaults: 3 })?.attempts).toBe(0);
  });
});

describe("refundForMergeConflict", () => {
  /**
   * The case that forced this to exist: a task that built correctly, opened a
   * PR and went green, then lost its base to a sibling's merge. It gets the
   * attempt back, because nothing about its build was tested by that.
   */
  it("gives the attempt back and counts the re-arm", () => {
    expect(
      refundForMergeConflict({ storedAttempts: 2, priorConflictRearms: 0, maxConflictRearms: 20 }),
    ).toEqual({ attempts: 1, conflictRearms: 1 });
  });

  /**
   * A wide milestone is the whole point: 11 PRs racing one base means a task
   * can legitimately lose that race ten times. Those must all be free, or the
   * last PR in the queue strands having never once failed.
   */
  it("stays free across a milestone-wide race", () => {
    let attempts = 1;
    let rearms = 0;
    for (let i = 0; i < 10; i += 1) {
      const refund = refundForMergeConflict({
        storedAttempts: attempts + 1, // the re-dispatch that spent an attempt
        priorConflictRearms: rearms,
        maxConflictRearms: 20,
      });
      expect(refund).not.toBeNull();
      attempts = refund!.attempts;
      rearms = refund!.conflictRearms;
    }
    expect(attempts).toBe(1);
    expect(rearms).toBe(10);
  });

  /** Bounded, so a conflict the runner cannot resolve still terminates. */
  it("refuses once the conflict budget is spent", () => {
    expect(
      refundForMergeConflict({ storedAttempts: 4, priorConflictRearms: 20, maxConflictRearms: 20 }),
    ).toBeNull();
  });

  it("restores the old behaviour exactly at maxConflictRearms: 0", () => {
    expect(
      refundForMergeConflict({ storedAttempts: 1, priorConflictRearms: 0, maxConflictRearms: 0 }),
    ).toBeNull();
  });

  it("never drives the counter negative", () => {
    expect(
      refundForMergeConflict({ storedAttempts: 0, priorConflictRearms: 0, maxConflictRearms: 20 })?.attempts,
    ).toBe(0);
  });
});
