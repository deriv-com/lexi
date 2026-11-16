/**
 * Run Budget enforcement.
 *
 * A run exceeding any limit MUST stop safely and publish a partial-result digest.
 * Budgets prevent runaway automation from causing blast-radius incidents.
 */

export interface RunBudgetLimits {
  issuesScanned: number;
  issuesModified: number;
  closuresScheduled: number;
  closuresExecuted: number;
  slackMessagesPerHour: number;
  individualMentionsPerHour: number;
  reproductionRunsPerDay: number;
  batchSize: number;
  githubApiCalls: number;
  llmCalls: number;
}

/**
 * @deprecated Superseded by `budgets/budget-policy.ts`, which is
 * YAML-authoritative and throws rather than substituting a default.
 *
 * These numbers are roughly twenty times looser than the ones actually
 * configured in `config/run-budgets.yaml` (500 issues modified per run here
 * against 20 actual closures there) — and because this object is a *default
 * parameter value* on `RunBudgetEnforcer`, a caller got the looser set by
 * writing nothing at all. Retained so existing consumers keep compiling and
 * behaving identically during the migration; new code should construct limits
 * with `toLegacyRunBudgetLimits(loadBudgetPolicy().policy)` so an unconfigured
 * limit fails loudly instead of silently widening the blast radius.
 */
export const DEFAULT_BUDGET_LIMITS: RunBudgetLimits = {
  issuesScanned: 10_000,
  issuesModified: 500,
  closuresScheduled: 100,
  closuresExecuted: 25,
  slackMessagesPerHour: 300,
  individualMentionsPerHour: 100,
  reproductionRunsPerDay: 250,
  batchSize: 500,
  githubApiCalls: 10_000,
  llmCalls: 500,
};

export interface BudgetUsage {
  issuesScanned: number;
  issuesModified: number;
  closuresScheduled: number;
  closuresExecuted: number;
  slackMessages: number;
  individualMentions: number;
  reproductionRuns: number;
  githubApiCalls: number;
  llmCalls: number;
}

export interface BudgetCheckResult {
  allowed: boolean;
  resource: string;
  current: number;
  limit: number;
  reason: string;
}

/**
 * Stateful budget tracker for a single automation run.
 * Creates a new instance per run. Calls increment() for each action.
 * Calls check() before each action to verify budget availability.
 */
export class RunBudgetEnforcer {
  private usage: BudgetUsage = {
    issuesScanned: 0,
    issuesModified: 0,
    closuresScheduled: 0,
    closuresExecuted: 0,
    slackMessages: 0,
    individualMentions: 0,
    reproductionRuns: 0,
    githubApiCalls: 0,
    llmCalls: 0,
  };

  constructor(private readonly limits: RunBudgetLimits = DEFAULT_BUDGET_LIMITS) {}

  /**
   * Check if an action would exceed the budget BEFORE executing it.
   */
  check(resource: keyof BudgetUsage, count = 1): BudgetCheckResult {
    const current = this.usage[resource];
    const limit = this.getLimit(resource);
    const wouldExceed = current + count > limit;

    return {
      allowed: !wouldExceed,
      resource,
      current,
      limit,
      reason: wouldExceed
        ? `Budget exhausted: ${resource} at ${current}/${limit}, requested +${count}`
        : `Budget available: ${resource} at ${current}/${limit}`,
    };
  }

  /**
   * Increment usage after an action succeeds.
   */
  increment(resource: keyof BudgetUsage, count = 1): void {
    this.usage[resource] += count;
  }

  /**
   * Check and increment atomically. Returns the check result.
   * If allowed, increments. If not allowed, does NOT increment.
   */
  consume(resource: keyof BudgetUsage, count = 1): BudgetCheckResult {
    const result = this.check(resource, count);
    if (result.allowed) {
      this.increment(resource, count);
    }
    return result;
  }

  /**
   * Get current usage snapshot.
   */
  getUsage(): Readonly<BudgetUsage> {
    return { ...this.usage };
  }

  /**
   * Get all resources that are at or above 80% capacity (warning level).
   */
  getWarnings(): Array<{ resource: string; usage: number; limit: number; percentage: number }> {
    const warnings: Array<{ resource: string; usage: number; limit: number; percentage: number }> = [];
    for (const [key, value] of Object.entries(this.usage)) {
      const limit = this.getLimit(key as keyof BudgetUsage);
      const pct = (value / limit) * 100;
      if (pct >= 80) {
        warnings.push({ resource: key, usage: value, limit, percentage: Math.round(pct) });
      }
    }
    return warnings;
  }

  /**
   * Check if any budget is exhausted (run must stop).
   */
  isExhausted(): boolean {
    for (const [key, value] of Object.entries(this.usage)) {
      if (value >= this.getLimit(key as keyof BudgetUsage)) return true;
    }
    return false;
  }

  /**
   * Generate a partial-result digest when run stops due to budget.
   */
  generateDigest(): { usage: BudgetUsage; limits: RunBudgetLimits; exhausted: string[]; warnings: string[] } {
    const exhausted: string[] = [];
    const warnings: string[] = [];

    for (const [key, value] of Object.entries(this.usage)) {
      const limit = this.getLimit(key as keyof BudgetUsage);
      if (value >= limit) exhausted.push(key);
      else if (value >= limit * 0.8) warnings.push(key);
    }

    return { usage: this.usage, limits: this.limits, exhausted, warnings };
  }

  private getLimit(resource: keyof BudgetUsage): number {
    const mapping: Record<keyof BudgetUsage, keyof RunBudgetLimits> = {
      issuesScanned: "issuesScanned",
      issuesModified: "issuesModified",
      closuresScheduled: "closuresScheduled",
      closuresExecuted: "closuresExecuted",
      slackMessages: "slackMessagesPerHour",
      individualMentions: "individualMentionsPerHour",
      reproductionRuns: "reproductionRunsPerDay",
      githubApiCalls: "githubApiCalls",
      llmCalls: "llmCalls",
    };
    return this.limits[mapping[resource]];
  }
}
