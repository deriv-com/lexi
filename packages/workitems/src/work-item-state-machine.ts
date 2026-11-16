import type { WorkItemStatus } from "@lexi/contracts";

/**
 * Explicit adjacency list of legal WorkItemStatus transitions:
 *
 *   PROPOSED -> CLARIFYING -> SPECED -> TASKED -> IN_PROGRESS ->
 *   DELIVERED -> VERIFIED
 *
 * Deliberately **separate from** the 20-state bug machine in
 * `packages/workflows/src/workflow-state-machine.ts`. Work items *reference*
 * that machine (a bug work item carries the issue number whose workflow
 * execution runs there); they do not extend it. Merging the two would force
 * every feature through SENT_TO_REPRODUCTION / RESULT_RECEIVED / RETEST —
 * states that only make sense for a defect — which is precisely the "forced
 * into bug shape" problem work items exist to remove.
 *
 * Three shortcuts are legal on purpose, because not every work item needs
 * every stage:
 *   - PROPOSED -> SPECED: a request that arrives already clear skips
 *     clarification rather than being interrogated for form's sake.
 *   - PROPOSED/CLARIFYING -> TASKED: bugs and chores skip the spec stage;
 *     the spec gate applies to *features*, not all work.
 *   - DELIVERED -> IN_PROGRESS: failed verification re-opens the work instead
 *     of stranding the item in DELIVERED.
 *
 * Every non-terminal state can additionally move to CANCELLED, and CANCELLED
 * can be revived to PROPOSED so a mistakenly-cancelled item does not need a
 * new row (which would orphan its issue, spec and board links).
 */
const TRANSITIONS: Record<WorkItemStatus, WorkItemStatus[]> = {
  PROPOSED: ["CLARIFYING", "SPECED", "TASKED", "CANCELLED"],
  CLARIFYING: ["SPECED", "TASKED", "CANCELLED"],
  SPECED: ["TASKED", "CLARIFYING", "CANCELLED"],
  TASKED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["DELIVERED", "TASKED", "CANCELLED"],
  // VERIFIED is reachable ONLY from DELIVERED: "verified" means a deployment
  // record exists for something that actually shipped, so it must not
  // be assertable from a state where nothing has been delivered.
  DELIVERED: ["VERIFIED", "IN_PROGRESS", "CANCELLED"],
  VERIFIED: [],
  CANCELLED: ["PROPOSED"],
};

/** Every legal status, in lifecycle order. */
export const ALL_WORK_ITEM_STATUSES = Object.keys(TRANSITIONS) as WorkItemStatus[];

export class InvalidWorkItemTransitionError extends Error {
  constructor(from: WorkItemStatus, to: WorkItemStatus) {
    super(`Invalid work item transition: ${from} -> ${to}`);
    this.name = "InvalidWorkItemTransitionError";
  }
}

/**
 * Validates transitions for the work-item lifecycle. Purely functional /
 * stateless, matching `WorkflowStateMachine`: callers hold the current status
 * (typically read from `work_items.status`) and ask whether a move is legal
 * before persisting it, which keeps every job that advances a work item
 * idempotent and safe to retry.
 */
export class WorkItemStateMachine {
  canTransition(from: WorkItemStatus, to: WorkItemStatus): boolean {
    // Same-state is a legal no-op so a re-run that finds the move already
    // applied simply does nothing, rather than throwing.
    if (from === to) {
      return ALL_WORK_ITEM_STATUSES.includes(from);
    }
    return TRANSITIONS[from]?.includes(to) ?? false;
  }

  assertTransition(from: WorkItemStatus, to: WorkItemStatus): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidWorkItemTransitionError(from, to);
    }
  }

  nextStates(from: WorkItemStatus): WorkItemStatus[] {
    return TRANSITIONS[from] ?? [];
  }

  isTerminal(status: WorkItemStatus): boolean {
    return status === "VERIFIED" || status === "CANCELLED";
  }
}
