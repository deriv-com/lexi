import { describe, it, expect } from "vitest";
import {
  decideEscalation,
  idleHoursSince,
  lastProgressAt,
  rungDueAt,
  type LadderStateSnapshot,
  type ProgressEvent,
} from "./escalation-ladder";
import { parseEscalationPolicy, type EscalationPolicy } from "./escalation-policy.schema";

/**
 * The ladder is deterministic code, not a model call. These tests pin
 * the rules that make it safe to run on a scheduler: it never re-notifies the
 * same rung twice, it stops dead on an acknowledgement, and it never walks
 * backwards.
 */

const NOW = new Date("2026-08-15T12:00:00.000Z");

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000);
}

function policy(overrides: Record<string, unknown> = {}): EscalationPolicy {
  return parseEscalationPolicy({
    version: "1.0.0",
    enabled: true,
    governance: { channelId: "C0TEST08", channelName: "#lexi_build" },
    ladder: [
      { rung: "PIC", afterHours: 24 },
      { rung: "TEAM_LEAD", afterHours: 72 },
      { rung: "MANAGER", afterHours: 120 },
      { rung: "GOVERNANCE", afterHours: 168 },
    ],
    acknowledgement: { stopOnReaction: true, stopOnThreadReply: true, dedupePerSubject: true },
    staleness: { excludeSelfWrites: true, selfActor: "lexi", minIdleHours: 24 },
    reminders: { scheduleCron: "0 9 * * 1-5", maxPerSubjectPerDay: 1 },
    stalePr: { nudgeAfterDays: 7, autoCloseEnabled: false },
    ...overrides,
  });
}

function state(overrides: Partial<LadderStateSnapshot> = {}): LadderStateSnapshot {
  return {
    rung: null,
    lastNotifiedAt: null,
    ackedAt: null,
    ackedBy: null,
    notifyCount: 0,
    ...overrides,
  };
}

describe("rungDueAt", () => {
  it("returns no rung below the first threshold", () => {
    expect(rungDueAt(23.9, policy())).toBeNull();
  });

  it("returns the highest rung whose threshold has elapsed", () => {
    expect(rungDueAt(24, policy())).toBe("PIC");
    expect(rungDueAt(71, policy())).toBe("PIC");
    expect(rungDueAt(72, policy())).toBe("TEAM_LEAD");
    expect(rungDueAt(150, policy())).toBe("MANAGER");
    expect(rungDueAt(168, policy())).toBe("GOVERNANCE");
  });

  it("stays at GOVERNANCE forever — the ladder has no rung above it", () => {
    expect(rungDueAt(10_000, policy())).toBe("GOVERNANCE");
  });
});

