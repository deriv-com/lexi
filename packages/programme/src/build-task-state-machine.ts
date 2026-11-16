import type { BuildTaskStatus } from "@lexi/contracts";

/**
 * Build-task lifecycle:
 *
 *   PENDING -> READY -> DISPATCHED -> EVIDENCE_RED -> EVIDENCE_GREEN
 *   -> PR_OPEN -> MERGED -> VERIFIED
 *
 * The RED-before-GREEN ordering is enforced twice on purpose: here as the
 * only path between the two evidence states, and again in
 * `evaluateAutoMergeGate` against the persisted `RunEvidenceRecord` rows —
 * the machine constrains what the advance job may record, the gate
 * constrains what actually merges, and neither trusts the other.
 *
 * DISPATCHED -> PR_OPEN (skipping the evidence states) is deliberately
 * ABSENT: a run that opened a PR without posting red evidence first has
 * violated the TDD contract, and the advance job records it as HANDBACK
 * rather than laundering it into the happy path.
 *
 * HANDBACK / FAILED -> READY re-arms a task for another attempt. The
 * machine cannot see the attempt counter, so the ATTEMPT CAP
 * (`dispatch.maxTaskAttempts` in config/programme-policy.yaml) is enforced
 * by the caller before it asks for this edge — same division of labour as
 * the work-item machine, where self-transitions are legal and budgets live in
 * policy.
 */
const TRANSITIONS: Record<BuildTaskStatus, BuildTaskStatus[]> = {
  PENDING: ["READY", "CANCELLED"],
  // MERGED is reachable from every state that can hold a PR number from an
  // EARLIER attempt, not just PR_OPEN. "The PR this task produced has landed"
  // is a fact about the repository, and it can become true while the task is
  // anywhere — a conflict re-arm moves a task PR_OPEN -> HANDBACK ->
  // READY -> DISPATCHED while its PR stays open behind it, so a PR merged in
  // that window used to be invisible. The task would then rebuild work that
  // was already in the base and open a second PR for it.
  READY: ["DISPATCHED", "MERGED", "CANCELLED"],
  DISPATCHED: ["EVIDENCE_RED", "HANDBACK", "FAILED", "MERGED"],
  EVIDENCE_RED: ["EVIDENCE_GREEN", "HANDBACK", "FAILED", "MERGED"],
  EVIDENCE_GREEN: ["PR_OPEN", "HANDBACK", "FAILED", "MERGED"],
  PR_OPEN: ["MERGED", "HANDBACK", "FAILED"],
  // VERIFIED means the post-merge verify run (e2e / visual / a11y against the
  // preview build) came back green for the merged SHA — reachable only from
  // MERGED for the same reason work items gate VERIFIED on DELIVERED.
  MERGED: ["VERIFIED"],
  VERIFIED: [],
  HANDBACK: ["READY", "FAILED", "MERGED", "CANCELLED"],
  FAILED: ["READY", "MERGED", "CANCELLED"],
  // Cancelling is reversible, and it returns to the START of the lifecycle
  // rather than to READY: the dependency gate has to be re-evaluated, because
  // the graph may have moved while the task sat retired.
  //
  // There is deliberately no DISPATCHED -> CANCELLED edge. A run is in flight
  // at that point; retiring the row would strand the workflow and its evidence
  // with nothing to fold them into. Pausing the programme is the lever there.
  CANCELLED: ["PENDING"],
};

export const ALL_BUILD_TASK_STATUSES = Object.keys(TRANSITIONS) as BuildTaskStatus[];

export class InvalidBuildTaskTransitionError extends Error {
  constructor(from: BuildTaskStatus, to: BuildTaskStatus) {
    super(`Invalid build task transition: ${from} -> ${to}`);
    this.name = "InvalidBuildTaskTransitionError";
  }
}

export class BuildTaskStateMachine {
  canTransition(from: BuildTaskStatus, to: BuildTaskStatus): boolean {
    if (from === to) {
      return ALL_BUILD_TASK_STATUSES.includes(from);
    }
    return TRANSITIONS[from]?.includes(to) ?? false;
  }

  assertTransition(from: BuildTaskStatus, to: BuildTaskStatus): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidBuildTaskTransitionError(from, to);
    }
  }

  nextStates(from: BuildTaskStatus): BuildTaskStatus[] {
    return TRANSITIONS[from] ?? [];
  }

  isTerminal(status: BuildTaskStatus): boolean {
    return status === "VERIFIED";
  }
}
