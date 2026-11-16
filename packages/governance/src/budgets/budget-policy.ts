/**
 * Unified run-budget vocabulary.
 *
 * Two budget systems shipped side by side with disjoint key sets and no
 * shared schema:
 *
 *   `DEFAULT_BUDGET_LIMITS` (blast-radius/run-budget.ts)
 *     issuesScanned 10_000 · issuesModified 500 · closuresScheduled 100 ·
 *     closuresExecuted 25 · reproductionRunsPerDay 250 · …
 *
 *   `run-budgets.yaml` (budgets/run-budget-tracker.ts)
 *     duplicateClosuresPerRun 25 · pendingClosureMarksPerRun 20 ·
 *     actualClosuresPerRun 20 · reproductionSubmissionsPerRun 100 · …
 *
 * Not one key name appears in both, and the hard-coded set is roughly twenty
 * times looser than the configured one. Which of the two a caller happened to
 * construct therefore decided how much blast radius it had — and because the
 * looser set is a *default parameter value*, a caller got it by writing
 * nothing at all.
 *
 * This module is the single vocabulary. Three properties make it hold:
 *
 *   1. **Every key states its enforcement window.** The legacy sets quietly
 *      mixed them — `reproductionRunsPerDay` and `reproductionSubmissionsPerRun` are different
 *      quantities that read as synonyms. They are kept apart here.
 *   2. **The schema supplies no defaults.** A key absent from YAML is an
 *      error, not a generous fallback. This is what "YAML-authoritative"
 *      means operationally.
 *   3. **Resolution throws.** `resolveBudgetLimit` has no fallback branch, so
 *      a consumer whose limit is unconfigured cannot proceed on a guess.
 */

import { readFileSync, existsSync } from "node:fs";
import { load as loadYaml } from "js-yaml";
import { z } from "zod";
import type { RunBudgetLimits } from "../blast-radius/run-budget";
import type { RunBudgetConfig } from "./run-budget-tracker";
import { governanceConfigDir } from "../config/config-dir";

/**
 * The one vocabulary. Every name carries its window so two different
 * quantities can never be mistaken for one.
 */
export const BUDGET_KEYS = [
  // Scan / mutate volume for a single automation run.
  "issuesScannedPerRun",
  "issuesModifiedPerRun",
  // Closure lifecycle. `closuresScheduled*` was `pendingClosureMarksPerRun`;
  // `closuresExecuted*` was `actualClosuresPerRun`. Same concepts, two names.
  "closuresScheduledPerRun",
  "closuresExecutedPerRun",
  "duplicateClosuresPerRun",
  // External work submission.
  "reproductionSubmissionsPerRun",
  "quickFixPullRequestsPerRun",
  // Infrastructure ceilings.
  "batchSize",
  "githubApiCallsPerRun",
  "llmCallsPerRun",
  // Notification ceilings — genuinely per-hour, not per-run.
  "slackMessagesPerHour",
  "individualMentionsPerHour",
] as const;

export type BudgetKey = (typeof BUDGET_KEYS)[number];

const positiveInt = z.number().int().positive();

/**
 * Note the absence of `.default()` on every field. That is deliberate and is
 * the mechanism, not an oversight: a default here would silently reintroduce
 * the exact hard-coded fallback this module exists to remove.
 */
export const budgetsSchema = z.object({
  issuesScannedPerRun: positiveInt,
  issuesModifiedPerRun: positiveInt,
  closuresScheduledPerRun: positiveInt,
  closuresExecutedPerRun: positiveInt,
  duplicateClosuresPerRun: positiveInt,
  reproductionSubmissionsPerRun: positiveInt,
  quickFixPullRequestsPerRun: positiveInt,
  batchSize: positiveInt,
  githubApiCallsPerRun: positiveInt,
  llmCallsPerRun: positiveInt,
  slackMessagesPerHour: positiveInt,
  individualMentionsPerHour: positiveInt,
});

