import { WorkflowStatus } from "@lexi/database";

/**
 * Explicit adjacency list of legal WorkflowStatus transitions, matching the
 * pipeline in the spec:
 *
 *   NEW -> QUEUED -> SENT_TO_REPRODUCTION -> WAITING -> RESULT_RECEIVED ->
 *   AI_ANALYSIS -> VERIFIED -> ASSIGNED -> SLACK_NOTIFIED -> IN_PROGRESS ->
 *   PR_CREATED -> MERGED -> RETEST -> CLOSED
 *
 * Every state can additionally move to FAILED (unhandled processing error)
 * or CANCELLED (operator cancellation), and FAILED/CANCELLED/CLOSED can be
 * re-queued to start a fresh cycle (idempotent re-processing / retest).
 * Non-VERIFIED classifications short-circuit from AI_ANALYSIS straight to
 * SLACK_NOTIFIED (and, for terminal classifications, on to CLOSED) since no
 * assignment is needed. QUEUED can also short-circuit directly to CLOSED:
 * see the cross-org closure check below.
 */
const TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
  // RETEST is reachable directly from NEW because POST /retest is a
  // standalone entry point (like /process): it may be invoked for an issue
  // that has no currently-active workflow execution (e.g. a previously
  // closed issue being re-verified), in which case a fresh execution is
  // created and immediately moved into the retest cycle.
  NEW: [WorkflowStatus.QUEUED, WorkflowStatus.RETEST, WorkflowStatus.EVIDENCE_ASSESSMENT, WorkflowStatus.CANCELLED],
  EVIDENCE_ASSESSMENT: [WorkflowStatus.QUEUED, WorkflowStatus.SLACK_NOTIFIED, WorkflowStatus.RETEST, WorkflowStatus.CLOSED, WorkflowStatus.WRITE_BLOCKED, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED],
  // QUEUED -> CLOSED is the deterministic cross-org closure short-circuit:
  // if CrossOrgClosureChecker proves the issue was already fixed via a
  // linked issue/PR in another org, the pipeline skips reproduction and AI
  // analysis entirely and closes straight from QUEUED.
  QUEUED: [WorkflowStatus.SENT_TO_REPRODUCTION, WorkflowStatus.CLOSED, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED],
  SENT_TO_REPRODUCTION: [WorkflowStatus.WAITING, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED],
  WAITING: [WorkflowStatus.RESULT_RECEIVED, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED],
  RESULT_RECEIVED: [WorkflowStatus.AI_ANALYSIS, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED],
  AI_ANALYSIS: [
    WorkflowStatus.VERIFIED,
    WorkflowStatus.SLACK_NOTIFIED,
    WorkflowStatus.CLOSED,
    WorkflowStatus.WRITE_BLOCKED,
    WorkflowStatus.CLOSE_RECOMMENDED,
    WorkflowStatus.DRY_RUN_COMPLETED,
    WorkflowStatus.FAILED,
    WorkflowStatus.CANCELLED,
  ],
  VERIFIED: [
    WorkflowStatus.ASSIGNED,
    WorkflowStatus.WRITE_BLOCKED,
    WorkflowStatus.CLOSE_RECOMMENDED,
    WorkflowStatus.DRY_RUN_COMPLETED,
    WorkflowStatus.FAILED,
    WorkflowStatus.CANCELLED,
  ],
  ASSIGNED: [WorkflowStatus.SLACK_NOTIFIED, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED],
  SLACK_NOTIFIED: [
    WorkflowStatus.IN_PROGRESS,
    WorkflowStatus.CLOSED,
    WorkflowStatus.WRITE_BLOCKED,
    WorkflowStatus.CLOSE_RECOMMENDED,
    WorkflowStatus.DRY_RUN_COMPLETED,
    WorkflowStatus.RETEST,
    WorkflowStatus.FAILED,
    WorkflowStatus.CANCELLED,
  ],
  IN_PROGRESS: [WorkflowStatus.PR_CREATED, WorkflowStatus.SLACK_NOTIFIED, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED],
  PR_CREATED: [WorkflowStatus.MERGED, WorkflowStatus.IN_PROGRESS, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED],
  MERGED: [WorkflowStatus.RETEST, WorkflowStatus.CLOSED, WorkflowStatus.FAILED, WorkflowStatus.CANCELLED],
  // RETEST doubles as "waiting for the retest reproduction result": it
  // resolves to CLOSED (fix confirmed) or back to SLACK_NOTIFIED (bug still
  // present -> escalate) without needing a separate WAITING hop, since that
  // would make the retest cycle indistinguishable from a first-time cycle.
  RETEST: [
    WorkflowStatus.WAITING,
    WorkflowStatus.CLOSED,
    WorkflowStatus.SLACK_NOTIFIED,
    WorkflowStatus.WRITE_BLOCKED,
    WorkflowStatus.CLOSE_RECOMMENDED,
    WorkflowStatus.DRY_RUN_COMPLETED,
    WorkflowStatus.FAILED,
    WorkflowStatus.CANCELLED,
  ],
  WRITE_BLOCKED: [WorkflowStatus.QUEUED, WorkflowStatus.CANCELLED],
  CLOSE_RECOMMENDED: [WorkflowStatus.QUEUED, WorkflowStatus.CANCELLED, WorkflowStatus.CLOSED],
  DRY_RUN_COMPLETED: [WorkflowStatus.QUEUED, WorkflowStatus.CANCELLED],
  CLOSED: [WorkflowStatus.QUEUED],
  FAILED: [WorkflowStatus.QUEUED, WorkflowStatus.CANCELLED],
  CANCELLED: [WorkflowStatus.QUEUED],
};

export class InvalidWorkflowTransitionError extends Error {
  constructor(from: WorkflowStatus, to: WorkflowStatus) {
    super(`Invalid workflow transition: ${from} -> ${to}`);
    this.name = "InvalidWorkflowTransitionError";
  }
}

/**
 * Validates transitions for the 15-stage workflow pipeline. Purely
 * functional / stateless: callers hold the current status (typically read
 * from the database) and ask the machine whether a move is legal before
 * persisting it, which keeps every workflow job idempotent and safe to
 * retry (re-running a job that already advanced the state simply finds the
 * transition already applied and no-ops).
 */
export class WorkflowStateMachine {
  canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
    if (from === to) {
      return true;
    }
    return TRANSITIONS[from]?.includes(to) ?? false;
  }

  assertTransition(from: WorkflowStatus, to: WorkflowStatus): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidWorkflowTransitionError(from, to);
    }
  }

  nextStates(from: WorkflowStatus): WorkflowStatus[] {
    return TRANSITIONS[from] ?? [];
  }

  isTerminal(status: WorkflowStatus): boolean {
    return status === WorkflowStatus.CLOSED || status === WorkflowStatus.CANCELLED;
  }
}
