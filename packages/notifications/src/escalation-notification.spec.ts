import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderRungNotification,
  renderStuckReport,
  resolveRungTarget,
  type EscalationRecipients,
  type EscalationSubjectView,
  type StuckSubject,
} from "./escalation-notification";
import { loadEscalationPolicy, parseEscalationPolicy, type EscalationPolicy } from "./escalation-policy.schema";

/**
 * Routing and rendering for the ladder.
 *
 * Lexi has no DM scope, so the ladder escalates by *audience*, not by
 * destination: the first three rungs all post to the same platform team
 * channel and differ only in who is @-mentioned. The load-bearing assertions
 * here are therefore:
 *
 *   - the governance channel is read from policy, never a literal in
 *     TypeScript;
 *   - a rung whose person cannot be resolved falls *forward* to the next rung
 *     rather than silently dropping the escalation — a black-holed escalation
 *     is worse than a noisy one, because nobody learns the work is stuck;
 *   - a person who resolves but has no Slack id still gets named, because a
 *     bare GitHub login rendered into Slack mentions nobody while looking
 *     exactly like it did.
 */

const NOW = new Date("2026-08-15T12:00:00.000Z");
const GOVERNANCE_CHANNEL = "C0TEST07";

function policy(overrides: Record<string, unknown> = {}): EscalationPolicy {
  return parseEscalationPolicy({
    version: "1.0.0",
    enabled: true,
    governance: { channelId: GOVERNANCE_CHANNEL, channelName: "#lexi_build" },
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

const PIC = { githubLogin: "carol", slackId: "U_PIC", displayName: "Carol" };
const LEAD = { githubLogin: "bob", slackId: "U_LEAD", displayName: "Bob" };
const MANAGER = { githubLogin: "alice", slackId: "U_MGR", displayName: "Alice Sethi" };

const recipients: EscalationRecipients = {
  teamChannelId: "C_TEAM",
  pic: PIC,
  teamLead: LEAD,
  manager: MANAGER,
};

const subject: EscalationSubjectView = {
  subjectType: "issue",
  subjectId: "acme-internal/issues#123",
  title: "Deposit button broken",
  url: "https://github.com/acme-internal/issues/issues/123",
  idleHours: 75,
};

describe("resolveRungTarget", () => {
  it("posts to the team channel and tags the PIC at PIC", () => {
    const target = resolveRungTarget("PIC", recipients, policy());

    expect(target.channel).toBe("C_TEAM");
    expect(target.person).toEqual(PIC);
    expect(target.fellForward).toBe(false);
    expect(target.degraded).toBe(false);
  });

  it("posts to the SAME team channel and tags the lead at TEAM_LEAD", () => {
    const target = resolveRungTarget("TEAM_LEAD", recipients, policy());

    expect(target.channel).toBe("C_TEAM");
    expect(target.person).toEqual(LEAD);
  });

  it("posts to the SAME team channel and tags the manager at MANAGER", () => {
    const target = resolveRungTarget("MANAGER", recipients, policy());

    expect(target.channel).toBe("C_TEAM");
    expect(target.person).toEqual(MANAGER);
  });

  /**
   * The cumulative-pressure property, asserted directly. If a future change
   * routes a rung somewhere quieter, the escalation stops being visible to the
   * people who watched the previous rung go unanswered — which is the entire
   * mechanism.
   */
  it("lands every pre-governance rung in front of the same audience", () => {
    const channels = (["PIC", "TEAM_LEAD", "MANAGER"] as const).map(
      (rung) => resolveRungTarget(rung, recipients, policy()).channel,
    );

    expect(new Set(channels).size).toBe(1);
    expect(channels[0]).toBe("C_TEAM");
  });

  it("posts to the governance channel from config at GOVERNANCE", () => {
    const target = resolveRungTarget("GOVERNANCE", recipients, policy());

    expect(target.channel).toBe(GOVERNANCE_CHANNEL);
    expect(target.person).toBeNull();
  });

  it("reads the real governance channel out of the shipped config", () => {
    const shipped = loadEscalationPolicy(join(__dirname, "..", "..", "..", "examples", "config", "escalation-policy.yaml"));

    expect(resolveRungTarget("GOVERNANCE", {}, shipped).channel).toBe(shipped.governance.channelId);
  });

  describe("fall-forward", () => {
    it("advances to TEAM_LEAD when no PIC resolves", () => {
      const target = resolveRungTarget("PIC", { ...recipients, pic: null }, policy());

      expect(target.person).toEqual(LEAD);
      expect(target.deliveredRung).toBe("TEAM_LEAD");
      expect(target.fellForward).toBe(true);
    });

    it("persists the rung that was DUE, not the one it landed on", () => {
      const target = resolveRungTarget("PIC", { ...recipients, pic: null }, policy());

      // The subject reached PIC on the clock; recording TEAM_LEAD would skip a
      // rung permanently the moment the directory was repaired.
      expect(target.rung).toBe("PIC");
    });

    it("advances to MANAGER when the lead IS the PIC — nobody escalates to themselves", () => {
      const selfLed: EscalationRecipients = { ...recipients, pic: LEAD, teamLead: LEAD };
      const target = resolveRungTarget("TEAM_LEAD", selfLed, policy());

      expect(target.person).toEqual(MANAGER);
      expect(target.deliveredRung).toBe("MANAGER");
      expect(target.fellForward).toBe(true);
    });

    it("advances to governance when there is no team channel to post in", () => {
      const target = resolveRungTarget("PIC", { ...recipients, teamChannelId: null }, policy());

      expect(target.channel).toBe(GOVERNANCE_CHANNEL);
      expect(target.deliveredRung).toBe("GOVERNANCE");
      expect(target.fellForward).toBe(true);
    });

    it("falls all the way to governance when nothing resolves", () => {
      const target = resolveRungTarget("PIC", {}, policy());

      expect(target.channel).toBe(GOVERNANCE_CHANNEL);
      expect(target.fellForward).toBe(true);
      expect(target.rung).toBe("PIC");
    });

    it("never drops an escalation — every rung resolves to some channel", () => {
      for (const step of policy().ladder) {
        expect(resolveRungTarget(step.rung, {}, policy()).channel).toBe(GOVERNANCE_CHANNEL);
      }
    });

    it("never falls BACKWARDS to a rung the subject has already passed", () => {
      // No manager configured, so MANAGER cannot resolve. The only correct
      // answer is governance; re-tagging the PIC would be a demotion dressed
      // up as an escalation.
      const target = resolveRungTarget("MANAGER", { ...recipients, manager: null }, policy());

      expect(target.deliveredRung).toBe("GOVERNANCE");
      expect(target.person).toBeNull();
    });
  });

  describe("missing Slack id", () => {
    it("still targets a person who has a display name but no Slack id", () => {
      const noSlack = { githubLogin: "carol", displayName: "Carol" };
      const target = resolveRungTarget("PIC", { ...recipients, pic: noSlack }, policy());

      // Degraded, not unresolved: the message still names a human in their own
      // team's channel, which is most of the pressure. Falling forward on
      // every directory gap would escalate the whole backlog to the manager.
      expect(target.person).toEqual(noSlack);
      expect(target.fellForward).toBe(false);
      expect(target.degraded).toBe(true);
    });

    it("marks a person with a Slack id as not degraded", () => {
      expect(resolveRungTarget("PIC", recipients, policy()).degraded).toBe(false);
    });
  });
});

describe("renderRungNotification", () => {
  /** Render at a rung, routing through the real resolver. */
  function render(rung: Parameters<typeof resolveRungTarget>[0], to: EscalationRecipients = recipients, over: Partial<EscalationSubjectView> = {}) {
    return renderRungNotification({
      target: resolveRungTarget(rung, to, policy()),
      subject: { ...subject, ...over },
      policy: policy(),
      now: NOW,
    });
  }

  it("names the subject, its age and the rung", () => {
    const serialized = JSON.stringify(render("TEAM_LEAD").blocks);

    expect(serialized).toContain("Deposit button broken");
    expect(serialized).toContain("3 day");
    expect(render("TEAM_LEAD").text.length).toBeGreaterThan(0);
  });

  it("@-mentions the PIC at the PIC rung", () => {
    expect(JSON.stringify(render("PIC").blocks)).toContain("<@U_PIC>");
  });

  it("@-mentions the lead at the TEAM_LEAD rung", () => {
    expect(JSON.stringify(render("TEAM_LEAD").blocks)).toContain("<@U_LEAD>");
  });

  it("@-mentions the manager at the MANAGER rung", () => {
    expect(JSON.stringify(render("MANAGER").blocks)).toContain("<@U_MGR>");
  });

  it("escalates visibly — a later rung names the earlier rung's audience", () => {
    // The message has to say *why* a lead is being tagged, or it reads as a
    // fresh notification rather than as an escalation of an ignored one.
    const serialized = JSON.stringify(render("TEAM_LEAD").blocks).toLowerCase();

    expect(serialized).toMatch(/carol|escalat|unanswered|no response/);
  });

  describe("missing Slack id", () => {
    const noSlack: EscalationRecipients = {
      ...recipients,
      pic: { githubLogin: "carol", displayName: "Carol" },
    };

    it("falls back to the display name", () => {
      expect(JSON.stringify(render("PIC", noSlack).blocks)).toContain("Carol");
    });

    it("never renders a bare GitHub login as if it were a mention", () => {
      // `<@carol>` renders in Slack as a broken mention that pings
      // nobody while looking exactly like a working one.
      expect(JSON.stringify(render("PIC", noSlack).blocks)).not.toContain("<@carol>");
    });

    it("says out loud that the person was not actually notified", () => {
      const serialized = JSON.stringify(render("PIC", noSlack).blocks).toLowerCase();

      expect(serialized).toMatch(/not.*(notified|linked)|no slack/);
    });

    it("names the login so the directory gap is fixable from the message", () => {
      expect(JSON.stringify(render("PIC", noSlack).blocks)).toContain("carol");
    });
  });

  it("says what an acknowledgement is, so the recipient knows how to stop it", () => {
    expect(JSON.stringify(render("PIC").blocks).toLowerCase()).toMatch(/react|reply/);
  });

  it("explains at the governance rung that the ladder is exhausted", () => {
    expect(JSON.stringify(render("GOVERNANCE").blocks).toLowerCase()).toMatch(/no further|final|last/);
  });

  it("lists the PRs a subject is still waiting on when it has them", () => {
    const serialized = JSON.stringify(render("TEAM_LEAD", recipients, { pendingPrNumbers: [11, 12] }).blocks);

    expect(serialized).toContain("#11");
    expect(serialized).toContain("#12");
  });

  it("never hard-codes a channel id in its output", () => {
    expect(JSON.stringify(render("GOVERNANCE").blocks)).not.toContain("C0TEST06");
  });
});

describe("renderStuckReport — /lexi stuck", () => {
  const subjects: StuckSubject[] = [
    { ...subject, subjectId: "issue-1", title: "Oldest", idleHours: 400, rung: "GOVERNANCE" },
    { ...subject, subjectId: "issue-2", title: "Middle", idleHours: 100, rung: "TEAM_LEAD" },
    { ...subject, subjectId: "issue-3", title: "Newest", idleHours: 30, rung: "PIC" },
  ];

  it("lists every subject with its rung and its age", () => {
    const serialized = JSON.stringify(renderStuckReport(subjects, { policy: policy(), now: NOW }).blocks);

    expect(serialized).toContain("Oldest");
    expect(serialized).toContain("GOVERNANCE");
    expect(serialized).toContain("16 day");
  });

  it("orders the most stuck first", () => {
    const serialized = JSON.stringify(renderStuckReport(subjects, { policy: policy(), now: NOW }).blocks);

    expect(serialized.indexOf("Oldest")).toBeLessThan(serialized.indexOf("Middle"));
    expect(serialized.indexOf("Middle")).toBeLessThan(serialized.indexOf("Newest"));
  });

  it("says so plainly when nothing is past SLA", () => {
    const rendered = renderStuckReport([], { policy: policy(), now: NOW });

    expect(rendered.text.toLowerCase()).toMatch(/nothing|no .*past/);
    expect(rendered.blocks.length).toBeGreaterThan(0);
  });

  it("marks an acknowledged subject so it is not chased again", () => {
    const acked: StuckSubject[] = [{ ...subjects[0], ackedBy: "U_ALICE", ackedAt: NOW }];
    const serialized = JSON.stringify(renderStuckReport(acked, { policy: policy(), now: NOW }));

    expect(serialized.toLowerCase()).toMatch(/acknowledg/);
  });

  it("truncates a very long list rather than exceeding Slack's block limit", () => {
    const many: StuckSubject[] = Array.from({ length: 80 }, (_, index) => ({
      ...subject,
      subjectId: `issue-${index}`,
      title: `Subject ${index}`,
      idleHours: 100 + index,
      rung: "TEAM_LEAD" as const,
    }));

    const rendered = renderStuckReport(many, { policy: policy(), now: NOW });

    expect(rendered.blocks.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(rendered.blocks)).toContain("80");
  });

  it("reports a subject that has never been escalated as having no rung yet", () => {
    const never: StuckSubject[] = [{ ...subject, rung: null, idleHours: 26 }];
    const serialized = JSON.stringify(renderStuckReport(never, { policy: policy(), now: NOW }));

    expect(serialized.toLowerCase()).toMatch(/not yet|none/);
  });
});

describe("no TypeScript file names the governance channel", () => {
  it("keeps C0TEST06 out of this package's source", () => {
    for (const file of ["escalation-notification.ts", "escalation-ladder.ts", "escalation-policy.schema.ts"]) {
      expect(readFileSync(join(__dirname, file), "utf8")).not.toContain("C0TEST06");
    }
  });
});
