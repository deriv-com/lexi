/**
 * Budget vocabulary reconciliation.
 *
 * Two budget systems shipped side by side with COMPLETELY disjoint key sets:
 *
 *   run-budget.ts  DEFAULT_BUDGET_LIMITS  issuesScanned / issuesModified /
 *                                         closuresScheduled / closuresExecuted /
 *                                         reproductionRunsPerDay / …
 *   run-budgets.yaml                      duplicateClosuresPerRun /
 *                                         pendingClosureMarksPerRun /
 *                                         actualClosuresPerRun /
 *                                         reproductionSubmissionsPerRun / …
 *
 * Not one key appears in both. The code defaults are also roughly 20x looser
 * than the documented, configured ones — 500 issues modified per run against
 * 20 actual closures — so which file a caller happened to read decided how
 * much blast radius it had. These tests pin one vocabulary, make the YAML
 * authoritative, and make an unresolvable limit fail loudly instead of
 * silently falling back to the looser number.
 */
import { describe, it, expect } from "vitest";
import {
  BUDGET_KEYS,
  BudgetResolutionError,
  assertBudgetPolicyComplete,
  budgetPolicySchema,
  loadBudgetPolicy,
  resolveBudgetLimit,
  toLegacyRunBudgetConfig,
  toLegacyRunBudgetLimits,
  type BudgetPolicy,
} from "./budget-policy";
import { DEFAULT_BUDGET_LIMITS } from "../blast-radius/run-budget";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A complete policy — every unified key present. */
function completePolicy(overrides: Partial<Record<string, number>> = {}): BudgetPolicy {
  const budgets: Record<string, number> = {};
  for (const key of BUDGET_KEYS) budgets[key] = 10;
  return budgetPolicySchema.parse({ version: "1.0.0", budgets: { ...budgets, ...overrides } });
}

describe("one vocabulary", () => {
  it("names every budget with its enforcement window", () => {
    // The old vocabularies mixed windows silently: reproductionRunsPerDay (a DAY) and
    // reproductionSubmissionsPerRun (a RUN) are different quantities that looked
    // interchangeable. Every unified key states its window in its name.
    for (const key of BUDGET_KEYS) {
      expect(key, key).toMatch(/(PerRun|PerHour|PerDay|batchSize)$/);
    }
  });

  it("covers every concept both legacy vocabularies expressed", () => {
    const keys = new Set<string>(BUDGET_KEYS);
    // From DEFAULT_BUDGET_LIMITS
    expect(keys).toContain("issuesScannedPerRun");
    expect(keys).toContain("issuesModifiedPerRun");
    expect(keys).toContain("closuresScheduledPerRun");
    expect(keys).toContain("closuresExecutedPerRun");
    expect(keys).toContain("slackMessagesPerHour");
    expect(keys).toContain("individualMentionsPerHour");
    expect(keys).toContain("batchSize");
    expect(keys).toContain("githubApiCallsPerRun");
    expect(keys).toContain("llmCallsPerRun");
    // From run-budgets.yaml
    expect(keys).toContain("duplicateClosuresPerRun");
    expect(keys).toContain("reproductionSubmissionsPerRun");
    expect(keys).toContain("quickFixPullRequestsPerRun");
  });

  it("has no duplicate keys", () => {
    expect(new Set(BUDGET_KEYS).size).toBe(BUDGET_KEYS.length);
  });
});

describe("YAML is authoritative — the schema supplies no defaults", () => {
  it("rejects a budgets block that omits a key rather than defaulting it", () => {
    // The whole failure mode being fixed: a missing key silently resolving to
    // a generous built-in.
    const partial = { version: "1.0.0", budgets: { issuesScannedPerRun: 100 } };
    expect(() => budgetPolicySchema.parse(partial)).toThrow();
  });

  it("accepts a complete budgets block", () => {
    expect(() => completePolicy()).not.toThrow();
  });

  it("rejects a non-positive limit", () => {
    expect(() => completePolicy({ issuesModifiedPerRun: 0 })).toThrow();
    expect(() => completePolicy({ issuesModifiedPerRun: -1 })).toThrow();
  });
});

describe("fail-closed resolution", () => {
  it("resolves a configured limit", () => {
    expect(resolveBudgetLimit(completePolicy({ llmCallsPerRun: 42 }), "llmCallsPerRun")).toBe(42);
  });

  it("throws a named error when a consumer asks for a limit config does not carry", () => {
    const policy = completePolicy();
    // Simulate a consumer compiled against a newer key than the config ships.
    delete (policy.budgets as Record<string, number>).llmCallsPerRun;
    expect(() => resolveBudgetLimit(policy, "llmCallsPerRun")).toThrow(BudgetResolutionError);
  });

  it("names the missing key and the file in the error message", () => {
    const policy = completePolicy();
    delete (policy.budgets as Record<string, number>).reproductionSubmissionsPerRun;
    try {
      resolveBudgetLimit(policy, "reproductionSubmissionsPerRun");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("reproductionSubmissionsPerRun");
      expect((error as Error).message).toContain("run-budgets.yaml");
    }
  });

  it("never substitutes a default for an unresolved limit", () => {
    const policy = completePolicy();
    delete (policy.budgets as Record<string, number>).issuesModifiedPerRun;
    // The old DEFAULT_BUDGET_LIMITS value for this concept is 500. Falling
    // back to it is exactly the bug.
    expect(() => resolveBudgetLimit(policy, "issuesModifiedPerRun")).toThrow();
  });
});

