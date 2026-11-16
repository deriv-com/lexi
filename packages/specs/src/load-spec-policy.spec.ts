import { describe, it, expect } from "vitest";
import { join } from "path";
import {
  DEFAULT_MIN_DIMENSION_CONFIDENCE,
  loadSpecPolicy,
  parseSpecPolicy,
  SPEC_POLICY_PATH,
} from "./load-spec-policy";

/**
 * The policy file is the *only* source of mandatory-ness, the turn cap and the
 * batching bounds. The stop condition is deterministic code reading this file
 *, so a policy that parses loosely would silently change when Lexi
 * stops asking questions — hence a schema rather than a cast.
 */

describe("spec policy loader", () => {
  it("loads the committed config/spec-policy.yaml", () => {
    const policy = loadSpecPolicy(join(__dirname, "../../../examples/config/spec-policy.yaml"));

    expect(policy.version).toBe("1.0.0");
    // The three flags are the operator's to set, so this asserts they PARSE,
    // not what they currently say. Pinning the live values here would make the
    // suite fail the moment a deployment turned the pipeline on — reporting a
    // rollout as a regression.
    expect(typeof policy.enabled).toBe("boolean");
    expect(typeof policy.writes.githubIssuesEnabled).toBe("boolean");
    expect(typeof policy.writes.approvalEnabled).toBe("boolean");
  });

  it("defaults every flag OFF when the file omits it — nothing turns itself on", () => {
    // This is the property the assertion above used to carry by accident. It
    // belongs on a minimal document, where it is about the schema rather than
    // about whatever the owner has enabled today.
    const policy = parseSpecPolicy(`version: "1.0.0"\n`);

    expect(policy.enabled).toBe(false);
    expect(policy.writes.githubIssuesEnabled).toBe(false);
    expect(policy.writes.approvalEnabled).toBe(false);
    // Same rule for the classifier: an absent section must not be the reason a
    // spec became self-approvable.
    expect(policy.riskClassifier.enabled).toBe(false);
    expect(policy.riskClassifier.rules).toEqual([]);
  });

  it("resolves the committed policy through the exported default path", () => {
    const policy = loadSpecPolicy(SPEC_POLICY_PATH);
    expect(policy.coverage.mandatoryDimensions).toHaveLength(11);
  });

  it("carries the mandatory coverage dimensions in order, including the B7 pair", () => {
    const policy = loadSpecPolicy(SPEC_POLICY_PATH);

    expect(policy.coverage.mandatoryDimensions).toEqual([
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
    expect(policy.coverage.deferrableDimensions).toContain("performance_plan");
    expect(policy.coverage.mandatoryDimensions).not.toContain("performance_plan");
  });

  it("exposes the question cap and batching bounds the loop reads", () => {
    const policy = loadSpecPolicy(SPEC_POLICY_PATH);

    expect(policy.coverage.maxQuestionTurns).toBe(5);
    expect(policy.questioning.minQuestionsPerTurn).toBe(2);
    expect(policy.questioning.maxQuestionsPerTurn).toBe(4);
    expect(policy.questioning.offerDefaultForEveryQuestion).toBe(true);
    expect(policy.questioning.neverReaskCoveredDimensions).toBe(true);
  });

  it("requires role `specs` for spec output, never the bug repo", () => {
    const policy = loadSpecPolicy(SPEC_POLICY_PATH);

    expect(policy.output.requiredRepoRole).toBe("specs");
    expect(policy.output.titlePrefix).toBe("[Spec]");
    expect(policy.output.labels.type).toBe("type:spec");
    expect(policy.output.labels.draft).toBe("spec:draft");
    expect(policy.output.labels.approved).toBe("spec:approved");
  });

  it("defaults minDimensionConfidence when the file omits it", () => {
    // The committed file predates the threshold; the loader must supply it
    // rather than let `undefined` flow into a numeric comparison, where every
    // `confidence >= undefined` would evaluate false and nothing would ever
    // be ready to draft.
    const policy = loadSpecPolicy(SPEC_POLICY_PATH);
    expect(policy.coverage.minDimensionConfidence).toBe(DEFAULT_MIN_DIMENSION_CONFIDENCE);
  });

  it("honours an explicit minDimensionConfidence when the file sets one", () => {
    const policy = parseSpecPolicy(`
version: "1.0.0"
enabled: false
coverage:
  mandatoryDimensions: [problem]
  minDimensionConfidence: 0.9
`);

    expect(policy.coverage.minDimensionConfidence).toBe(0.9);
  });

  it("preserves the two-person enabled flag used by the approval card", () => {
    const disabled = parseSpecPolicy(`
version: "1.0.0"
approval:
  twoPersonRule:
    enabled: false
    minRiskTier: medium
`);

    expect(disabled.approval.twoPersonRule.enabled).toBe(false);
    expect(parseSpecPolicy(`version: "1.0.0"`).approval.twoPersonRule.enabled).toBe(true);
  });

  it("rejects an unknown coverage dimension rather than silently dropping it", () => {
    expect(() =>
      parseSpecPolicy(`
version: "1.0.0"
coverage:
  mandatoryDimensions: [problem, telepathy]
`),
    ).toThrow(/Invalid spec policy/);
  });

  it("rejects a confidence threshold outside 0..1", () => {
    expect(() =>
      parseSpecPolicy(`
version: "1.0.0"
coverage:
  minDimensionConfidence: 1.4
`),
    ).toThrow(/Invalid spec policy/);
  });

  it("rejects a question batch whose minimum exceeds its maximum", () => {
    expect(() =>
      parseSpecPolicy(`
version: "1.0.0"
questioning:
  minQuestionsPerTurn: 4
  maxQuestionsPerTurn: 2
`),
    ).toThrow(/minQuestionsPerTurn/);
  });

  it("rejects a required repo role other than specs", () => {
    // Filing a spec in issues would sweep it into that repo's
    // dedup, triage and reproduction machinery. The schema refuses to
    // express the mistake.
    expect(() =>
      parseSpecPolicy(`
version: "1.0.0"
output:
  requiredRepoRole: issues
`),
    ).toThrow(/Invalid spec policy/);
  });

  it("applies safe defaults for every section a minimal file omits", () => {
    const policy = parseSpecPolicy(`version: "1.0.0"`);

    expect(policy.enabled).toBe(false);
    expect(policy.writes.githubIssuesEnabled).toBe(false);
    expect(policy.writes.approvalEnabled).toBe(false);
    expect(policy.coverage.maxQuestionTurns).toBeGreaterThan(0);
    expect(policy.output.requiredRepoRole).toBe("specs");
  });
});
