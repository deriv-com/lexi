import { describe, it, expect } from "vitest";
import {
  ALL_BUILD_TASK_STATUSES,
  BuildTaskStateMachine,
  InvalidBuildTaskTransitionError,
} from "./build-task-state-machine";

describe("BuildTaskStateMachine", () => {
  const machine = new BuildTaskStateMachine();

  it("retires a task that has not started, from any pre-dispatch state", () => {
    for (const from of ["PENDING", "READY", "HANDBACK", "FAILED"] as const) {
      expect(machine.canTransition(from, "CANCELLED")).toBe(true);
    }
  });

  it("refuses to retire work that is in flight or already landed", () => {
    // A run is live at DISPATCHED and the evidence states: retiring the row
    // would strand the workflow with nothing to fold its result into. Pausing
    // the programme is the lever there. MERGED/VERIFIED are already facts
    // about the repository and cannot be retracted by a status change.
    for (const from of ["DISPATCHED", "EVIDENCE_RED", "EVIDENCE_GREEN", "PR_OPEN", "MERGED", "VERIFIED"] as const) {
      expect(machine.canTransition(from, "CANCELLED")).toBe(false);
    }
  });

  it("restores a retired task to the START of the lifecycle, not to READY", () => {
    // The dependency gate has to be re-evaluated: the graph may have moved
    // while the task sat retired.
    expect(machine.canTransition("CANCELLED", "PENDING")).toBe(true);
    expect(machine.canTransition("CANCELLED", "READY")).toBe(false);
    expect(machine.canTransition("CANCELLED", "DISPATCHED")).toBe(false);
  });

  it("walks the TDD happy path", () => {
    const path = [
      "PENDING",
      "READY",
      "DISPATCHED",
      "EVIDENCE_RED",
      "EVIDENCE_GREEN",
      "PR_OPEN",
      "MERGED",
      "VERIFIED",
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(machine.canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it("cannot reach PR_OPEN without passing through both evidence states", () => {
    // A run that opened a PR without demonstrating a failing test first has
    // violated the TDD contract; the advance job records HANDBACK instead.
    expect(machine.canTransition("DISPATCHED", "PR_OPEN")).toBe(false);
    expect(machine.canTransition("EVIDENCE_RED", "PR_OPEN")).toBe(false);
  });

  it("green evidence cannot precede red", () => {
    expect(machine.canTransition("DISPATCHED", "EVIDENCE_GREEN")).toBe(false);
  });

  it("VERIFIED is reachable only from MERGED", () => {
    for (const from of ALL_BUILD_TASK_STATUSES) {
      if (from === "MERGED" || from === "VERIFIED") continue;
      expect(machine.canTransition(from, "VERIFIED")).toBe(false);
    }
  });

  it("HANDBACK and FAILED re-arm to READY (attempt cap is the caller's)", () => {
    expect(machine.canTransition("HANDBACK", "READY")).toBe(true);
    expect(machine.canTransition("FAILED", "READY")).toBe(true);
  });

  it("VERIFIED is the only terminal state", () => {
    for (const status of ALL_BUILD_TASK_STATUSES) {
      expect(machine.isTerminal(status)).toBe(status === "VERIFIED");
    }
  });

  it("assertTransition throws on an illegal move", () => {
    expect(() => machine.assertTransition("PENDING", "MERGED")).toThrow(
      InvalidBuildTaskTransitionError,
    );
  });
});
