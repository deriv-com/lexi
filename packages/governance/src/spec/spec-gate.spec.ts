/**
 * Spec approval gate — the two-person rule.
 *
 * Approval is the point where a model-authored document becomes authority to
 * dispatch code (`trigger_code_task(feature)` checks for it), so the gate is
 * deterministic and config-driven: no model judgement participates in the
 * decision, and every threshold comes from config/spec-policy.yaml.
 */
import { describe, it, expect } from "vitest";
import { evaluateSpecGate, SPEC_GATE_REASONS, type SpecGateInput } from "./spec-gate";
import { specPolicySchema, loadSpecPolicy, type SpecPolicy } from "./spec-policy.schema";

/**
 * Base policy for the gate's ARITHMETIC tests.
 *
 * Deliberately overrides the two flags that are deployment decisions rather
 * than properties of the gate: approval enablement, and the two-person rule
 * (which a deployment may turn off). Inheriting those from
 * `config` made every rule test a hostage to the current rollout — turning the
 * rule off silently disabled twelve assertions about behaviour that still
 * exists and must keep working if it is ever re-enabled.
 *
 * Tests that care about what is SHIPPED assert against `loadSpecPolicy` directly,
 * further down.
 */
function policy(overrides: Record<string, unknown> = {}): SpecPolicy {
  const base = loadSpecPolicy();
  return specPolicySchema.parse({
    ...base,
    enabled: true,
    writes: { ...base.writes, approvalEnabled: true },
    approval: {
      ...base.approval,
      twoPersonRule: { ...base.approval.twoPersonRule, enabled: true },
    },
    ...overrides,
  });
}

function input(overrides: Partial<SpecGateInput> = {}): SpecGateInput {
  return {
    action: "approve",
    specId: "spec-1",
    revision: 2,
    approverId: "U_APPROVER",
    requestedBy: "U_AUTHOR",
    riskTier: "medium",
    actorIsHuman: true,
    ...overrides,
  };
}

