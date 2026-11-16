import { describe, it, expect } from "vitest";
import { join } from "path";
import { createCoverageRecord, recordCoverage } from "./coverage";
import { loadSpecPolicy, parseSpecPolicy, SPEC_POLICY_PATH } from "./load-spec-policy";
import { classifySpecRisk, riskTierAtLeast, type SpecRiskClassification } from "./risk-tier";
import type { SpecCoverageRecord } from "./coverage";
import type { CoverageDimension } from "@lexi/contracts";

/**
 * Risk-tier classification.
 *
 * The two-person rule fires at `minRiskTier`, so this classifier is what
 * decides whether a spec needs a second pair of eyes. It is therefore pure
 * code with zero LLM calls — a model that classified its own spec as
 * low risk would be voting on its own supervision — and every rule lives in
 * `config/spec-policy.yaml` rather than in this file, so changing what counts
 * as risky is a config review rather than a deploy.
 *
 * The load-bearing property is the *absence* of a tier: an unclassifiable spec
 * must yield no tier at all, so `evaluateSpecGate` substitutes its stricter
 * `defaultRiskTier`. A classifier that guessed "low" when it did not know
 * would turn a data gap into a governance hole.
 */

const POLICY = loadSpecPolicy(SPEC_POLICY_PATH);

function coverageWith(notes: Partial<Record<CoverageDimension, string>>): SpecCoverageRecord {
  let record = createCoverageRecord();
  for (const [dimension, text] of Object.entries(notes)) {
    record = recordCoverage(record, dimension as CoverageDimension, {
      state: "COVERED",
      confidence: 1,
      notes: text,
      evidence: "user",
    });
  }
  return record;
}

function classify(
  notes: Partial<Record<CoverageDimension, string>>,
  title = "A spec",
): SpecRiskClassification {
  return classifySpecRisk({ coverage: coverageWith(notes), title }, POLICY);
}

describe("the safe default — an unclassifiable spec carries NO tier", () => {
  it("returns a null tier when nothing matches, rather than guessing low", () => {
    const result = classify({ problem: "Move the settings gear icon two pixels left." });

    // Null, not "low" and not "high": the gate owns the substitution, and one
    // substitution site is one thing to get wrong instead of two.
    expect(result.tier).toBeNull();
    expect(result.classified).toBe(false);
    expect(result.matchedRuleIds).toEqual([]);
  });

  it("returns a null tier for wholly empty coverage", () => {
    const result = classifySpecRisk({ coverage: createCoverageRecord(), title: "" }, POLICY);
    expect(result.tier).toBeNull();
  });

  it("never returns the lowest tier without a rule having matched for it", () => {
    const result = classify({ problem: "Something entirely unremarkable." });
    expect(result.tier).not.toBe("low");
  });

  it("returns a null tier when the classifier is disabled, so the gate defaults strictly", () => {
    const disabled = parseSpecPolicy(
      `version: "1.0.0"\nriskClassifier:\n  enabled: false\n  rules:\n    - id: copy\n      direction: lower\n      tier: low\n      anyKeywords: [typo]\n`,
    );

    const result = classifySpecRisk({ coverage: coverageWith({ problem: "fix a typo" }) }, disabled);

    expect(result.tier).toBeNull();
    expect(result.reason).toMatch(/disabled/i);
  });
});

describe("rules raise the tier", () => {
  it("classifies money movement as critical", () => {
    const result = classify({ problem: "Users cannot complete a withdrawal to their bank." });

    expect(result.tier).toBe("critical");
    expect(result.matchedRuleIds).toContain("money_movement");
  });

  it("classifies an auth/KYC surface as high", () => {
    const result = classify({ scope: "Add an OTP step to the login flow." });

    expect(result.tier).toBe("high");
    expect(result.matchedRuleIds).toContain("auth_or_kyc_surface");
  });

  it("classifies a data migration as high", () => {
    const result = classify({ rollout: "Requires a backfill of the existing rows before release." });

    expect(result.tier).toBe("high");
    expect(result.matchedRuleIds).toContain("data_migration");
  });

  it("classifies a new external dependency as at least medium", () => {
    const result = classify({ dependencies: "Pulls in a new third-party SDK for charting." });

    expect(riskTierAtLeast(result.tier, "medium", POLICY)).toBe(true);
    expect(result.matchedRuleIds).toContain("new_external_dependency");
  });

  it("raises on breadth of platforms", () => {
    const result = classify({ platforms: "iOS, Android, web" });

    expect(riskTierAtLeast(result.tier, "medium", POLICY)).toBe(true);
    expect(result.matchedRuleIds).toContain("broad_platform_reach");
  });

  it("takes the HIGHEST matching tier when several rules fire", () => {
    const result = classify({
      problem: "Deposit failures on the payment screen.",
      scope: "Also touches the login flow.",
      platforms: "iOS, Android, web",
    });

    // critical (money) beats high (auth) beats medium (breadth) — the rule set
    // is monotone upward, so adding a rule can never make a spec safer.
    expect(result.tier).toBe("critical");
  });
});