export const budgetPolicySchema = z.object({
  version: z.string().default("1.0.0"),
  budgets: budgetsSchema,
});

export type BudgetPolicy = z.infer<typeof budgetPolicySchema>;

/** Thrown when a consumer asks for a limit the configuration does not carry. */
export class BudgetResolutionError extends Error {
  constructor(readonly key: string) {
    super(
      `Run budget "${key}" is not configured. Add it under \`budgets:\` in config/run-budgets.yaml — ` +
        `there is deliberately no built-in default, because a hard-coded fallback is what let the ` +
        `code and the config drift apart in the first place.`,
    );
    this.name = "BudgetResolutionError";
  }
}

/**
 * Resolve one limit. Throws when unconfigured — there is no fallback branch,
 * by design.
 */
export function resolveBudgetLimit(policy: BudgetPolicy, key: BudgetKey): number {
  const value = (policy.budgets as Partial<Record<BudgetKey, number>>)[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BudgetResolutionError(key);
  }
  return value;
}

export interface BudgetCompletenessResult {
  complete: boolean;
  missingKeys: BudgetKey[];
}

/**
 * Startup gate. In `strict` mode an incomplete policy throws, failing boot
 * loudly rather than letting subsystems resolve limits inconsistently.
 *
 * Off by default, so a deployment whose `run-budgets.yaml` still uses the
 * legacy key set keeps booting. Turn strict on once the file carries every
 * unified key (the Acme example in `examples/config` does).
 */
export function assertBudgetPolicyComplete(
  policy: BudgetPolicy,
  options: { strict?: boolean } = {},
): BudgetCompletenessResult {
  const budgets = policy.budgets as Partial<Record<BudgetKey, number>>;
  const missingKeys = BUDGET_KEYS.filter((key) => typeof budgets[key] !== "number");

  if (missingKeys.length > 0 && options.strict) {
    throw new Error(
      `Run budget configuration is incomplete — ${missingKeys.length} limit(s) cannot be resolved: ` +
        `${missingKeys.join(", ")}. Add them under \`budgets:\` in config/run-budgets.yaml.`,
    );
  }

  return { complete: missingKeys.length === 0, missingKeys };
}

/**
 * Legacy key names → unified key names.
 *
 * Kept explicit rather than inferred so the two genuinely-different windows
 * stay visible: `reproductionRunsPerDay` maps onto `reproductionSubmissionsPerRun` because the
 * *configured* value (per run) is the tighter and better-governed of the two,
 * and adopting the looser per-day number would raise the ceiling as a side
 * effect of a rename.
 */
const LEGACY_ALIASES: Record<string, BudgetKey> = {
  // DEFAULT_BUDGET_LIMITS
  issuesScanned: "issuesScannedPerRun",
  issuesModified: "issuesModifiedPerRun",
  closuresScheduled: "closuresScheduledPerRun",
  closuresExecuted: "closuresExecutedPerRun",
  slackMessagesPerHour: "slackMessagesPerHour",
  individualMentionsPerHour: "individualMentionsPerHour",
  reproductionRunsPerDay: "reproductionSubmissionsPerRun",
  batchSize: "batchSize",
  githubApiCalls: "githubApiCallsPerRun",
  llmCalls: "llmCallsPerRun",
  // config/run-budgets.yaml
  duplicateClosuresPerRun: "duplicateClosuresPerRun",
  pendingClosureMarksPerRun: "closuresScheduledPerRun",
  actualClosuresPerRun: "closuresExecutedPerRun",
  reproductionSubmissionsPerRun: "reproductionSubmissionsPerRun",
  quickFixPullRequestsPerRun: "quickFixPullRequestsPerRun",
};

export interface LoadBudgetPolicyResult {
  policy: BudgetPolicy;
  /** Unified keys the file did not supply, under either vocabulary. */
  missingKeys: BudgetKey[];
  /** True when the file supplied every unified key. */
  complete: boolean;
}

