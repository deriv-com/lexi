/**
 * Attempt accounting: which failures are allowed to spend a task's build
 * budget, and which are not.
 *
 * `BuildTask.attempts` is capped by `dispatch.maxTaskAttempts` so that a task
 * whose BUILD keeps failing eventually stops retrying. A failure that never
 * reached the coding agent tests nothing about the build, so charging it to
 * that budget spends retries on plumbing.
 *
 * A task can exhaust its whole budget without the agent running once: a
 * dispatch against a workflow file the repository has renamed, followed by a
 * brief fetch refused with a 401, spends every attempt and leaves the task
 * unretryable until someone resets the counter by hand.
 *
 * The original reasoning for charging them was still half right — a
 * permanently broken repository must terminate rather than retry forever — so
 * infrastructure faults are not free. They get their own bounded budget
 * (`dispatch.maxInfraFaults`); once that is gone, faults are charged to the
 * build budget exactly as before and the task dies as it used to.
 */

/**
 * The one handback the runner emits BEFORE starting the agent.
 *
 * `programme-build.yml` writes `HANDBACK_REASON=brief refused: <reason>` and its
 * own log line says "handing back without running the agent". Every other
 * reason it can emit — RED/GREEN-phase agent errors, "RED phase produced no
 * changes", "tests still failing after GREEN phase" — happens with the agent
 * having run, and those correctly consume a build attempt.
 *
 * Matching a string is not ideal; the honest fix is a structured field on
 * the build result, which needs a new version of the reusable workflow.
 * Until then this is the vocabulary actually on the wire, and an unrecognised
 * reason fails SAFE: it is treated as a real build attempt, which is the
 * behaviour that shipped before this existed.
 */
export function isPreAgentHandback(reason: string | null | undefined): boolean {
  if (typeof reason !== "string") return false;
  return /^\s*brief refused:/i.test(reason);
}

/** A runner stage whose failure is the plumbing around the agent, not its build. */
export interface InfrastructureStage {
  /** What the run was doing, for a review post: "run N failed while <label>". */
  label: string;
  /** What that cost, for the same post: "…, <consequence>. Re-armed …". */
  consequence: string;
}

/**
 * The runner stages whose failure says nothing about the build.
 *
 * `programme-build.yml` sets `LEXI_STAGE=<stage>` on each step, and a failed run
 * reports `the run failed during <stage>; see the job log`. Both entries are
 * the same race — a freshly minted App installation token refused for a
 * moment while GitHub propagates it:
 *
 * - `pushing the branch and opening the PR` — the push lands a fraction of a
 *   second after minting and gets "Repository not found", after the agent
 *   has finished and its tests are green.
 * - `checking out the UI source to port from` — the clone of the source
 *   repository is refused the same way, before the agent starts.
 *
 * Each would otherwise come back FAILED, which no automatic path re-arms, so
 * the milestone would wait on a person calling retry_build_task.
 *
 * Deliberately a short list of named stages rather than "anything but the
 * agent's own phases": a stage is added only once it is known to fail for
 * reasons outside the build. Same string-match caveat as
 * {@link isPreAgentHandback}: an unrecognised reason fails safe and is charged
 * as a real attempt. The stage texts are owned by the reusable build workflow,
 * so renaming one silently turns its entry off; the contract is recorded in
 * docs/programme-contract.md.
 */
const INFRASTRUCTURE_STAGES: ReadonlyArray<{ pattern: RegExp } & InfrastructureStage> = [
  {
    pattern: /^\s*the run failed during pushing the branch/i,
    label: "pushing the branch or opening the PR",
    consequence: "so its work never reached a PR",
  },
  {
    pattern: /^\s*the run failed during checking out the UI source/i,
    label: "checking out the UI source",
    consequence: "so the agent never started",
  },
];

/** The infrastructure stage a failed run's reason names, or null for any other reason. */
export function infrastructureStageOf(reason: string | null | undefined): InfrastructureStage | null {
  if (typeof reason !== "string") return null;
  const stage = INFRASTRUCTURE_STAGES.find((entry) => entry.pattern.test(reason));
  return stage ? { label: stage.label, consequence: stage.consequence } : null;
}

export interface AttemptRefund {
  /** What `attempts` should be set back to. */
  attempts: number;
  /** Infrastructure faults consumed so far, including this one. */
  infraFaults: number;
}

/**
 * Decide whether an infrastructure fault gives its attempt back.
 *
 * `storedAttempts` is the value currently persisted — already incremented by
 * the dispatch that is now failing. Returns null when the refund is refused,
 * in which case the caller leaves the counter alone and the task burns the
 * attempt as it did before.
 */
export function refundForInfraFault(input: {
  storedAttempts: number;
  priorInfraFaults: number;
  maxInfraFaults: number;
}): AttemptRefund | null {
  const { storedAttempts, priorInfraFaults, maxInfraFaults } = input;
  if (priorInfraFaults >= maxInfraFaults) return null;
  return {
    attempts: Math.max(0, storedAttempts - 1),
    infraFaults: priorInfraFaults + 1,
  };
}

export interface ConflictRefund {
  /** What `attempts` should be set back to. */
  attempts: number;
  /** Conflict re-arms consumed so far, including this one. */
  conflictRearms: number;
}

/**
 * Decide whether a merge-conflict re-arm gives its attempt back.
 *
 * A PR that conflicts with its base tests nothing about the build. The task
 * built correctly, opened a PR and went green; then a SIBLING task merged
 * first and moved the base underneath it. Charging that to `maxTaskAttempts`
 * spends a task's build budget on its neighbours' success — the same mistake
 * as charging plumbing faults, and it gets worse the better the programme is
 * doing, because every merge invalidates every PR still open.
 *
 * With a dozen screen PRs open against one working branch, every merge
 * re-arms every other open PR. Charged to the build budget, the tail tasks
 * reach the cap and strand waiting for a human long before their turn to
 * merge.
 *
 * Bounded rather than free, for the same reason infra faults are: a conflict
 * the runner genuinely cannot resolve must terminate instead of re-arming for
 * ever. The budget has to clear the worst honest case, which is one conflict
 * per sibling that merges ahead of the task — so it is sized against
 * milestone width, not against `maxTaskAttempts`. 0 restores the old
 * behaviour exactly.
 */
export function refundForMergeConflict(input: {
  storedAttempts: number;
  priorConflictRearms: number;
  maxConflictRearms: number;
}): ConflictRefund | null {
  const { storedAttempts, priorConflictRearms, maxConflictRearms } = input;
  if (priorConflictRearms >= maxConflictRearms) return null;
  return {
    attempts: Math.max(0, storedAttempts - 1),
    conflictRearms: priorConflictRearms + 1,
  };
}