describe("evaluateSpecGate — two-person rule", () => {
  it("denies approval when the approver is the requester at medium risk", () => {
    const decision = evaluateSpecGate(
      input({ approverId: "U_AUTHOR", requestedBy: "U_AUTHOR", riskTier: "medium" }),
      policy(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain(SPEC_GATE_REASONS.SELF_APPROVAL_FORBIDDEN);
  });

  it.each(["high", "critical"] as const)("denies self-approval at %s risk too", (riskTier) => {
    const decision = evaluateSpecGate(
      input({ approverId: "U_SAME", requestedBy: "U_SAME", riskTier }),
      policy(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain(SPEC_GATE_REASONS.SELF_APPROVAL_FORBIDDEN);
  });

  it("allows self-approval below the configured tier", () => {
    const decision = evaluateSpecGate(
      input({ approverId: "U_SAME", requestedBy: "U_SAME", riskTier: "low" }),
      policy(),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reasons).not.toContain(SPEC_GATE_REASONS.SELF_APPROVAL_FORBIDDEN);
  });

  it("allows a different approver at every risk tier", () => {
    for (const riskTier of ["low", "medium", "high", "critical"] as const) {
      const decision = evaluateSpecGate(input({ riskTier }), policy());
      expect(decision.allowed, `tier ${riskTier}`).toBe(true);
    }
  });

  it("honours a raised minRiskTier from config", () => {
    const raised = policy({
      approval: { ...policy().approval, twoPersonRule: { enabled: true, minRiskTier: "high", requiredApprovals: 1 } },
    });
    const atMedium = evaluateSpecGate(
      input({ approverId: "U_SAME", requestedBy: "U_SAME", riskTier: "medium" }),
      raised,
    );
    expect(atMedium.allowed).toBe(true);

    const atHigh = evaluateSpecGate(
      input({ approverId: "U_SAME", requestedBy: "U_SAME", riskTier: "high" }),
      raised,
    );
    expect(atHigh.allowed).toBe(false);
  });

  it("can be disabled entirely by config, and says so in matchedRules", () => {
    const off = policy({
      approval: { ...policy().approval, twoPersonRule: { enabled: false, minRiskTier: "medium", requiredApprovals: 1 } },
    });
    const decision = evaluateSpecGate(
      input({ approverId: "U_SAME", requestedBy: "U_SAME", riskTier: "critical" }),
      off,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.matchedRules).toContain("two_person_rule_disabled");
  });

  it("compares identities case-insensitively and ignores surrounding whitespace", () => {
    // Slack ids arrive from several call sites (slash command, mention,
    // interaction payload). A casing difference must not defeat the rule.
    const decision = evaluateSpecGate(
      input({ approverId: " u_same ", requestedBy: "U_SAME", riskTier: "high" }),
      policy(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain(SPEC_GATE_REASONS.SELF_APPROVAL_FORBIDDEN);
  });
});

describe("evaluateSpecGate — fail-closed behaviour", () => {
  it("refuses automation approving, however low the risk", () => {
    const decision = evaluateSpecGate(
      input({ actorIsHuman: false, riskTier: "low" }),
      policy(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain(SPEC_GATE_REASONS.HUMAN_APPROVAL_REQUIRED);
  });

  it("treats an unknown risk tier as the configured fail-closed default", () => {
    const decision = evaluateSpecGate(
      // Deliberately outside the union — models and stored rows both produce
      // values this code has never seen.
      input({ approverId: "U_SAME", requestedBy: "U_SAME", riskTier: "wildly-unknown" as never }),
      policy(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain(SPEC_GATE_REASONS.SELF_APPROVAL_FORBIDDEN);
    expect(decision.matchedRules).toContain("risk_tier_unknown_defaulted");
  });

  it("denies approval while the approval flag is off", () => {
    const flagOff = specPolicySchema.parse({
      ...policy(),
      writes: { ...policy().writes, approvalEnabled: false },
    });
    const decision = evaluateSpecGate(input(), flagOff);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain(SPEC_GATE_REASONS.APPROVAL_DISABLED);
  });

  it("denies when the requester is unknown — a missing author cannot be checked against", () => {
    const decision = evaluateSpecGate(input({ requestedBy: "" }), policy());
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain(SPEC_GATE_REASONS.REQUESTER_UNKNOWN);
  });

  it("denies when the approver is unknown", () => {
    const decision = evaluateSpecGate(input({ approverId: "  " }), policy());
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain(SPEC_GATE_REASONS.APPROVER_UNKNOWN);
  });

  it("is deterministic — identical input yields an identical decision", () => {
    const a = evaluateSpecGate(input(), policy());
    const b = evaluateSpecGate(input(), policy());
    expect(a).toEqual(b);
  });

  it("reports every failing reason rather than short-circuiting on the first", () => {
    const decision = evaluateSpecGate(
      input({ actorIsHuman: false, approverId: "U_SAME", requestedBy: "U_SAME", riskTier: "critical" }),
      policy(),
    );
    expect(decision.reasons).toContain(SPEC_GATE_REASONS.HUMAN_APPROVAL_REQUIRED);
    expect(decision.reasons).toContain(SPEC_GATE_REASONS.SELF_APPROVAL_FORBIDDEN);
  });
});

describe("evaluateSpecGate — non-approval actions", () => {
  it("does not apply the two-person rule to request_changes", () => {
    // Asking the author for changes on your own spec is not a governance
    // bypass — it moves the spec backwards, not forwards.
    const decision = evaluateSpecGate(
      input({ action: "request_changes", approverId: "U_SAME", requestedBy: "U_SAME", riskTier: "critical" }),
      policy(),
    );
    expect(decision.allowed).toBe(true);
  });

  it("applies the two-person rule to supersede", () => {
    const decision = evaluateSpecGate(
      input({ action: "supersede", approverId: "U_SAME", requestedBy: "U_SAME", riskTier: "high" }),
      policy(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain(SPEC_GATE_REASONS.SELF_APPROVAL_FORBIDDEN);
  });

  it("still requires a human for reject", () => {
    const decision = evaluateSpecGate(input({ action: "reject", actorIsHuman: false }), policy());
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain(SPEC_GATE_REASONS.HUMAN_APPROVAL_REQUIRED);
  });
});

describe("spec-policy.yaml — the shipped configuration", () => {
  it("parses the committed file", () => {
    const loaded = loadSpecPolicy();
    expect(loaded.version).toBe("1.0.0");
  });

  it("parses the shipped flags without pinning what they currently say", () => {
    // These are the deployment owner's to set. Asserting the live values would
    // report a rollout as a regression. The property worth protecting is
    // that an ABSENT flag is off, which is asserted on a minimal policy below.
    const loaded = loadSpecPolicy();
    expect(typeof loaded.enabled).toBe("boolean");
    expect(typeof loaded.writes.approvalEnabled).toBe("boolean");
  });

  it("defaults approval OFF when the config omits it — nothing turns itself on", () => {
    const bare = specPolicySchema.parse({});
    expect(bare.enabled).toBe(false);
    expect(bare.writes.approvalEnabled).toBe(false);
    // And the fail-closed tier default, which is what governs a spec that
    // carries no tier at all.
    expect(bare.approval.defaultRiskTier).toBe("high");
  });

  it("the example ships the two-person rule disabled", () => {
    const loaded = loadSpecPolicy();
    expect(loaded.approval.twoPersonRule.enabled).toBe(false);
    expect(loaded.approval.humanOnly).toBe(true);
  });

  it("keeps the frozen coverage keys, with journey_states and api_contract now mandatory", () => {
    // SpecSession.coverage persists against these keys — renaming one orphans
    // every stored session. Promoting a key into this list is allowed; renaming
    // is not. performance_plan stays off the list (no telemetry source).
    expect(loadSpecPolicy().coverage.mandatoryDimensions).toEqual([
      "problem",
      "users",
      "scope",
      "non_goals",
      "acceptance_criteria",
      "platforms",
      "dependencies",
      "risks",
      "rollout",
      "journey_states",
      "api_contract",
    ]);
  });

  it("defaults an absent risk tier to a tier the two-person rule covers", () => {
    const loaded = loadSpecPolicy();
    const tiers = loaded.approval.riskTiers;
    expect(tiers.indexOf(loaded.approval.defaultRiskTier)).toBeGreaterThanOrEqual(
      tiers.indexOf(loaded.approval.twoPersonRule.minRiskTier),
    );
  });
});

/**
 * Explaining the refusal.
 *
 * The two-person rule binds at and above `minRiskTier`, so "you cannot approve
 * your own spec" is only actionable if the refusal says which tier put it
 * there — and, when the tier was absent, that the strictness came from a
 * classification gap rather than from an assessment. Without that, the first
 * response to a refusal is to argue with it.
 */
describe("the refusal explains the tier that caused it", () => {
  it("names the effective tier when self-approval is refused", () => {
    const decision = evaluateSpecGate(
      input({ approverId: "U_SAME", requestedBy: "U_SAME", riskTier: "critical" }),
      policy(),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.summary).toMatch(/critical/);
  });

  it("says the tier was substituted when the spec carried none", () => {
    const decision = evaluateSpecGate(
      input({ approverId: "U_SAME", requestedBy: "U_SAME", riskTier: "" as never }),
      policy(),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.effectiveRiskTier).toBe("high");
    // The distinction that matters: assessed-as-high versus never-classified.
    expect(decision.summary).toMatch(/unclassified/i);
  });

  it("does not claim a substitution when the tier was genuinely high", () => {
    const decision = evaluateSpecGate(
      input({ approverId: "U_SAME", requestedBy: "U_SAME", riskTier: "high" }),
      policy(),
    );

    expect(decision.summary).not.toMatch(/unclassified/i);
  });
});