describe("decideEscalation", () => {
  it("does nothing when the policy is disabled", () => {
    const decision = decideEscalation({
      state: state(),
      idleHours: 200,
      now: NOW,
      policy: policy({ enabled: false }),
    });

    expect(decision.action).toBe("none");
    expect(decision.reason).toBe("policy_disabled");
  });

  it("escalates to the first rung once the subject is idle past its threshold", () => {
    const decision = decideEscalation({ state: state(), idleHours: 25, now: NOW, policy: policy() });

    expect(decision.action).toBe("escalate");
    expect(decision.rung).toBe("PIC");
    expect(decision.previousRung).toBeNull();
  });

  it("does nothing while the subject is fresh", () => {
    const decision = decideEscalation({ state: state(), idleHours: 3, now: NOW, policy: policy() });

    expect(decision.action).toBe("none");
    expect(decision.reason).toBe("not_stale");
  });

  it("respects staleness.minIdleHours even when a rung threshold is lower", () => {
    const p = policy({
      ladder: [{ rung: "PIC", afterHours: 1 }],
      staleness: { excludeSelfWrites: true, selfActor: "lexi", minIdleHours: 24 },
    });
    const decision = decideEscalation({ state: state(), idleHours: 5, now: NOW, policy: p });

    expect(decision.action).toBe("none");
    expect(decision.reason).toBe("not_stale");
  });

  // The whole point of persisting rung state: a sweep that runs every tick
  // must not DM the assignee every tick.
  it("does not re-notify a rung it has already notified", () => {
    const decision = decideEscalation({
      state: state({ rung: "PIC", lastNotifiedAt: hoursAgo(30), notifyCount: 1 }),
      idleHours: 60,
      now: NOW,
      policy: policy(),
    });

    expect(decision.action).toBe("none");
    expect(decision.reason).toBe("already_notified_at_rung");
  });

  it("advances to the next rung when its threshold passes", () => {
    const decision = decideEscalation({
      state: state({ rung: "PIC", lastNotifiedAt: hoursAgo(48), notifyCount: 1 }),
      idleHours: 73,
      now: NOW,
      policy: policy(),
    });

    expect(decision.action).toBe("escalate");
    expect(decision.rung).toBe("TEAM_LEAD");
    expect(decision.previousRung).toBe("PIC");
  });

  it("never walks back down the ladder", () => {
    const decision = decideEscalation({
      state: state({ rung: "MANAGER", lastNotifiedAt: hoursAgo(48), notifyCount: 3 }),
      idleHours: 30,
      now: NOW,
      policy: policy(),
    });

    expect(decision.action).toBe("none");
    expect(decision.reason).toBe("already_notified_at_rung");
  });

  it("stops the ladder once the subject is acknowledged", () => {
    const decision = decideEscalation({
      state: state({ rung: "PIC", lastNotifiedAt: hoursAgo(100), ackedAt: hoursAgo(90), ackedBy: "U123", notifyCount: 1 }),
      idleHours: 200,
      now: NOW,
      policy: policy(),
    });

    expect(decision.action).toBe("none");
    expect(decision.reason).toBe("acknowledged");
  });

  it("keeps the ladder stopped at the terminal rung — GOVERNANCE never repeats", () => {
    const decision = decideEscalation({
      state: state({ rung: "GOVERNANCE", lastNotifiedAt: hoursAgo(500), notifyCount: 4 }),
      idleHours: 5_000,
      now: NOW,
      policy: policy(),
    });

    expect(decision.action).toBe("none");
    expect(decision.reason).toBe("already_notified_at_rung");
  });

  it("rate-limits a subject to maxPerSubjectPerDay notifications", () => {
    const decision = decideEscalation({
      state: state({ rung: "PIC", lastNotifiedAt: hoursAgo(2), notifyCount: 1 }),
      idleHours: 80,
      now: NOW,
      policy: policy(),
    });

    expect(decision.action).toBe("none");
    expect(decision.reason).toBe("rate_limited");
  });

  it("allows a second notification the same day when the cap permits it", () => {
    const decision = decideEscalation({
      state: state({ rung: "PIC", lastNotifiedAt: hoursAgo(13), notifyCount: 1 }),
      idleHours: 80,
      now: NOW,
      policy: policy({ reminders: { scheduleCron: "0 9 * * 1-5", maxPerSubjectPerDay: 2 } }),
    });

    expect(decision.action).toBe("escalate");
    expect(decision.rung).toBe("TEAM_LEAD");
  });

  it("skips straight to the due rung when a subject goes stale between sweeps", () => {
    const decision = decideEscalation({ state: state(), idleHours: 400, now: NOW, policy: policy() });

    expect(decision.action).toBe("escalate");
    expect(decision.rung).toBe("GOVERNANCE");
  });

  it("treats a missing state row as never notified", () => {
    const decision = decideEscalation({ state: null, idleHours: 30, now: NOW, policy: policy() });

    expect(decision.action).toBe("escalate");
    expect(decision.rung).toBe("PIC");
  });
});

describe("staleness — Lexi's own writes are not progress", () => {
  const events: ProgressEvent[] = [
    { actor: "alice", at: hoursAgo(50) },
    { actor: "lexi", at: hoursAgo(2) },
  ];

  it("ignores the self actor when excludeSelfWrites is on", () => {
    expect(lastProgressAt(events, policy())).toEqual(hoursAgo(50));
  });

  it("counts every actor when excludeSelfWrites is off", () => {
    const p = policy({ staleness: { excludeSelfWrites: false, selfActor: "lexi", minIdleHours: 24 } });

    expect(lastProgressAt(events, p)).toEqual(hoursAgo(2));
  });

  it("matches the self actor case-insensitively", () => {
    const shouty: ProgressEvent[] = [{ actor: "alice", at: hoursAgo(50) }, { actor: "LEXI", at: hoursAgo(1) }];

    expect(lastProgressAt(shouty, policy())).toEqual(hoursAgo(50));
  });

  it("returns null when every event is a self write", () => {
    expect(lastProgressAt([{ actor: "lexi", at: hoursAgo(1) }], policy())).toBeNull();
  });

  // The regression this guards: Lexi's own reminder resets the clock it was
  // measuring, so a stalled subject looks fresh and the ladder never advances.
  it("does not let a Lexi write reset the escalation clock", () => {
    const excluding = policy();
    const including = policy({
      staleness: { excludeSelfWrites: false, selfActor: "lexi", minIdleHours: 24 },
    });

    const stale = decideEscalation({
      state: state(),
      idleHours: idleHoursSince(lastProgressAt(events, excluding), NOW, hoursAgo(200)),
      now: NOW,
      policy: excluding,
    });
    const reset = decideEscalation({
      state: state(),
      idleHours: idleHoursSince(lastProgressAt(events, including), NOW, hoursAgo(200)),
      now: NOW,
      policy: including,
    });

    expect(stale.action).toBe("escalate");
    expect(stale.rung).toBe("PIC");
    // Same subject, same events — counting Lexi's own write makes it look fresh.
    expect(reset.action).toBe("none");
    expect(reset.reason).toBe("not_stale");
  });

  it("falls back to the subject's creation time when there is no progress at all", () => {
    expect(idleHoursSince(null, NOW, hoursAgo(96))).toBe(96);
  });

  it("measures idle hours from the last real progress event", () => {
    expect(idleHoursSince(hoursAgo(30), NOW, hoursAgo(96))).toBe(30);
  });
});