describe("startup assertion", () => {
  it("passes for a complete policy", () => {
    expect(() => assertBudgetPolicyComplete(completePolicy(), { strict: true })).not.toThrow();
  });

  it("fails startup in strict mode, listing every missing key at once", () => {
    const policy = completePolicy();
    delete (policy.budgets as Record<string, number>).llmCallsPerRun;
    delete (policy.budgets as Record<string, number>).batchSize;
    try {
      assertBudgetPolicyComplete(policy, { strict: true });
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("llmCallsPerRun");
      expect(message).toContain("batchSize");
    }
  });

  it("is off by default — strict mode is opt-in", () => {
    // Flags default off. Turning this on is a
    // deliberate act once config/run-budgets.yaml carries the full key set.
    const policy = completePolicy();
    delete (policy.budgets as Record<string, number>).llmCallsPerRun;
    const result = assertBudgetPolicyComplete(policy);
    expect(result.complete).toBe(false);
    expect(result.missingKeys).toContain("llmCallsPerRun");
  });

  it("reports missing keys without throwing when not strict", () => {
    expect(() => assertBudgetPolicyComplete(completePolicy({}), {})).not.toThrow();
  });
});

describe("legacy adapters — one source, two shapes", () => {
  it("projects the unified policy onto the RunBudgetLimits shape", () => {
    const policy = completePolicy({ issuesScannedPerRun: 111, slackMessagesPerHour: 222 });
    const limits = toLegacyRunBudgetLimits(policy);
    expect(limits.issuesScanned).toBe(111);
    expect(limits.slackMessagesPerHour).toBe(222);
    // Every key the legacy interface declares is populated.
    for (const key of Object.keys(DEFAULT_BUDGET_LIMITS)) {
      expect(limits[key as keyof typeof limits], key).toBeTypeOf("number");
    }
  });

  it("projects the unified policy onto the RunBudgetConfig shape", () => {
    const policy = completePolicy({ duplicateClosuresPerRun: 7, quickFixPullRequestsPerRun: 2 });
    const config = toLegacyRunBudgetConfig(policy);
    expect(config.duplicateClosuresPerRun).toBe(7);
    expect(config.quickFixPullRequestsPerRun).toBe(2);
    expect(config.pendingClosureMarksPerRun).toBeTypeOf("number");
    expect(config.actualClosuresPerRun).toBeTypeOf("number");
  });

  it("maps the two closure vocabularies onto the same unified keys", () => {
    // pendingClosureMarksPerRun and closuresScheduled were the same concept
    // under two names; likewise actualClosuresPerRun and closuresExecuted.
    const policy = completePolicy({ closuresScheduledPerRun: 5, closuresExecutedPerRun: 3 });
    expect(toLegacyRunBudgetConfig(policy).pendingClosureMarksPerRun).toBe(5);
    expect(toLegacyRunBudgetLimits(policy).closuresScheduled).toBe(5);
    expect(toLegacyRunBudgetConfig(policy).actualClosuresPerRun).toBe(3);
    expect(toLegacyRunBudgetLimits(policy).closuresExecuted).toBe(3);
  });

  it("throws rather than projecting a partial policy", () => {
    const policy = completePolicy();
    delete (policy.budgets as Record<string, number>).batchSize;
    expect(() => toLegacyRunBudgetLimits(policy)).toThrow(BudgetResolutionError);
  });
});

describe("the configured file", () => {
  it("loads the example in the unified vocabulary with nothing missing", () => {
    const result = loadBudgetPolicy();
    expect(result.missingKeys).toEqual([]);
    expect(result.complete).toBe(true);
    expect(assertBudgetPolicyComplete(result.policy, { strict: true }).complete).toBe(true);
  });

  it("reads the configured values, not the looser code defaults", () => {
    const { policy } = loadBudgetPolicy();
    expect(policy.budgets.duplicateClosuresPerRun).toBe(25);
    expect(policy.budgets.closuresScheduledPerRun).toBe(20);
    expect(policy.budgets.closuresExecutedPerRun).toBe(20);
    expect(policy.budgets.quickFixPullRequestsPerRun).toBe(3);
    expect(policy.budgets.issuesModifiedPerRun).toBeLessThan(DEFAULT_BUDGET_LIMITS.issuesModified);
  });

  it("translates a file written in the legacy vocabulary", () => {
    const dir = mkdtempSync(join(tmpdir(), "budgets-"));
    try {
      writeFileSync(
        join(dir, "run-budgets.yaml"),
        "budgets:\n  pendingClosureMarksPerRun: 7\n  actualClosuresPerRun: 5\n  reproductionRunsPerDay: 9\n",
      );
      const result = loadBudgetPolicy(dir);
      expect(result.policy.budgets.closuresScheduledPerRun).toBe(7);
      expect(result.policy.budgets.closuresExecutedPerRun).toBe(5);
      expect(result.policy.budgets.reproductionSubmissionsPerRun).toBe(9);
      expect(result.complete).toBe(false);
      expect(result.missingKeys).toContain("batchSize");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
