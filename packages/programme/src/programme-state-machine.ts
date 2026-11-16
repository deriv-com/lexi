import type { ProgrammeStatus } from "@lexi/contracts";

/**
 * Explicit adjacency list of legal ProgrammeStatus transitions:
 *
 *   PROPOSED -> SEEDED -> PLANNED -> BUILDING <-> MILESTONE_REVIEW
 *   -> HARDENING -> COMPLETE
 *
 * Deliberately a separate machine beside the bug workflow, the
 * work-item lifecycle, and the spec lifecycle — a programme *contains*
 * milestones whose tasks reference those machines; it does not extend any of
 * them. Merging would force a multi-week rebuild through states that only
 * make sense for a single defect or a single document.
 *
 * Two loops are legal on purpose:
 *   - BUILDING <-> MILESTONE_REVIEW: every milestone boundary parks the
 *     programme until a human clicks approve; CHANGES_REQUESTED on the
 *     milestone sends the programme back to BUILDING for rework.
 *   - HARDENING -> BUILDING: hardening findings are new build tasks, not a
 *     dead end — the programme goes back to work rather than completing
 *     over open findings.
 *
 * PAUSED is reachable from every non-terminal working state and resumes to
 * exactly the states work can restart from. CANCELLED is revivable to
 * PROPOSED so a mistakenly-cancelled programme keeps its milestones, specs
 * and provenance rather than needing a new row.
 */
const TRANSITIONS: Record<ProgrammeStatus, ProgrammeStatus[]> = {
  PROPOSED: ["SEEDED", "PAUSED", "CANCELLED"],
  SEEDED: ["PLANNED", "PAUSED", "CANCELLED"],
  PLANNED: ["BUILDING", "PAUSED", "CANCELLED"],
  BUILDING: ["MILESTONE_REVIEW", "HARDENING", "PAUSED", "CANCELLED"],
  MILESTONE_REVIEW: ["BUILDING", "PAUSED", "CANCELLED"],
  // COMPLETE is reachable ONLY from HARDENING: "complete" means the hardening
  // gate passed (zero open findings AND a human concluded the hardening pass), so it
  // must not be assertable from a state where no hardening pass has happened.
  HARDENING: ["COMPLETE", "BUILDING", "PAUSED", "CANCELLED"],
  COMPLETE: [],
  PAUSED: ["PROPOSED", "SEEDED", "PLANNED", "BUILDING", "MILESTONE_REVIEW", "HARDENING", "CANCELLED"],
  CANCELLED: ["PROPOSED"],
};

/** Every legal status, in lifecycle order. */
export const ALL_PROGRAMME_STATUSES = Object.keys(TRANSITIONS) as ProgrammeStatus[];

export class InvalidProgrammeTransitionError extends Error {
  constructor(from: ProgrammeStatus, to: ProgrammeStatus) {
    super(`Invalid programme transition: ${from} -> ${to}`);
    this.name = "InvalidProgrammeTransitionError";
  }
}

/**
 * Purely functional, matching `WorkItemStateMachine`: callers hold the
 * current status and ask whether a move is legal before persisting it, which
 * keeps the advance scheduler job idempotent and safe to retry.
 */
export class ProgrammeStateMachine {
  canTransition(from: ProgrammeStatus, to: ProgrammeStatus): boolean {
    // Same-state is a legal no-op so a re-run that finds the move already
    // applied simply does nothing, rather than throwing.
    if (from === to) {
      return ALL_PROGRAMME_STATUSES.includes(from);
    }
    return TRANSITIONS[from]?.includes(to) ?? false;
  }

  assertTransition(from: ProgrammeStatus, to: ProgrammeStatus): void {
    if (!this.canTransition(from, to)) {
      throw new InvalidProgrammeTransitionError(from, to);
    }
  }

  nextStates(from: ProgrammeStatus): ProgrammeStatus[] {
    return TRANSITIONS[from] ?? [];
  }

  isTerminal(status: ProgrammeStatus): boolean {
    return status === "COMPLETE" || status === "CANCELLED";
  }
}
