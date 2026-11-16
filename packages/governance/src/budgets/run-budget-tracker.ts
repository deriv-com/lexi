export interface RunBudgetConfig {
  duplicateClosuresPerRun: number;
  pendingClosureMarksPerRun: number;
  actualClosuresPerRun: number;
  reproductionSubmissionsPerRun: number;
  quickFixPullRequestsPerRun: number;
}

export type BudgetAction =
  | "duplicate_closure"
  | "pending_closure_mark"
  | "actual_closure"
  | "bre_submission"
  | "quick_fix_pr";

export interface BudgetCheckResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  deferredReason?: string;
}

/**
 * Per-run mutation budgets — defer remainder when exceeded.
 */
export class RunBudgetTracker {
  private readonly usage = new Map<BudgetAction, number>();

  constructor(private readonly config: RunBudgetConfig, private readonly runId: string) {}

  getRunId(): string {
    return this.runId;
  }

  check(action: BudgetAction): BudgetCheckResult {
    const limit = this.limitFor(action);
    const used = this.usage.get(action) ?? 0;
    const remaining = Math.max(0, limit - used);
    return {
      allowed: used < limit,
      remaining,
      limit,
      deferredReason: used >= limit ? `Run budget exceeded for ${action} (${limit})` : undefined,
    };
  }

  consume(action: BudgetAction): BudgetCheckResult {
    const check = this.check(action);
    if (check.allowed) {
      this.usage.set(action, (this.usage.get(action) ?? 0) + 1);
    }
    return this.check(action);
  }

  snapshot(): Record<BudgetAction, { used: number; limit: number }> {
    const actions: BudgetAction[] = [
      "duplicate_closure",
      "pending_closure_mark",
      "actual_closure",
      "bre_submission",
      "quick_fix_pr",
    ];
    const result = {} as Record<BudgetAction, { used: number; limit: number }>;
    for (const action of actions) {
      result[action] = { used: this.usage.get(action) ?? 0, limit: this.limitFor(action) };
    }
    return result;
  }

  private limitFor(action: BudgetAction): number {
    switch (action) {
      case "duplicate_closure":
        return this.config.duplicateClosuresPerRun;
      case "pending_closure_mark":
        return this.config.pendingClosureMarksPerRun;
      case "actual_closure":
        return this.config.actualClosuresPerRun;
      case "bre_submission":
        return this.config.reproductionSubmissionsPerRun;
      case "quick_fix_pr":
        return this.config.quickFixPullRequestsPerRun;
      default:
        return 0;
    }
  }
}
