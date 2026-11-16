import type { EscalationPolicy, EscalationRung } from "./escalation-policy.schema";

/**
 * The escalation ladder's decision function.
 *
 * Rung selection is **deterministic code, zero model calls**: given a
 * subject's persisted ladder state and how long it has been idle, exactly one
 * rung is due, and it is computable by comparing numbers. Nothing here needs
 * judgement, so nothing here asks a model.
 *
 * Everything in this module is pure. The service that owns the Prisma row and
 * the Slack client calls `decideEscalation` and acts on the answer; keeping
 * the rules pure is what makes the sweep's behaviour testable without a
 * database, a clock, or a Slack workspace.
 *
 * ## Why "reminder" is not a separate stage
 *
 * The ladder is often described as "reminder -> ... -> governance". The reminder and
 * the first rung are the same act: the reminder a stalled subject gets *is*
 * the message tagging its PIC. Modelling reminder as a distinct pre-rung would
 * have produced a stage that, under the shipped config
 * (`staleness.minIdleHours: 24` and `PIC.afterHours: 24`) could never
 * fire — a dead branch dressed up as a feature. So the ladder is exactly the
 * rungs in config, `staleness.minIdleHours` is an independent floor below
 * which nothing fires at all, and `reminders.maxPerSubjectPerDay` caps how
 * often any one subject can be notified.
 */

/** The persisted `EscalationLadderState` row, narrowed to what the rules read. */
export interface LadderStateSnapshot {
  /** Last rung this subject was notified at, or null if it never has been. */
  rung: string | null;
  lastNotifiedAt: Date | null;
  ackedAt: Date | null;
  ackedBy: string | null;
  notifyCount: number;
}

export interface EscalationInput {
  /** Null when no row exists yet — the subject has never been escalated. */
  state: LadderStateSnapshot | null;
  /** Hours since the last *real* progress — see `idleHoursSince`. */
  idleHours: number;
  now: Date;
  policy: EscalationPolicy;
}

export type EscalationSkipReason =
  | "policy_disabled"
  | "acknowledged"
  | "not_stale"
  | "already_notified_at_rung"
  | "rate_limited";

export type EscalationDecision =
  | { action: "none"; rung: null; previousRung: EscalationRung | null; reason: EscalationSkipReason }
  | { action: "escalate"; rung: EscalationRung; previousRung: EscalationRung | null; reason: null };

const MS_PER_HOUR = 60 * 60 * 1000;
const HOURS_PER_DAY = 24;

/**
 * The rung due for a subject idle `idleHours` hours: the last rung in the
 * ladder whose threshold has elapsed, or null below the first threshold.
 *
 * The ladder is validated as strictly increasing at load time, so a linear
 * walk is unambiguous and there is no rung above the terminal one — a subject
 * idle for a year is at GOVERNANCE, not off the end of the array.
 */
export function rungDueAt(idleHours: number, policy: EscalationPolicy): EscalationRung | null {
  let due: EscalationRung | null = null;

  for (const step of policy.ladder) {
    if (idleHours >= step.afterHours) {
      due = step.rung;
    }
  }

  return due;
}

/** Position of a rung in the configured ladder; -1 when it is not configured. */
function rungIndex(rung: string | null, policy: EscalationPolicy): number {
  if (!rung) return -1;
  return policy.ladder.findIndex((step) => step.rung === rung);
}

/**
 * Decides what — if anything — to do for one subject on one sweep.
 *
 * The guards are ordered by how strongly they bind, so the reported reason is
 * the most informative true one: a disabled policy is reported as disabled
 * even for an acknowledged subject, and an acknowledged subject is reported as
 * acknowledged rather than as rate-limited.
 */
export function decideEscalation(input: EscalationInput): EscalationDecision {
  const { state, idleHours, now, policy } = input;
  const previousRung = (rungIndex(state?.rung ?? null, policy) >= 0
    ? (state?.rung as EscalationRung)
    : null) as EscalationRung | null;

  const skip = (reason: EscalationSkipReason): EscalationDecision => ({
    action: "none",
    rung: null,
    previousRung,
    reason,
  });

  if (!policy.enabled) {
    return skip("policy_disabled");
  }

  // An ack — a reaction or a reply from the assignee — stops the ladder
  // permanently for this subject. Progress is now someone's explicit problem;
  // continuing to climb would escalate work that a human has already picked up.
  if (state?.ackedAt) {
    return skip("acknowledged");
  }

  // Independent floor: a subject younger than minIdleHours is never escalated,
  // whatever the ladder's own first threshold says.
  if (idleHours < policy.staleness.minIdleHours) {
    return skip("not_stale");
  }

  const due = rungDueAt(idleHours, policy);
  if (!due) {
    return skip("not_stale");
  }

  // Per-subject dedup. Without this the sweep re-sends the same rung on
  // every tick, since "idle for 30 hours" stays true for the next 100 sweeps.
  // Comparing by ladder position rather than equality also means the ladder
  // never walks backwards: a subject already at MANAGER is not re-notified at
  // PIC because a progress event reset its idle clock.
  const dueIndex = rungIndex(due, policy);
  const currentIndex = rungIndex(state?.rung ?? null, policy);
  if (policy.acknowledgement.dedupePerSubject && currentIndex >= dueIndex) {
    return skip("already_notified_at_rung");
  }

  // Rate limit, independent of which rung is due: a subject that crosses two
  // thresholds in quick succession still gets at most maxPerSubjectPerDay
  // notifications.
  const minGapHours = HOURS_PER_DAY / policy.reminders.maxPerSubjectPerDay;
  if (state?.lastNotifiedAt) {
    const sinceLastHours = (now.getTime() - state.lastNotifiedAt.getTime()) / MS_PER_HOUR;
    if (sinceLastHours < minGapHours) {
      return skip("rate_limited");
    }
  }

  return { action: "escalate", rung: due, previousRung, reason: null };
}

/** One write against a subject — a comment, a commit, a status change. */
export interface ProgressEvent {
  /** Whoever performed it: a GitHub login, Slack id, or "lexi" for our own writes. */
  actor: string;
  at: Date;
}

/**
 * The most recent event that counts as progress, or null if none does.
 *
 * `staleness.excludeSelfWrites` is what makes escalation honest: Lexi's own
 * reminder is a write against the subject, and counting it would reset the
 * very clock the reminder was measuring — the subject would look fresh
 * moments after being nudged and would never climb past its first rung.
 * Matching is case-insensitive because the actor arrives from GitHub, Slack,
 * and our own writes, which do not agree on casing.
 */
export function lastProgressAt(events: readonly ProgressEvent[], policy: EscalationPolicy): Date | null {
  const selfActor = policy.staleness.selfActor.toLowerCase();

  const counted = events.filter(
    (event) => !policy.staleness.excludeSelfWrites || event.actor.toLowerCase() !== selfActor,
  );
  if (counted.length === 0) {
    return null;
  }

  return counted.reduce((latest, event) => (event.at > latest.at ? event : latest)).at;
}

/**
 * Hours of idleness, measuring from the last real progress event — or, when a
 * subject has never had one, from when it was created. Falling back to
 * creation matters: a subject nobody has ever touched is the most stalled kind
 * there is, and treating "no progress events" as "no idle time" would exempt
 * exactly those from the ladder.
 */
export function idleHoursSince(lastProgress: Date | null, now: Date, createdAt: Date): number {
  const from = lastProgress ?? createdAt;
  return (now.getTime() - from.getTime()) / MS_PER_HOUR;
}
