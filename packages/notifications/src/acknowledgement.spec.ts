import { describe, it, expect } from "vitest";
import { findAcknowledgement, isAcknowledgement, type AckCandidate } from "./acknowledgement";
import { parseEscalationPolicy, type EscalationPolicy } from "./escalation-policy.schema";

/**
 * "A reaction or a reply from the assignee stops the ladder".
 *
 * The rules that matter here are about *who* and *what kind*: Lexi reacting to
 * its own escalation is not an acknowledgement, and neither is a bystander
 * emoji from someone with no responsibility for the work.
 */

const NOW = new Date("2026-08-15T12:00:00.000Z");

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000);
}

function policy(ack: Record<string, unknown> = {}): EscalationPolicy {
  return parseEscalationPolicy({
    version: "1.0.0",
    enabled: true,
    governance: { channelId: "C0TEST08", channelName: "#lexi_build" },
    ladder: [
      { rung: "PIC", afterHours: 24 },
      { rung: "GOVERNANCE", afterHours: 168 },
    ],
    acknowledgement: { stopOnReaction: true, stopOnThreadReply: true, dedupePerSubject: true, ...ack },
    staleness: { excludeSelfWrites: true, selfActor: "lexi", minIdleHours: 24 },
    reminders: { scheduleCron: "0 9 * * 1-5", maxPerSubjectPerDay: 1 },
    stalePr: { nudgeAfterDays: 7, autoCloseEnabled: false },
  });
}

const acknowledgers = ["U_ALICE", "alice-gh"];

describe("isAcknowledgement", () => {
  it("accepts a reaction from an acknowledger", () => {
    const event: AckCandidate = { kind: "reaction", actor: "U_ALICE", at: hoursAgo(1) };

    expect(isAcknowledgement(event, { acknowledgers, policy: policy() })).toBe(true);
  });

  it("accepts a thread reply from an acknowledger", () => {
    const event: AckCandidate = { kind: "reply", actor: "alice-gh", at: hoursAgo(1) };

    expect(isAcknowledgement(event, { acknowledgers, policy: policy() })).toBe(true);
  });

  it("matches acknowledger identities case-insensitively", () => {
    const event: AckCandidate = { kind: "reply", actor: "Alice-GH", at: hoursAgo(1) };

    expect(isAcknowledgement(event, { acknowledgers, policy: policy() })).toBe(true);
  });

  it("rejects a reaction from someone with no responsibility for the work", () => {
    const event: AckCandidate = { kind: "reaction", actor: "U_BYSTANDER", at: hoursAgo(1) };

    expect(isAcknowledgement(event, { acknowledgers, policy: policy() })).toBe(false);
  });

  // Lexi posts the escalation; Lexi reacting to it is not a human picking it up.
  it("never treats Lexi's own activity as an acknowledgement", () => {
    const event: AckCandidate = { kind: "reply", actor: "lexi", at: hoursAgo(1) };

    expect(isAcknowledgement(event, { acknowledgers: [...acknowledgers, "lexi"], policy: policy() })).toBe(false);
  });

  it("ignores reactions when stopOnReaction is off", () => {
    const event: AckCandidate = { kind: "reaction", actor: "U_ALICE", at: hoursAgo(1) };

    expect(isAcknowledgement(event, { acknowledgers, policy: policy({ stopOnReaction: false }) })).toBe(false);
  });

  it("ignores replies when stopOnThreadReply is off", () => {
    const event: AckCandidate = { kind: "reply", actor: "U_ALICE", at: hoursAgo(1) };

    expect(isAcknowledgement(event, { acknowledgers, policy: policy({ stopOnThreadReply: false }) })).toBe(false);
  });

  it("ignores an ack that predates the escalation it supposedly answers", () => {
    const event: AckCandidate = { kind: "reply", actor: "U_ALICE", at: hoursAgo(10) };

    expect(
      isAcknowledgement(event, { acknowledgers, policy: policy(), notifiedAt: hoursAgo(5) }),
    ).toBe(false);
  });

  it("accepts an ack that follows the escalation", () => {
    const event: AckCandidate = { kind: "reply", actor: "U_ALICE", at: hoursAgo(2) };

    expect(
      isAcknowledgement(event, { acknowledgers, policy: policy(), notifiedAt: hoursAgo(5) }),
    ).toBe(true);
  });
});

describe("findAcknowledgement", () => {
  it("returns the earliest qualifying ack so ackedAt records when work was picked up", () => {
    const events: AckCandidate[] = [
      { kind: "reaction", actor: "U_BYSTANDER", at: hoursAgo(9) },
      { kind: "reply", actor: "U_ALICE", at: hoursAgo(4) },
      { kind: "reaction", actor: "alice-gh", at: hoursAgo(6) },
    ];

    const ack = findAcknowledgement(events, { acknowledgers, policy: policy() });

    expect(ack).not.toBeNull();
    expect(ack?.ackedAt).toEqual(hoursAgo(6));
    expect(ack?.ackedBy).toBe("alice-gh");
  });

  it("returns null when nothing qualifies", () => {
    const events: AckCandidate[] = [
      { kind: "reaction", actor: "lexi", at: hoursAgo(1) },
      { kind: "reaction", actor: "U_BYSTANDER", at: hoursAgo(2) },
    ];

    expect(findAcknowledgement(events, { acknowledgers, policy: policy() })).toBeNull();
  });

  it("returns null for an empty event list", () => {
    expect(findAcknowledgement([], { acknowledgers, policy: policy() })).toBeNull();
  });
});

describe("isAcknowledgement — automation cannot acknowledge", () => {
  // `selfActor` may not match the installed App's login, in which case the
  // self-exclusion matches nothing and the acknowledgers list is the only
  // remaining guard.
  //
  // An App must not be able to stop the ladder even if its login is somehow in
  // the acknowledgers list — an automated comment is not someone picking the
  // work up, and treating it as one silences the chase permanently.
  const ctx = (acknowledgers: string[]) => ({
    policy: {
      acknowledgement: { stopOnReaction: true, stopOnThreadReply: true },
      staleness: { excludeSelfWrites: true, selfActor: "acme-triage-app", minIdleHours: 24 },
    },
    acknowledgers,
    notifiedAt: undefined,
  }) as never;

  const at = new Date("2026-08-16T12:00:00Z");

  it("refuses an App even when it appears in the acknowledgers list", () => {
    const acked = isAcknowledgement(
      { kind: "reply", actor: "acme-triage-app[bot]", at } as never,
      ctx(["acme-triage-app[bot]", "bob"]),
    );

    expect(acked).toBe(false);
  });

  it("refuses a third-party App on the same rule", () => {
    const acked = isAcknowledgement(
      { kind: "reply", actor: "acme-github-app[bot]", at } as never,
      ctx(["acme-github-app[bot]"]),
    );

    expect(acked).toBe(false);
  });

  it("still accepts a real person", () => {
    const acked = isAcknowledgement({ kind: "reply", actor: "bob", at } as never, ctx(["bob"]));

    expect(acked).toBe(true);
  });

  it("does not refuse a person whose name merely contains 'bot'", () => {
    const acked = isAcknowledgement({ kind: "reply", actor: "abbot", at } as never, ctx(["abbot"]));

    expect(acked).toBe(true);
  });
});
