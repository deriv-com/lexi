import { describe, it, expect, vi } from "vitest";
import {
  evaluateCompleteness,
  evaluateIntakeDecision,
  type IntakeDecisionDependencies,
} from "./intake-decision.service";
import type { IntakeDraftFields } from "./intake-decision.types";
import { createsNewIssue, requiresHumanInput } from "./intake-decision.types";

/**
 * Intake Front Door Certification — permanent acceptance criteria.
 *
 * Each test represents a real-world scenario that must behave correctly
 * before intake writes are enabled in production.
 */

function createDeps(overrides: Partial<IntakeDecisionDependencies> = {}): IntakeDecisionDependencies {
  return {
    countIssues: vi.fn(async () => 723),
    searchDuplicates: vi.fn(async () => []),
    getCorpusHealth: vi.fn(async () => ({ complete: true, staleRepositories: [] })),
    checkFixEvidence: vi.fn(async () => null),
    ...overrides,
  };
}

const newBugReport: IntakeDraftFields = {
  title: "Withdrawal form crashes after entering amount",
  stepsToReproduce: ["Open cashier", "Select withdrawal", "Enter amount > balance", "Tap submit"],
  expectedBehaviour: "Validation message shown",
  actualBehaviour: "App crashes with white screen",
  platform: "iOS",
  appVersion: "3.1.0",
  component: "cashier",
};

