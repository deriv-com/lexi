import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ESCALATION_RUNGS,
  loadEscalationPolicy,
  parseEscalationPolicy,
} from "./escalation-policy.schema";

/**
 * Contract cover for config/escalation-policy.yaml.
 *
 * Three rules here are not style preferences, they are the reason this file
 * exists at all:
 *
 *   - the governance channel id lives in config and nowhere else — the audit
 *     flagged hard-coded channel ids in the dispatch path as debt, so the
 *     loader is the only way TypeScript learns the id;
 *   - every rung must have a resolver. Lexi holds no DM scope, so the original
 *     `ASSIGNEE_DM`/`LEAD_DM` rungs were unroutable: accepted at boot and
 *     escalating into a void at runtime. The ladder is now PIC -> TEAM_LEAD ->
 *     MANAGER -> GOVERNANCE, all of which land in a channel Lexi can post to,
 *     and the retired names are rejected rather than silently ignored;
 *   - `dryRun` defaults to true. The first sweep meets an entire backlog at
 *     once, so posting is the opt-in and reviewing is the default.
 */

const CONFIG_PATH = join(__dirname, "..", "..", "..", "examples", "config", "escalation-policy.yaml");

/** The shipped config, as the loader will actually see it in production. */
function shippedYaml(): string {
  return readFileSync(CONFIG_PATH, "utf8");
}

/** A minimal valid policy body, for mutation in the negative cases below. */
function validPolicy(): Record<string, unknown> {
  return {
    version: "1.0.0",
    enabled: false,
    dryRun: true,
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
  };
}

describe("escalation policy schema", () => {
  it("loads and validates the shipped config/escalation-policy.yaml", () => {
    const policy = loadEscalationPolicy(CONFIG_PATH);

    expect(policy.version).toBe("1.0.0");
    expect(policy.governance.channelId).toMatch(/^C[A-Z0-9]+$/);
    expect(policy.ladder.length).toBeGreaterThan(0);
  });

  it("cannot notify anyone from the committed config alone, whatever `enabled` says", () => {
    // Asserting `enabled === false` would pin a rollout MOMENT, not a
    // property: it would go red the day the capability legitimately went live
    // while saying nothing about whether anyone was about to be messaged.
    //
    // The durable safety property is the conjunction: `enabled` opens the
    // sweep, `reminders.dryRun` decides whether it speaks. Enabling the first
    // without clearing the second must remain inert, because that is exactly
    // the state used to compute a reviewable plan against production data.
    const policy = loadEscalationPolicy(CONFIG_PATH);

    expect(policy.enabled).toBeTypeOf("boolean");
    if (policy.enabled) {
      expect(
        policy.reminders.dryRun,
        "escalation is enabled, so reminders.dryRun is the only thing standing between a sweep and a channel full of pings",
      ).toBe(true);
    }
  });

  it("exposes the governance channel so no TypeScript file has to name it", () => {
    const policy = loadEscalationPolicy(CONFIG_PATH);
    const yaml = shippedYaml();

    expect(yaml).toContain(policy.governance.channelId);
    expect(policy.governance.channelName).toBe("#acme-governance");
  });

  it("terminates the shipped ladder at GOVERNANCE", () => {
    const policy = loadEscalationPolicy(CONFIG_PATH);
    const rungs = policy.ladder.map((step) => step.rung);

    expect(rungs[rungs.length - 1]).toBe("GOVERNANCE");
  });

  it("ships the person-escalating ladder, in order", () => {
    const rungs = loadEscalationPolicy(CONFIG_PATH).ladder.map((step) => step.rung);

    expect(rungs).toEqual(["PIC", "TEAM_LEAD", "MANAGER", "GOVERNANCE"]);
  });

  it("declares exactly the four supported rungs", () => {
    expect([...ESCALATION_RUNGS]).toEqual(["PIC", "TEAM_LEAD", "MANAGER", "GOVERNANCE"]);
  });

  it.each(["ASSIGNEE_DM", "LEAD_DM", "MANAGER_DM"])(
    "rejects the retired DM rung %s — Lexi holds no DM scope",
    (retired) => {
      const policy = validPolicy();
      (policy.ladder as Array<{ rung: string }>)[0].rung = retired;

      expect(() => parseEscalationPolicy(policy)).toThrow(/DM|rung/i);
    },
  );

  it("names the replacement when a retired rung is configured", () => {
    const policy = validPolicy();
    (policy.ladder as Array<{ rung: string }>)[0].rung = "ASSIGNEE_DM";

    // A rename is only safe if the error tells the operator what to write
    // instead; "invalid enum value" would send them to the source to find out.
    expect(() => parseEscalationPolicy(policy)).toThrow(/PIC/);
  });

  it("rejects a ladder whose thresholds do not strictly increase", () => {
    const policy = validPolicy();
    (policy.ladder as Array<{ afterHours: number }>)[2].afterHours = 72;

    expect(() => parseEscalationPolicy(policy)).toThrow(/increas/i);
  });

  it("rejects a duplicated rung", () => {
    const policy = validPolicy();
    (policy.ladder as Array<{ rung: string }>)[2].rung = "TEAM_LEAD";

    expect(() => parseEscalationPolicy(policy)).toThrow(/duplicat/i);
  });

  it("rejects stalePr.autoCloseEnabled: true — PR closing is a permanent non-goal", () => {
    const policy = validPolicy();
    (policy.stalePr as { autoCloseEnabled: boolean }).autoCloseEnabled = true;

    expect(() => parseEscalationPolicy(policy)).toThrow(/auto-close|autoClose/i);
  });

  it("rejects a policy with no governance channel", () => {
    const policy = validPolicy();
    delete (policy as { governance?: unknown }).governance;

    expect(() => parseEscalationPolicy(policy)).toThrow(/governance/i);
  });

  it("rejects an empty ladder — a ladder with no rungs escalates nowhere", () => {
    const policy = validPolicy();
    policy.ladder = [];

    expect(() => parseEscalationPolicy(policy)).toThrow();
  });

  it("reports the offending path when validation fails", () => {
    const policy = validPolicy();
    (policy.governance as { channelId: unknown }).channelId = 42;

    expect(() => parseEscalationPolicy(policy)).toThrow(/governance\.channelId/);
  });

  it("defaults enabled to false when the key is absent", () => {
    const policy = validPolicy();
    delete (policy as { enabled?: unknown }).enabled;

    expect(parseEscalationPolicy(policy).enabled).toBe(false);
  });

  /**
   * Dry-run is the *default*, not an opt-in. An operator who forgets the key
   * gets a reviewable plan; an operator who wants traffic has to say so in
   * writing. The first sweep meets the whole backlog at once, so the failure
   * mode of the opposite default is "everyone is pinged about everything".
   */
  describe("dry run", () => {
    it("defaults dryRun to true when the key is absent", () => {
      const policy = validPolicy();
      delete (policy as { dryRun?: unknown }).dryRun;

      expect(parseEscalationPolicy(policy).dryRun).toBe(true);
    });

    it("cannot escalate from the committed config alone, whatever `enabled` says", () => {
      // Was `expect(...dryRun).toBe(true)`, which pinned a rollout moment: it
      // goes red the day the ladder legitimately goes live and says nothing
      // about safety in the meantime. The durable rule is the conjunction —
      // `enabled` opens the sweep, `dryRun` decides whether it speaks.
      const policy = loadEscalationPolicy(CONFIG_PATH);

      expect(policy.enabled).toBeTypeOf("boolean");
      if (policy.enabled) {
        expect(
          policy.dryRun,
          "the ladder is enabled, so dryRun is all that stands between a sweep and a channel full of pings",
        ).toBe(true);
      }
    });

    it("allows dryRun: false once an operator has reviewed a plan", () => {
      const policy = { ...validPolicy(), dryRun: false };

      expect(parseEscalationPolicy(policy).dryRun).toBe(false);
    });
  });
});

