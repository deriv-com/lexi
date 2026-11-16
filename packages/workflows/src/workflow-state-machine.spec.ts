import { describe, it, expect } from "vitest";
import { WorkflowStatus } from "@lexi/database";
import { InvalidWorkflowTransitionError, WorkflowStateMachine } from "./workflow-state-machine";

describe("WorkflowStateMachine", () => {
  const machine = new WorkflowStateMachine();

  it("allows the full happy-path pipeline in order", () => {
    const path: WorkflowStatus[] = [
      WorkflowStatus.NEW,
      WorkflowStatus.QUEUED,
      WorkflowStatus.SENT_TO_REPRODUCTION,
      WorkflowStatus.WAITING,
      WorkflowStatus.RESULT_RECEIVED,
      WorkflowStatus.AI_ANALYSIS,
      WorkflowStatus.VERIFIED,
      WorkflowStatus.ASSIGNED,
      WorkflowStatus.SLACK_NOTIFIED,
      WorkflowStatus.IN_PROGRESS,
      WorkflowStatus.PR_CREATED,
      WorkflowStatus.MERGED,
      WorkflowStatus.RETEST,
      WorkflowStatus.CLOSED,
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(machine.canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it("allows the cross-org closure short-circuit from QUEUED straight to CLOSED", () => {
    expect(machine.canTransition(WorkflowStatus.QUEUED, WorkflowStatus.CLOSED)).toBe(true);
  });

  it("rejects illegal transitions", () => {
    expect(machine.canTransition(WorkflowStatus.NEW, WorkflowStatus.CLOSED)).toBe(false);
    expect(() => machine.assertTransition(WorkflowStatus.NEW, WorkflowStatus.MERGED)).toThrow(
      InvalidWorkflowTransitionError,
    );
  });

  it("treats a no-op self-transition as always valid (idempotency)", () => {
    expect(machine.canTransition(WorkflowStatus.WAITING, WorkflowStatus.WAITING)).toBe(true);
  });

  it("allows any state to move to FAILED or CANCELLED", () => {
    const allStates = Object.values(WorkflowStatus);
    for (const state of allStates) {
      if (state === WorkflowStatus.CLOSED || state === WorkflowStatus.CANCELLED || state === WorkflowStatus.FAILED) {
        continue;
      }
      expect(machine.canTransition(state, WorkflowStatus.FAILED) || machine.canTransition(state, WorkflowStatus.CANCELLED)).toBe(true);
    }
  });

  it("allows re-queueing from terminal states for reprocessing", () => {
    expect(machine.canTransition(WorkflowStatus.CLOSED, WorkflowStatus.QUEUED)).toBe(true);
    expect(machine.canTransition(WorkflowStatus.FAILED, WorkflowStatus.QUEUED)).toBe(true);
    expect(machine.canTransition(WorkflowStatus.CANCELLED, WorkflowStatus.QUEUED)).toBe(true);
  });

  it("identifies terminal states correctly", () => {
    expect(machine.isTerminal(WorkflowStatus.CLOSED)).toBe(true);
    expect(machine.isTerminal(WorkflowStatus.CANCELLED)).toBe(true);
    expect(machine.isTerminal(WorkflowStatus.FAILED)).toBe(false);
    expect(machine.isTerminal(WorkflowStatus.WAITING)).toBe(false);
  });
});
