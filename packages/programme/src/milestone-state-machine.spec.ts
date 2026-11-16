import { describe, it, expect } from "vitest";
import {
  ALL_MILESTONE_STATUSES,
  InvalidMilestoneTransitionError,
  MilestoneStateMachine,
} from "./milestone-state-machine";

describe("MilestoneStateMachine", () => {
  const machine = new MilestoneStateMachine();

  it("walks the happy path", () => {
    const path = ["PENDING", "READY", "IN_PROGRESS", "EVIDENCE_COMPLETE", "IN_REVIEW", "APPROVED"] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(machine.canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it("APPROVED is reachable ONLY from IN_REVIEW — human-gated by construction", () => {
    for (const from of ALL_MILESTONE_STATUSES) {
      if (from === "IN_REVIEW" || from === "APPROVED") continue;
      expect(machine.canTransition(from, "APPROVED")).toBe(false);
    }
  });

  it("CHANGES_REQUESTED reopens work, never approves", () => {
    expect(machine.canTransition("IN_REVIEW", "CHANGES_REQUESTED")).toBe(true);
    expect(machine.nextStates("CHANGES_REQUESTED")).toEqual(["IN_PROGRESS"]);
  });

  it("late evidence failure can reopen an EVIDENCE_COMPLETE milestone", () => {
    expect(machine.canTransition("EVIDENCE_COMPLETE", "IN_PROGRESS")).toBe(true);
  });

  it("APPROVED is terminal", () => {
    expect(machine.isTerminal("APPROVED")).toBe(true);
    expect(machine.nextStates("APPROVED")).toEqual([]);
  });

  it("assertTransition throws on an illegal move", () => {
    expect(() => machine.assertTransition("PENDING", "APPROVED")).toThrow(
      InvalidMilestoneTransitionError,
    );
  });
});