/**
 * The progress-check half of escalation.
 *
 * `PROGRESS_CHECK_ENABLED` drives `ProgressCheckService`, not just the
 * escalation ladder, and that service posts reminders and escalations into
 * the platform team channels tagging real people. Its policy is carried by
 * the `reminders` block here — the block that already describes this exact
 * standalone job — rather than by a new config file competing with it.
 *
 * Both keys default safe, and the defaults are asserted twice on purpose:
 * once as a schema default (the key omitted entirely) and once against the
 * committed YAML. Those are two of the three places the default lives; the
 * third is the `run()` call site in `ProgressCheckService`.
 */
describe("progress-check reminder policy", () => {
  it("defaults reminders.dryRun to true when the key is omitted", () => {
    const policy = validPolicy();
    policy.reminders = { scheduleCron: "0 9 * * 1-5", maxPerSubjectPerDay: 1 };
    expect(parseEscalationPolicy(policy).reminders.dryRun).toBe(true);
  });

  it("defaults reminders.dryRun to true when the whole block is omitted", () => {
    const policy = validPolicy();
    delete policy.reminders;
    expect(parseEscalationPolicy(policy).reminders.dryRun).toBe(true);
  });

  // The unconditional `expect(...reminders.dryRun).toBe(true)` that lived here
  // was strictly weaker than, and more brittle than, "cannot notify anyone from
  // the committed config alone, whatever `enabled` says" above: that one asserts
  // the conjunction that actually protects people, and survives the deliberate
  // flip to live. Two tests for one property, one of which breaks on a reviewed
  // rollout, is worse than the single durable one.

  it("defaults reminders.maxNotificationsPerRun to a conservative 10", () => {
    const policy = validPolicy();
    policy.reminders = { scheduleCron: "0 9 * * 1-5", maxPerSubjectPerDay: 1 };
    expect(parseEscalationPolicy(policy).reminders.maxNotificationsPerRun).toBe(10);
  });

  it("ships a per-run cap so the backlog drains as a trickle, not a burst", () => {
    const cap = loadEscalationPolicy(CONFIG_PATH).reminders.maxNotificationsPerRun;
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(25);
  });

  it("rejects a cap of zero — that is a mute, not a rate limit", () => {
    // A silently-muted sweep looks identical to one with nothing to do.
    // Turning tracking off is what `enabled: false` is for.
    const policy = validPolicy();
    policy.reminders = { scheduleCron: "0 9 * * 1-5", maxPerSubjectPerDay: 1, maxNotificationsPerRun: 0 };
    expect(() => parseEscalationPolicy(policy)).toThrow(/maxNotificationsPerRun/);
  });

  it("accepts an explicit live setting — going live is an edit someone makes", () => {
    const policy = validPolicy();
    policy.reminders = { scheduleCron: "0 9 * * 1-5", maxPerSubjectPerDay: 1, dryRun: false };
    expect(parseEscalationPolicy(policy).reminders.dryRun).toBe(false);
  });
});
