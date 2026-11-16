import { describe, it, expect, vi } from "vitest";
import {
  evaluateCompleteness,
  evaluateIntakeDecision,
  type IntakeDecisionDependencies,
} from "./intake-decision.service";
import type { IntakeDraftFields } from "./intake-decision.types";
import { createsNewIssue, requiresHumanInput } from "./intake-decision.types";

function createMockDeps(overrides: Partial<IntakeDecisionDependencies> = {}): IntakeDecisionDependencies {
  return {
    countIssues: vi.fn(async () => 723),
    searchDuplicates: vi.fn(async () => []),
    getCorpusHealth: vi.fn(async () => ({ complete: true, staleRepositories: [] })),
    checkFixEvidence: vi.fn(async () => null),
    ...overrides,
  };
}

const completeFields: IntakeDraftFields = {
  title: "Deposit button does nothing on iOS",
  stepsToReproduce: ["Open cashier", "Tap deposit", "Nothing happens"],
  expectedBehaviour: "Deposit modal opens",
  actualBehaviour: "Nothing happens, no error",
  platform: "mobile",
  appVersion: "2.5.1",
};

describe("Intake Decision — completeness evaluation", () => {
  it("complete report passes", () => {
    const result = evaluateCompleteness(completeFields);
    expect(result.complete).toBe(true);
    expect(result.missingRequired).toHaveLength(0);
  });

  it("missing title is flagged", () => {
    const result = evaluateCompleteness({ ...completeFields, title: undefined });
    expect(result.complete).toBe(false);
    expect(result.missingRequired).toContain("title");
    expect(result.coachingQuestions.length).toBeGreaterThan(0);
  });

  it("missing steps flagged", () => {
    const result = evaluateCompleteness({ ...completeFields, stepsToReproduce: [] });
    expect(result.complete).toBe(false);
    expect(result.missingRequired).toContain("stepsToReproduce");
  });

  it("missing expected/actual flagged", () => {
    const result = evaluateCompleteness({ ...completeFields, expectedBehaviour: "", actualBehaviour: "" });
    expect(result.complete).toBe(false);
    expect(result.missingRequired).toContain("expectedBehaviour");
    expect(result.missingRequired).toContain("actualBehaviour");
  });
});

describe("Intake Decision — disposition evaluation", () => {
  it("accepts genuinely new report with full corpus", async () => {
    const deps = createMockDeps();
    const result = await evaluateIntakeDecision(completeFields, deps);

    expect(result.disposition).toBe("ACCEPT_NEW");
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.corpusFreshness.complete).toBe(true);
    expect(createsNewIssue(result.disposition)).toBe(true);
  });

  it("returns LOW_CONFIDENCE_ACCEPT when corpus is stale", async () => {
    const deps = createMockDeps({
      getCorpusHealth: vi.fn(async () => ({ complete: false, staleRepositories: ["acme/web-app"] })),
    });
    const result = await evaluateIntakeDecision(completeFields, deps);

    expect(result.disposition).toBe("LOW_CONFIDENCE_ACCEPT");
    expect(result.confidence).toBeLessThan(0.8);
    expect(result.corpusFreshness.complete).toBe(false);
    expect(result.corpusFreshness.staleRepositories).toContain("acme/web-app");
  });

  it("matches existing open issue at high confidence", async () => {
    const deps = createMockDeps({
      searchDuplicates: vi.fn(async () => [
        { number: 834, title: "Deposit not working iOS", url: "https://github.com/...", state: "open", similarity: 0.92 },
      ]),
    });
    const result = await evaluateIntakeDecision(completeFields, deps);

    expect(result.disposition).toBe("MATCH_EXISTING");
    expect(result.matchedIssue?.number).toBe(834);
    expect(result.recourse).toContain("not a duplicate");
    expect(createsNewIssue(result.disposition)).toBe(false);
  });

  it("asks reporter for possible duplicate at medium confidence", async () => {
    const deps = createMockDeps({
      searchDuplicates: vi.fn(async () => [
        { number: 900, title: "Cashier deposit issue", url: "https://github.com/...", state: "open", similarity: 0.75 },
      ]),
    });
    const result = await evaluateIntakeDecision(completeFields, deps);

    expect(result.disposition).toBe("POSSIBLE_DUPLICATE");
    expect(result.matchedIssue?.number).toBe(900);
    expect(requiresHumanInput(result.disposition)).toBe(true);
    expect(result.recourse).toContain("yes");
  });

  it("detects regression from closed+fixed issue", async () => {
    const deps = createMockDeps({
      searchDuplicates: vi.fn(async () => [
        { number: 500, title: "Deposit button broken", url: "https://github.com/...", state: "closed", similarity: 0.93 },
      ]),
      checkFixEvidence: vi.fn(async () => ({
        fixed: true,
        prNumber: 421,
        prRepo: "acme/web-app",
      })),
    });
    const result = await evaluateIntakeDecision(completeFields, deps);

    expect(result.disposition).toBe("REGRESSION");
    expect(result.regressionOf?.number).toBe(500);
    expect(result.regressionOf?.fixPR).toBe(421);
    expect(createsNewIssue(result.disposition)).toBe(true);
  });

  it("treats any merged fix as a regression — release is no longer tracked", async () => {
    const deps = createMockDeps({
      searchDuplicates: vi.fn(async () => [
        { number: 600, title: "Deposit freeze", url: "https://github.com/...", state: "closed", similarity: 0.91 },
      ]),
      checkFixEvidence: vi.fn(async () => ({
        fixed: true,
        prNumber: 555,
        prRepo: "acme/web-app",
      })),
    });
    const result = await evaluateIntakeDecision(completeFields, deps);

    expect(result.disposition).toBe("REGRESSION");
    expect(result.regressionOf?.fixPR).toBe(555);
  });

  it("security-labelled reports bypass all checks", async () => {
    const deps = createMockDeps();
    const securityFields = { ...completeFields, labels: ["security"] };
    const result = await evaluateIntakeDecision(securityFields, deps);

    expect(result.disposition).toBe("SECURITY_BYPASS");
    expect(result.confidence).toBe(1.0);
    // Should NOT have called duplicate search
    expect(deps.searchDuplicates).not.toHaveBeenCalled();
  });

  it("always includes recourse path", async () => {
    const deps = createMockDeps();
    const result = await evaluateIntakeDecision(completeFields, deps);
    expect(result.recourse).toBeDefined();
    expect(result.recourse.length).toBeGreaterThan(0);
  });

  it("always includes corpus freshness", async () => {
    const deps = createMockDeps();
    const result = await evaluateIntakeDecision(completeFields, deps);
    expect(result.corpusFreshness).toBeDefined();
    expect(typeof result.corpusFreshness.complete).toBe("boolean");
  });

  it("always includes policy version", async () => {
    const deps = createMockDeps();
    const result = await evaluateIntakeDecision(completeFields, deps);
    expect(result.policyVersion).toBeDefined();
  });
});
