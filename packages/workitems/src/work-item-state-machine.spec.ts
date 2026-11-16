import { describe, it, expect } from "vitest";
import type { WorkItemStatus } from "@lexi/contracts";
import {
  ALL_WORK_ITEM_STATUSES,
  InvalidWorkItemTransitionError,
  WorkItemStateMachine,
} from "./work-item-state-machine";

/**
 * A small state machine, with the same generated-Mermaid-fails-build pattern
 * as workflow-state-machine.ts, rather than an extension of the 20-state bug
 * machine.
 *
 * These tests therefore assert two things at once: that the happy path is
 * exactly the eight statuses the frozen contract names, and that this machine
 * has no knowledge of WorkflowStatus at all.
 */
describe("WorkItemStateMachine", () => {
  const machine = new WorkItemStateMachine();

  it("covers exactly the eight frozen WorkItemStatus values", () => {
    expect([...ALL_WORK_ITEM_STATUSES].sort()).toEqual(
      [
        "CANCELLED",
        "CLARIFYING",
        "DELIVERED",
        "IN_PROGRESS",
        "PROPOSED",
        "SPECED",
        "TASKED",
        "VERIFIED",
      ].sort(),
    );
  });

  it("walks the full happy path PROPOSED -> VERIFIED", () => {
    const path: WorkItemStatus[] = [
      "PROPOSED",
      "CLARIFYING",
      "SPECED",
      "TASKED",
      "IN_PROGRESS",
      "DELIVERED",
      "VERIFIED",
    ];

    for (let i = 0; i < path.length - 1; i += 1) {
      expect(
        machine.canTransition(path[i], path[i + 1]),
        `${path[i]} -> ${path[i + 1]} must be legal`,
      ).toBe(true);
    }
  });

  it("lets a well-specified request skip clarification", () => {
    // A request that arrives already clear should not be forced through a
    // clarification round it does not need.
    expect(machine.canTransition("PROPOSED", "SPECED")).toBe(true);
  });

  it("lets a bug or chore skip the spec stage entirely", () => {
    // Not every work item needs a spec — the spec gate covers *features*, not chores.
    expect(machine.canTransition("PROPOSED", "TASKED")).toBe(true);
    expect(machine.canTransition("CLARIFYING", "TASKED")).toBe(true);
  });

  it("treats same-state as a legal no-op so jobs stay idempotent", () => {
    for (const status of ALL_WORK_ITEM_STATUSES) {
      expect(machine.canTransition(status, status)).toBe(true);
    }
  });

  it("allows CANCELLED from every non-terminal state", () => {
    for (const status of ALL_WORK_ITEM_STATUSES) {
      if (status === "CANCELLED" || status === "VERIFIED") continue;
      expect(machine.canTransition(status, "CANCELLED"), `${status} -> CANCELLED`).toBe(true);
    }
  });

  it("refuses to run the lifecycle backwards", () => {
    expect(machine.canTransition("VERIFIED", "PROPOSED")).toBe(false);
    expect(machine.canTransition("DELIVERED", "TASKED")).toBe(false);
    expect(machine.canTransition("TASKED", "CLARIFYING")).toBe(false);
  });

  it("refuses to skip delivery — VERIFIED is only reachable from DELIVERED", () => {
    for (const status of ALL_WORK_ITEM_STATUSES) {
      if (status === "DELIVERED" || status === "VERIFIED") continue;
      expect(machine.canTransition(status, "VERIFIED"), `${status} -> VERIFIED`).toBe(false);
    }
  });

  it("lets delivery bounce back to IN_PROGRESS when verification fails", () => {
    // Verification failing must not strand the item: DELIVERED -> IN_PROGRESS
    // is how a failed verification re-opens the work.
    expect(machine.canTransition("DELIVERED", "IN_PROGRESS")).toBe(true);
  });

  it("treats VERIFIED and CANCELLED as terminal", () => {
    expect(machine.isTerminal("VERIFIED")).toBe(true);
    expect(machine.isTerminal("CANCELLED")).toBe(true);
    expect(machine.isTerminal("IN_PROGRESS")).toBe(false);
    expect(machine.isTerminal("PROPOSED")).toBe(false);
  });

  it("lets a cancelled item be revived back to PROPOSED", () => {
    expect(machine.canTransition("CANCELLED", "PROPOSED")).toBe(true);
  });

  it("throws InvalidWorkItemTransitionError naming both states", () => {
    expect(() => machine.assertTransition("VERIFIED", "PROPOSED")).toThrow(
      InvalidWorkItemTransitionError,
    );
    expect(() => machine.assertTransition("VERIFIED", "PROPOSED")).toThrow(
      /VERIFIED -> PROPOSED/,
    );
  });

  it("does not throw for a legal transition", () => {
    expect(() => machine.assertTransition("PROPOSED", "CLARIFYING")).not.toThrow();
  });

  it("returns [] rather than throwing for an unknown status", () => {
    expect(machine.nextStates("NOT_A_STATUS" as WorkItemStatus)).toEqual([]);
    expect(machine.canTransition("NOT_A_STATUS" as WorkItemStatus, "PROPOSED")).toBe(false);
  });

  it("never names a bug-workflow state — work items reference that machine, not extend it", () => {
    const bugOnlyStates = [
      "NEW",
      "QUEUED",
      "SENT_TO_REPRODUCTION",
      "WAITING",
      "RESULT_RECEIVED",
      "AI_ANALYSIS",
      "ASSIGNED",
      "SLACK_NOTIFIED",
      "PR_CREATED",
      "MERGED",
      "RETEST",
      "CLOSED",
      "FAILED",
      "WRITE_BLOCKED",
      "CLOSE_RECOMMENDED",
      "DRY_RUN_COMPLETED",
      "EVIDENCE_ASSESSMENT",
    ];

    for (const bugState of bugOnlyStates) {
      expect(ALL_WORK_ITEM_STATUSES as readonly string[]).not.toContain(bugState);
    }
  });

  it("keeps every declared target inside the status set", () => {
    for (const from of ALL_WORK_ITEM_STATUSES) {
      for (const to of machine.nextStates(from)) {
        expect(ALL_WORK_ITEM_STATUSES).toContain(to);
      }
    }
  });

  it("leaves no state unreachable from PROPOSED", () => {
    const seen = new Set<WorkItemStatus>(["PROPOSED"]);
    const queue: WorkItemStatus[] = ["PROPOSED"];

    while (queue.length > 0) {
      const current = queue.shift() as WorkItemStatus;
      for (const next of machine.nextStates(current)) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }

    for (const status of ALL_WORK_ITEM_STATUSES) {
      expect(seen.has(status), `${status} is unreachable from PROPOSED`).toBe(true);
    }
  });
});