/**
 * Load `config/run-budgets.yaml`, translating whichever vocabulary it uses
 * into the unified one.
 *
 * Does not throw on an incomplete file — it reports. Throwing here would take
 * down boot for every consumer the moment this module landed, before the YAML
 * has been migrated. `assertBudgetPolicyComplete({ strict: true })` is the
 * gate that converts the report into a startup failure, once the config is
 * ready and someone deliberately turns it on.
 */
export function loadBudgetPolicy(baseDir = governanceConfigDir()): LoadBudgetPolicyResult {
  const path = `${baseDir}/run-budgets.yaml`;
  const raw = existsSync(path)
    ? ((loadYaml(readFileSync(path, "utf8")) as Record<string, unknown> | null) ?? {})
    : {};

  const source = (raw.budgets ?? raw) as Record<string, unknown>;
  const budgets: Partial<Record<BudgetKey, number>> = {};

  for (const [key, value] of Object.entries(source)) {
    // Either a legacy name with a known translation, or already a unified
    // name (which is how a migrated YAML will read). Anything else is left
    // alone rather than guessed at.
    const unifiedKey: BudgetKey | undefined =
      LEGACY_ALIASES[key] ??
      ((BUDGET_KEYS as readonly string[]).includes(key) ? (key as BudgetKey) : undefined);
    if (!unifiedKey) continue;
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      budgets[unifiedKey] = value;
    }
  }

  const missingKeys = BUDGET_KEYS.filter((key) => typeof budgets[key] !== "number");

  return {
    // Cast is safe for the caller's purposes: `resolveBudgetLimit` and
    // `assertBudgetPolicyComplete` both re-check presence per key, so a
    // partial `budgets` map cannot be read as a complete one.
    policy: { version: String(raw.version ?? "1.0.0"), budgets: budgets as BudgetPolicy["budgets"] },
    missingKeys,
    complete: missingKeys.length === 0,
  };
}

/**
 * Project the unified policy onto the legacy `RunBudgetLimits` shape so
 * `RunBudgetEnforcer` can be constructed from config rather than from its
 * default parameter. Throws if any required limit is unconfigured — a
 * partially populated limits object is exactly the silent-fallback failure
 * this module removes.
 */
export function toLegacyRunBudgetLimits(policy: BudgetPolicy): RunBudgetLimits {
  return {
    issuesScanned: resolveBudgetLimit(policy, "issuesScannedPerRun"),
    issuesModified: resolveBudgetLimit(policy, "issuesModifiedPerRun"),
    closuresScheduled: resolveBudgetLimit(policy, "closuresScheduledPerRun"),
    closuresExecuted: resolveBudgetLimit(policy, "closuresExecutedPerRun"),
    slackMessagesPerHour: resolveBudgetLimit(policy, "slackMessagesPerHour"),
    individualMentionsPerHour: resolveBudgetLimit(policy, "individualMentionsPerHour"),
    reproductionRunsPerDay: resolveBudgetLimit(policy, "reproductionSubmissionsPerRun"),
    batchSize: resolveBudgetLimit(policy, "batchSize"),
    githubApiCalls: resolveBudgetLimit(policy, "githubApiCallsPerRun"),
    llmCalls: resolveBudgetLimit(policy, "llmCallsPerRun"),
  };
}

/** Project the unified policy onto the legacy `RunBudgetConfig` shape. */
export function toLegacyRunBudgetConfig(policy: BudgetPolicy): RunBudgetConfig {
  return {
    duplicateClosuresPerRun: resolveBudgetLimit(policy, "duplicateClosuresPerRun"),
    pendingClosureMarksPerRun: resolveBudgetLimit(policy, "closuresScheduledPerRun"),
    actualClosuresPerRun: resolveBudgetLimit(policy, "closuresExecutedPerRun"),
    reproductionSubmissionsPerRun: resolveBudgetLimit(policy, "reproductionSubmissionsPerRun"),
    quickFixPullRequestsPerRun: resolveBudgetLimit(policy, "quickFixPullRequestsPerRun"),
  };
}
