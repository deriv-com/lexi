import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { governanceConfigDir, governanceConfigPath } from "./config-dir";
import { loadGovernanceConfig } from "./load-governance-config";

describe("governanceConfigDir", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.GOVERNANCE_CONFIG_DIR;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GOVERNANCE_CONFIG_DIR;
    else process.env.GOVERNANCE_CONFIG_DIR = saved;
  });

  it("reads GOVERNANCE_CONFIG_DIR at call time", () => {
    process.env.GOVERNANCE_CONFIG_DIR = "/srv/policies";
    expect(governanceConfigDir()).toBe("/srv/policies");
    expect(governanceConfigPath("authorization.yaml")).toBe("/srv/policies/authorization.yaml");
  });

  it("falls back to ./config when the variable is unset or empty", () => {
    delete process.env.GOVERNANCE_CONFIG_DIR;
    expect(governanceConfigDir()).toBe("config");
    process.env.GOVERNANCE_CONFIG_DIR = "";
    expect(governanceConfigDir()).toBe("config");
  });
});

describe("loadGovernanceConfig", () => {
  it("loads every policy from the example directory", () => {
    const config = loadGovernanceConfig();
    expect(config.intakePolicy.reviewLabel).toBe("lexi:review-intake");
    expect(config.duplicatePolicy.highConfidenceThreshold).toBe(0.85);
    expect(config.pendingClosure.gracePeriodDays).toBe(7);
    expect(config.severityPriority.rules.length).toBeGreaterThan(0);
    expect(config.autofixPolicy.forbiddenComponents).toContain("payments");
  });

  it("projects a unified-vocabulary run-budgets.yaml onto the tracker limits", () => {
    const { runBudgets } = loadGovernanceConfig();
    expect(runBudgets.pendingClosureMarksPerRun).toBe(20);
    expect(runBudgets.actualClosuresPerRun).toBe(20);
    expect(runBudgets.quickFixPullRequestsPerRun).toBe(3);
  });

  it("refuses to load without severity rules — there is no built-in rule set", () => {
    const dir = mkdtempSync(join(tmpdir(), "governance-"));
    try {
      expect(() => loadGovernanceConfig(dir)).toThrow(/rules/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the schema defaults for every other missing policy file", () => {
    const dir = mkdtempSync(join(tmpdir(), "governance-"));
    try {
      writeFileSync(join(dir, "severity-priority.yaml"), "rules: []\n");
      const config = loadGovernanceConfig(dir);
      expect(config.pendingClosure.enabled).toBe(true);
      expect(config.runBudgets.duplicateClosuresPerRun).toBe(25);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a run-budgets.yaml written in the legacy vocabulary", () => {
    const dir = mkdtempSync(join(tmpdir(), "governance-"));
    try {
      writeFileSync(join(dir, "run-budgets.yaml"), "budgets:\n  actualClosuresPerRun: 4\n");
      writeFileSync(join(dir, "severity-priority.yaml"), "rules: []\n");
      expect(loadGovernanceConfig(dir).runBudgets.actualClosuresPerRun).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
