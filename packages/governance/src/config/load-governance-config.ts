import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import {
  governanceConfigSchema,
  type GovernanceConfig,
  intakePolicySchema,
  duplicatePolicySchema,
  pendingClosureConfigSchema,
  runBudgetsSchema,
  severityPriorityConfigSchema,
  autofixPolicySchema,
} from "./governance-config.schema";
import { governanceConfigDir } from "./config-dir";
import { loadBudgetPolicy, type BudgetKey } from "../budgets/budget-policy";

function loadYamlFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  const raw = readFileSync(path, "utf8");
  const parsed = loadYaml(raw);
  return (parsed as Record<string, unknown>) ?? {};
}

/**
 * The per-run tracker limits, read through the unified budget vocabulary.
 *
 * `run-budgets.yaml` may be written in either vocabulary (the legacy tracker
 * names or the unified `*PerRun` names); `loadBudgetPolicy` translates both,
 * so projecting from it means a file in the unified vocabulary is honoured here
 * too instead of silently falling back to the schema defaults.
 */
function runBudgetsFrom(baseDir: string): Record<string, number> {
  const budgets = loadBudgetPolicy(baseDir).policy.budgets as Partial<Record<BudgetKey, number>>;
  const projected: Record<string, number | undefined> = {
    duplicateClosuresPerRun: budgets.duplicateClosuresPerRun,
    pendingClosureMarksPerRun: budgets.closuresScheduledPerRun,
    actualClosuresPerRun: budgets.closuresExecutedPerRun,
    reproductionSubmissionsPerRun: budgets.reproductionSubmissionsPerRun,
    quickFixPullRequestsPerRun: budgets.quickFixPullRequestsPerRun,
  };
  return Object.fromEntries(
    Object.entries(projected).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );
}

/**
 * Load the governance policies from `GOVERNANCE_CONFIG_DIR` with Zod validation.
 */
export function loadGovernanceConfig(baseDir = governanceConfigDir()): GovernanceConfig {
  const intakeRaw = loadYamlFile(join(baseDir, "intake-policy.yaml"));
  const duplicateRaw = loadYamlFile(join(baseDir, "duplicate-policy.yaml"));
  const reproductionRaw = loadYamlFile(join(baseDir, "Reproduction-policy.yaml"));
  const severityRaw = loadYamlFile(join(baseDir, "severity-priority.yaml"));
  const autofixRaw = loadYamlFile(join(baseDir, "autofix-policy.yaml"));

  return governanceConfigSchema.parse({
    intakePolicy: intakePolicySchema.parse(intakeRaw.intake ?? intakeRaw),
    duplicatePolicy: duplicatePolicySchema.parse(duplicateRaw.duplicate ?? duplicateRaw),
    pendingClosure: pendingClosureConfigSchema.parse(
      reproductionRaw.pendingClosure ?? reproductionRaw,
    ),
    runBudgets: runBudgetsSchema.parse(runBudgetsFrom(baseDir)),
    severityPriority: severityPriorityConfigSchema.parse(severityRaw),
    autofixPolicy: autofixPolicySchema.parse(autofixRaw),
  });
}
