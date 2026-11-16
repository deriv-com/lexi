import type { MilestoneStatus } from "@lexi/contracts";

/**
 * Milestone lifecycle:
 *
 *   PENDING -> READY -> IN_PROGRESS -> EVIDENCE_COMPLETE -> IN_REVIEW
 *   -> APPROVED, with IN_REVIEW -> CHANGES_REQUESTED -> IN_PROGRESS rework.
 *
 * APPROVED is reachable ONLY from IN_REVIEW — human-gated by construction,
 * the same shape as `VERIFIED` only-from-`DELIVERED` on work items: the
 * approval click (`programme.milestone.approve`, a Block Kit action the
 * model never sees) is the sole edge into it, so no scheduler tick or model
 * turn can assert a milestone approved.
 *
 * EVIDENCE_COMPLETE -> IN_PROGRESS is legal so a late-arriving evidence
 * failure (e.g. a post-merge verify run going red) can reopen the milestone
 * before a human wastes a review on it.
 */
const TRANSITIONS: Record<MilestoneStatus, MilestoneStatus[]> = {
  PENDING: ["READY"],
  READY: ["IN_PROGRESS"],
  IN_PROGRESS: ["EVIDENCE_COMPLETE"],
  EVIDENCE_COMPLETE: ["IN_REVIEW", "IN_PROGRESS"],
  IN_REVIEW: ["APPROVED", "CHANGES_REQUESTED"],
  APPROVED: [],
  CHANGES_REQUESTED: ["IN_PROGRESS"],
};

export const ALL_MILESTONE_STATUSES = Object.keys(TRANSITIONS) as MilestoneStatus[];

export class InvalidMilestoneTransitionError extends Error {
  constructor(from: MilestoneStatus, to: MilestoneStatus) {
    super(`Invalid milestone transition: ${from} -> ${to}`);
    this.name = "InvalidMilestoneTransitionError";
  }
}

export class MilestoneStateMachine {
  canTransition(from: MilestoneStatus, to: MilestoneStatus): boolean {
    if (from === to) {
      return ALL_MILESTONE_STATUSES.includes(from);
    }
    return TRANSITIONS[from]?.includes(to) ?? false;
  }

  assertTransition(from: MilestoneStatus, to: MilestoneStatus): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidMilestoneTransitionError(from, to);
    }
  }

  nextStates(from: MilestoneStatus): MilestoneStatus[] {
    return TRANSITIONS[from] ?? [];
  }

  isTerminal(status: MilestoneStatus): boolean {
    return status === "APPROVED";
  }
}
