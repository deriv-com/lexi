import { describe, it, expect } from "vitest";
import { evaluateAutoClose } from "./auto-close-policy";

describe("evaluateAutoClose", () => {
  it("blocks CANNOT_REPRODUCE when confidence is below threshold", () => {
    const result = evaluateAutoClose({
      classification: "CANNOT_REPRODUCE",
      decisionConfidence: 0.67,
      resultDetails: { scenarioFit: 0.9, outcomeKind: "bug_not_observed" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("confidence");
  });

  it("blocks when incompleteEvidence is true", () => {
    const result = evaluateAutoClose({
      classification: "CANNOT_REPRODUCE",
      decisionConfidence: 0.91,
      resultDetails: {
        incompleteEvidence: true,
        scenarioFit: 0.31,
        outcomeKind: "bug_not_observed",
        scenarioId: "web.signup_demo",
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("incompleteEvidence");
  });

  it("blocks when scenario fit is too low", () => {
    const result = evaluateAutoClose({
      classification: "CANNOT_REPRODUCE",
      decisionConfidence: 0.92,
      resultDetails: {
        scenarioFit: 0.42,
        incompleteEvidence: false,
        outcomeKind: "bug_not_observed",
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Scenario fit");
  });

  it("blocks infra_failure outcomes", () => {
    const result = evaluateAutoClose({
      classification: "CANNOT_REPRODUCE",
      decisionConfidence: 0.95,
      resultDetails: { outcomeKind: "infra_failure", scenarioFit: 0.9 },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("infra_failure");
  });

  it("allows when confidence and reproduction quality gates pass", () => {
    const result = evaluateAutoClose({
      classification: "CANNOT_REPRODUCE",
      decisionConfidence: 0.91,
      resultDetails: {
        scenarioFit: 0.88,
        incompleteEvidence: false,
        outcomeKind: "bug_not_observed",
        reproduced: false,
        lifecycleCoverage: {
          requiredStates: [],
          reachedStates: [],
          coverageComplete: true,
          missingStates: [],
        },
        evaluations: [{ retryRecommended: false, scenarioFit: 0.88 }],
      },
    });
    expect(result.allowed).toBe(true);
  });

  it("blocks CANNOT_REPRODUCE when lifecycle coverage is incomplete", () => {
    const result = evaluateAutoClose({
      classification: "CANNOT_REPRODUCE",
      decisionConfidence: 0.9,
      resultDetails: {
        scenarioFit: 1,
        incompleteEvidence: true,
        outcomeKind: "bug_not_observed",
        reproduced: false,
        lifecycleCoverage: {
          requiredStates: ["post_signup_authenticated"],
          reachedStates: ["signup_form"],
          coverageComplete: false,
          missingStates: ["post_signup_authenticated"],
        },
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("post-signup");
  });

  it("blocks blocked_human_verification outcomes", () => {
    const result = evaluateAutoClose({
      classification: "CANNOT_REPRODUCE",
      decisionConfidence: 0.95,
      resultDetails: { outcomeKind: "blocked_human_verification", scenarioFit: 0.9 },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked_human_verification");
  });

  it("blocks CANNOT_REPRODUCE when reproduced is null (infra-only reproduction session)", () => {
    const result = evaluateAutoClose({
      classification: "CANNOT_REPRODUCE",
      decisionConfidence: 0.95,
      resultDetails: {
        reproduced: null,
        outcomeKind: "bug_not_observed",
        incompleteEvidence: false,
        scenarioFit: 0.9,
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("reproduced: null");
  });

  it("does not auto-close VERIFIED", () => {
    const result = evaluateAutoClose({
      classification: "VERIFIED",
      decisionConfidence: 0.99,
      resultDetails: {},
    });
    expect(result.allowed).toBe(false);
  });
});