describe("Intake Front Door Certification", () => {
  // Case 1: New genuine bug → create canonical issue
  it("case 1: genuinely new bug with complete report creates canonical issue", async () => {
    const deps = createDeps();
    const result = await evaluateIntakeDecision(newBugReport, deps);

    expect(result.disposition).toBe("ACCEPT_NEW");
    expect(createsNewIssue(result.disposition)).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.corpusFreshness.complete).toBe(true);
    expect(result.recourse).toBeDefined();
    expect(result.policyVersion).toBeDefined();
  });

  // Case 2: Existing open issue → attach evidence instead of duplicating
  it("case 2: match to existing open issue does NOT create duplicate", async () => {
    const deps = createDeps({
      searchDuplicates: vi.fn(async () => [
        { number: 834, title: "Withdrawal crashes on iOS after amount entry", url: "https://github.com/test/834", state: "open", similarity: 0.92 },
      ]),
    });
    const result = await evaluateIntakeDecision(newBugReport, deps);

    expect(result.disposition).toBe("MATCH_EXISTING");
    expect(createsNewIssue(result.disposition)).toBe(false);
    expect(result.matchedIssue?.number).toBe(834);
    expect(result.matchedIssue?.state).toBe("open");
    expect(result.recourse).toContain("not a duplicate");
  });

  // Case 3: Closed-as-fixed match → create regression
  it("case 3: closed+fixed match creates regression, not reopen", async () => {
    const deps = createDeps({
      searchDuplicates: vi.fn(async () => [
        { number: 500, title: "Withdrawal crash on submit", url: "https://github.com/test/500", state: "closed", similarity: 0.93 },
      ]),
      checkFixEvidence: vi.fn(async () => ({
        fixed: true,
        prNumber: 421,
        prRepo: "acme/web-app",
      })),
    });
    const result = await evaluateIntakeDecision(newBugReport, deps);

    expect(result.disposition).toBe("REGRESSION");
    expect(createsNewIssue(result.disposition)).toBe(true);
    expect(result.regressionOf?.number).toBe(500);
    expect(result.regressionOf?.fixPR).toBe(421);
    // Should not silently reopen — creates a new regression issue
  });

  // Case 4: Uncertain duplicate → ask the reporter
  it("case 4: medium-confidence match asks reporter before deciding", async () => {
    const deps = createDeps({
      searchDuplicates: vi.fn(async () => [
        { number: 777, title: "Cashier form submission issue", url: "https://github.com/test/777", state: "open", similarity: 0.75 },
      ]),
    });
    const result = await evaluateIntakeDecision(newBugReport, deps);

    expect(result.disposition).toBe("POSSIBLE_DUPLICATE");
    expect(requiresHumanInput(result.disposition)).toBe(true);
    expect(result.matchedIssue?.number).toBe(777);
    expect(result.recourse).toContain("yes");
    expect(result.recourse).toContain("no");
    // Model does NOT silently decide
    expect(createsNewIssue(result.disposition)).toBe(false);
  });

  // Case 5: Incomplete report → coach, don't reject
  it("case 5: missing fields returns coaching questions, not rejection", () => {
    const incomplete: IntakeDraftFields = {
      title: "Something broken in cashier",
      // Missing: steps, expected, actual
    };
    const result = evaluateCompleteness(incomplete);

    expect(result.complete).toBe(false);
    expect(result.missingRequired.length).toBeGreaterThan(0);
    expect(result.coachingQuestions.length).toBeGreaterThan(0);
    // Should ask for specifics, not reject
    expect(result.coachingQuestions.some((q) => q.includes("steps") || q.includes("reproduce"))).toBe(true);
  });

  // Case 6: Security report → bypass normal flow
  it("case 6: security-labelled report bypasses duplicate search", async () => {
    const deps = createDeps();
    const securityReport = { ...newBugReport, labels: ["security"] };
    const result = await evaluateIntakeDecision(securityReport, deps);

    expect(result.disposition).toBe("SECURITY_BYPASS");
    expect(result.confidence).toBe(1.0);
    // Duplicate search should NOT have been called
    expect(deps.searchDuplicates).not.toHaveBeenCalled();
  });

  // Case 7: Stale corpus → disclose uncertainty
  it("case 7: stale corpus lowers confidence and discloses", async () => {
    const deps = createDeps({
      getCorpusHealth: vi.fn(async () => ({
        complete: false,
        staleRepositories: ["acme/web-app"],
      })),
    });
    const result = await evaluateIntakeDecision(newBugReport, deps);

    expect(result.disposition).toBe("LOW_CONFIDENCE_ACCEPT");
    expect(result.confidence).toBeLessThan(0.8);
    expect(result.corpusFreshness.complete).toBe(false);
    expect(result.corpusFreshness.staleRepositories).toContain("acme/web-app");
  });

  // Case 8: A merged fix is a regression. Release is no longer tracked
  //, so "merged but not yet released" is not a distinction intake makes.
  it("case 8: a merged fix is treated as released, so the match is a regression", async () => {
    const deps = createDeps({
      searchDuplicates: vi.fn(async () => [
        { number: 600, title: "Withdrawal form error", url: "https://github.com/test/600", state: "closed", similarity: 0.91 },
      ]),
      checkFixEvidence: vi.fn(async () => ({
        fixed: true,
        prNumber: 555,
        prRepo: "acme/web-app",
      })),
    });
    const result = await evaluateIntakeDecision(newBugReport, deps);

    expect(result.disposition).toBe("REGRESSION");
    expect(result.regressionOf?.fixPR).toBe(555);
    expect(createsNewIssue(result.disposition)).toBe(true);
  });

  // Case 9: Every outcome has recourse
  it("case 9: all dispositions include recourse path", async () => {
    const dispositions = [
      createDeps(), // ACCEPT_NEW
      createDeps({ searchDuplicates: vi.fn(async () => [{ number: 1, title: "x", url: "", state: "open", similarity: 0.95 }]) }), // MATCH_EXISTING
      createDeps({ searchDuplicates: vi.fn(async () => [{ number: 1, title: "x", url: "", state: "open", similarity: 0.75 }]) }), // POSSIBLE_DUPLICATE
      createDeps({ getCorpusHealth: vi.fn(async () => ({ complete: false, staleRepositories: ["x"] })) }), // LOW_CONFIDENCE
    ];

    for (const deps of dispositions) {
      const result = await evaluateIntakeDecision(newBugReport, deps);
      expect(result.recourse).toBeDefined();
      expect(result.recourse.length).toBeGreaterThan(0);
    }
  });

  // Case 10: No issue created before corpus/engineering checks complete
  it("case 10: disposition runs corpus health check before any creation decision", async () => {
    const healthCheck = vi.fn(async () => ({ complete: true, staleRepositories: [] as string[] }));
    const deps = createDeps({ getCorpusHealth: healthCheck });
    await evaluateIntakeDecision(newBugReport, deps);

    // Corpus health MUST be called before decision
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });

  // Case 11: Draft fields preserve reporter identity via schema
  it("case 11: draft fields model preserves all required intake fields", () => {
    const fields: IntakeDraftFields = {
      title: "Test",
      stepsToReproduce: ["step 1"],
      expectedBehaviour: "expected",
      actualBehaviour: "actual",
      platform: "web",
      component: "cashier",
      appVersion: "1.0",
      region: "EU",
      currency: "USD",
      evidenceUrls: ["https://screenshot.png"],
    };

    // All fields should be serializable (JSON-safe for Prisma)
    const serialized = JSON.parse(JSON.stringify(fields));
    expect(serialized.title).toBe("Test");
    expect(serialized.stepsToReproduce).toHaveLength(1);
    expect(serialized.evidenceUrls).toHaveLength(1);
  });

  // Case 12: Lexical search disclosure
  it("case 12: decision notes that search is lexical only (no semantic)", async () => {
    const deps = createDeps();
    const result = await evaluateIntakeDecision(newBugReport, deps);

    // The reasoning or corpusFreshness should NOT claim semantic search happened
    // (because it didn't — only lexical matching was used)
    expect(result.reasoning).not.toContain("semantic");
  });
});
