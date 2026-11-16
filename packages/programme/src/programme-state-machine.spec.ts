import { describe, it, expect } from "vitest";
import {
  ALL_PROGRAMME_STATUSES,
  InvalidProgrammeTransitionError,
  ProgrammeStateMachine,
} from "./programme-state-machine";

describe("ProgrammeStateMachine", () => {
  const machine = new ProgrammeStateMachine();

  it("covers exactly the nine frozen ProgrammeStatus values", () => {
    expect([...ALL_PROGRAMME_STATUSES].sort()).toEqual(
      [
        "HARDENING",
        "BUILDING",
        "CANCELLED",
        "COMPLETE",
        "MILESTONE_REVIEW",
        "PAUSED",
        "PLANNED",
        "PROPOSED",
        "SEEDED",
      ].sort(),
    );
  });

  it("walks the happy path", () => {
    const path = ["PROPOSED", "SEEDED", "PLANNED", "BUILDING", "MILESTONE_REVIEW", "BUILDING", "HARDENING", "COMPLETE"] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(machine.canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it("COMPLETE is reachable only from HARDENING", () => {
    for (const from of ALL_PROGRAMME_STATUSES) {
      if (from === "HARDENING" || from === "COMPLETE") continue;
      expect(machine.canTransition(from, "COMPLETE")).toBe(false);
    }
  });

  it("hardening findings send the programme back to BUILDING, not COMPLETE", () => {
    expect(machine.canTransition("HARDENING", "BUILDING")).toBe(true);
  });

  it("same-state is a legal no-op so the advance job can re-run", () => {
    for (const status of ALL_PROGRAMME_STATUSES) {
      expect(machine.canTransition(status, status)).toBe(true);
    }
  });

  it("terminal states are COMPLETE and CANCELLED, and COMPLETE has no exits", () => {
    expect(machine.isTerminal("COMPLETE")).toBe(true);
    expect(machine.isTerminal("CANCELLED")).toBe(true);
    expect(machine.nextStates("COMPLETE")).toEqual([]);
  });

  it("CANCELLED revives only to PROPOSED", () => {
    expect(machine.nextStates("CANCELLED")).toEqual(["PROPOSED"]);
  });

  it("PAUSED is reachable from every non-terminal state except itself", () => {
    for (const from of ALL_PROGRAMME_STATUSES) {
      if (machine.isTerminal(from) || from === "PAUSED") continue;
      expect(machine.canTransition(from, "PAUSED")).toBe(true);
    }
    expect(machine.canTransition("COMPLETE", "PAUSED")).toBe(false);
  });

  it("assertTransition throws a named error on an illegal move", () => {
    expect(() => machine.assertTransition("PROPOSED", "COMPLETE")).toThrow(
      InvalidProgrammeTransitionError,
    );
  });
});