describe("rules lower the tier — but only when nothing raised it", () => {
  it("classifies a copy-only change as low, so it can be self-approved", () => {
    const result = classify({ problem: "Copy change: reword the empty-state label on the watchlist." });

    expect(result.tier).toBe("low");
    expect(result.matchedRuleIds).toContain("copy_only_change");
  });

  it("refuses to lower a copy change that also moves money", () => {
    const result = classify({
      problem: "Copy change on the withdrawal confirmation screen.",
      scope: "Reword the payout amount label.",
    });

    // The whole point of the ordering: a raise beats a lower, always. If this
    // ever flips, a spec touching money becomes self-approvable by saying the
    // word "copy".
    expect(result.tier).toBe("critical");
  });

  it("takes the STRICTEST tier when several lowering rules match", () => {
    const disabled = parseSpecPolicy(
      [
        `version: "1.0.0"`,
        `riskClassifier:`,
        `  enabled: true`,
        `  rules:`,
        `    - id: lower_low`,
        `      direction: lower`,
        `      tier: low`,
        `      anyKeywords: [typo]`,
        `    - id: lower_medium`,
        `      direction: lower`,
        `      tier: medium`,
        `      anyKeywords: [typo]`,
        ``,
      ].join("\n"),
    );

    const result = classifySpecRisk({ coverage: coverageWith({ problem: "a typo" }) }, disabled);

    // Lowering is the dangerous direction, so ambiguity resolves upward.
    expect(result.tier).toBe("medium");
  });
});

describe("the rules live in config, not in this package", () => {
  it("classifies from rules supplied by the policy, not from hard-coded keywords", () => {
    const custom = parseSpecPolicy(
      [
        `version: "1.0.0"`,
        `riskClassifier:`,
        `  enabled: true`,
        `  rules:`,
        `    - id: bespoke_rule`,
        `      direction: raise`,
        `      tier: critical`,
        `      anyKeywords: [zzz_sentinel_phrase]`,
        ``,
      ].join("\n"),
    );

    // A phrase no committed rule mentions: it can only classify if the rules
    // genuinely came from the policy argument.
    const matched = classifySpecRisk(
      { coverage: coverageWith({ problem: "contains zzz_sentinel_phrase here" }) },
      custom,
    );
    expect(matched.tier).toBe("critical");
    expect(matched.matchedRuleIds).toEqual(["bespoke_rule"]);

    // And the committed keywords must NOT apply under this policy.
    const notMatched = classifySpecRisk(
      { coverage: coverageWith({ problem: "a withdrawal to their bank" }) },
      custom,
    );
    expect(notMatched.tier).toBeNull();
  });

  it("restricts a rule to the dimensions it names", () => {
    const scoped = parseSpecPolicy(
      [
        `version: "1.0.0"`,
        `riskClassifier:`,
        `  enabled: true`,
        `  rules:`,
        `    - id: deps_only`,
        `      direction: raise`,
        `      tier: high`,
        `      dimensions: [dependencies]`,
        `      anyKeywords: [vendor]`,
        ``,
      ].join("\n"),
    );

    expect(classifySpecRisk({ coverage: coverageWith({ dependencies: "new vendor" }) }, scoped).tier).toBe(
      "high",
    );
    expect(classifySpecRisk({ coverage: coverageWith({ problem: "new vendor" }) }, scoped).tier).toBeNull();
  });

  it("rejects a rule naming a tier the policy's own ordering does not contain", () => {
    expect(() =>
      parseSpecPolicy(
        [
          `version: "1.0.0"`,
          `riskClassifier:`,
          `  rules:`,
          `    - id: bad`,
          `      direction: raise`,
          `      tier: catastrophic`,
          `      anyKeywords: [x]`,
          ``,
        ].join("\n"),
      ),
    ).toThrow(/Invalid spec policy/);
  });

  it("refuses a rule with no predicates — it would match every spec", () => {
    // A predicate-free `lower` rule would classify EVERY spec at its tier,
    // including every spec that should have needed two people. The schema
    // refuses to express it rather than leaving it as a review catch.
    expect(() =>
      parseSpecPolicy(
        [
          `version: "1.0.0"`,
          `riskClassifier:`,
          `  enabled: true`,
          `  rules:`,
          `    - id: matches_everything`,
          `      direction: lower`,
          `      tier: low`,
          ``,
        ].join("\n"),
      ),
    ).toThrow(/Invalid spec policy/);
  });

  it("carries the committed rule set, every tier of which the gate can order", () => {
    const tiers = new Set(POLICY.riskClassifier.rules.map((rule) => rule.tier));
    expect(POLICY.riskClassifier.rules.length).toBeGreaterThan(0);
    for (const tier of tiers) {
      expect(POLICY.approval.riskTiers).toContain(tier);
    }
  });

  it("keeps the classifier's tier vocabulary and the gate's ordering in one file", () => {
    // Two loaders parse config/spec-policy.yaml — this package's and
    // @lexi/governance's. They cannot import each other, so the *file* is the
    // shared source of truth and this asserts the halves agree.
    const raw = loadSpecPolicy(join(__dirname, "../../../examples/config/spec-policy.yaml"));
    expect(raw.approval.riskTiers).toEqual(["low", "medium", "high", "critical"]);
    expect(raw.approval.riskTiers).toContain(raw.approval.defaultRiskTier);
  });
});

describe("riskTierAtLeast", () => {
  it("orders tiers by their configured position", () => {
    expect(riskTierAtLeast("critical", "medium", POLICY)).toBe(true);
    expect(riskTierAtLeast("low", "medium", POLICY)).toBe(false);
    expect(riskTierAtLeast("medium", "medium", POLICY)).toBe(true);
  });

  it("treats an absent tier as NOT below the bar — an unknown tier is never safe", () => {
    // The gate substitutes `defaultRiskTier` for an absent tier, which is above
    // `minRiskTier`. Anything here that answered "false" would let a caller
    // conclude an unclassified spec sits below the two-person threshold.
    expect(riskTierAtLeast(null, "medium", POLICY)).toBe(true);
    expect(riskTierAtLeast(undefined, "critical", POLICY)).toBe(true);
  });

  it("treats an unrecognised tier as NOT below the bar either", () => {
    expect(riskTierAtLeast("wildly-unknown", "critical", POLICY)).toBe(true);
  });
});
