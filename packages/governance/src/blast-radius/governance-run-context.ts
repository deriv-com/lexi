/**
 * Governance Run Context — shared budget enforcement across all execution paths.
 *
 * One instance per automation run. All subsystems (scheduler, Slack agent, API,
 * intake watcher, batch plans) share the same counters. When a cap is reached:
 *   - Finish the current atomic operation safely
 *   - Stop taking new work
 *   - Persist partial outcomes
 *   - Publish a truthful digest
 *   - Do not retry automatically inside the same run
 */

import { randomUUID } from "node:crypto";
import { RunBudgetEnforcer, type RunBudgetLimits, type BudgetUsage, type BudgetCheckResult, DEFAULT_BUDGET_LIMITS } from "./run-budget";

export type RunSource = "scheduler" | "slack" | "api" | "intake_watcher" | "batch" | "canonical_watcher" | "project_sync" | "cross_org_sync";

export interface GovernanceRunContextOptions {
  source: RunSource;
  actor?: string;
  budgetLimits?: Partial<RunBudgetLimits>;
  policyVersion?: string;
  budgetVersion?: string;
  /** Persistence callback — called when run state changes (for durable audit) */
  onPersist?: (digest: RunDigest) => Promise<void>;
}

export interface RunOutcome {
  issueNumber: number;
  action: string;
  result: "executed" | "skipped_budget" | "skipped_policy" | "failed";
  reason: string;
}

export interface RunDigest {
  runId: string;
  source: RunSource;
  actor?: string;
  startedAt: Date;
  stoppedAt: Date;
  stoppedEarly: boolean;
  stopReason?: string;
  policyVersion: string;
  budgetVersion: string;
  budget: {
    usage: BudgetUsage;
    limits: RunBudgetLimits;
    exhausted: string[];
    warnings: string[];
  };
  outcomes: RunOutcome[];
  totalProcessed: number;
  totalSkipped: number;
  totalFailed: number;
}

/**
 * Shared run context. Created once at the start of any automation run.
 * Passed through all subsystem calls to enforce unified budgets.
 */
export class GovernanceRunContext {
  readonly runId: string;
  readonly source: RunSource;
  readonly actor?: string;
  readonly policyVersion: string;
  readonly budgetVersion: string;
  readonly startedAt: Date;
  private readonly enforcer: RunBudgetEnforcer;
  private readonly outcomes: RunOutcome[] = [];
  private readonly onPersist?: (digest: RunDigest) => Promise<void>;
  private _stopped = false;
  private _stopReason?: string;

  constructor(options: GovernanceRunContextOptions) {
    this.runId = randomUUID();
    this.source = options.source;
    this.actor = options.actor;
    this.policyVersion = options.policyVersion ?? "v1.0";
    this.budgetVersion = options.budgetVersion ?? "v1.0";
    this.startedAt = new Date();
    this.onPersist = options.onPersist;
    this.enforcer = new RunBudgetEnforcer({
      ...DEFAULT_BUDGET_LIMITS,
      ...options.budgetLimits,
    });
  }

  /**
   * Check if a budget resource is available BEFORE starting work.
   * If not available, the caller must not proceed.
   */
  checkBudget(resource: keyof BudgetUsage, count = 1): BudgetCheckResult {
    if (this._stopped) {
      return { allowed: false, resource, current: 0, limit: 0, reason: `Run already stopped: ${this._stopReason}` };
    }
    return this.enforcer.check(resource, count);
  }

  /**
   * Consume budget atomically: check and increment.
   * Returns false if budget is exhausted (caller must stop).
   */
  consume(resource: keyof BudgetUsage, count = 1): BudgetCheckResult {
    if (this._stopped) {
      return { allowed: false, resource, current: 0, limit: 0, reason: `Run already stopped: ${this._stopReason}` };
    }

    const result = this.enforcer.consume(resource, count);

    if (!result.allowed) {
      this.stop(`Budget exhausted: ${resource}`);
    } else if (this.enforcer.isExhausted()) {
      // Budget just hit exactly the limit on this consume — mark as stopped
      this.stop(`Budget reached limit: ${resource}`);
    }

    return result;
  }

  /**
   * Record the outcome of processing a single item.
   */
  recordOutcome(outcome: RunOutcome): void {
    this.outcomes.push(outcome);
  }

  /**
   * Explicitly stop the run (budget exhaustion, error, or manual stop).
   */
  stop(reason: string): void {
    if (!this._stopped) {
      this._stopped = true;
      this._stopReason = reason;
      // Fire-and-forget persist on stop (don't block the caller)
      this.persist().catch(() => {});
    }
  }

  /**
   * Whether the run should accept more work.
   */
  get shouldContinue(): boolean {
    return !this._stopped && !this.enforcer.isExhausted();
  }

  /**
   * Whether the run was stopped early (not all work completed).
   */
  get stoppedEarly(): boolean {
    return this._stopped;
  }

  get stopReason(): string | undefined {
    return this._stopReason;
  }

  /**
   * Get warnings for resources approaching their limit.
   */
  getWarnings(): Array<{ resource: string; usage: number; limit: number; percentage: number }> {
    return this.enforcer.getWarnings();
  }

  /**
   * Get current budget usage.
   */
  getUsage(): Readonly<BudgetUsage> {
    return this.enforcer.getUsage();
  }

  /**
   * Generate the final run digest — must be called before discarding the context.
   * This is the truthful record of what happened and what was skipped.
   */
  generateDigest(): RunDigest {
    const budgetDigest = this.enforcer.generateDigest();
    const totalProcessed = this.outcomes.filter((o) => o.result === "executed").length;
    const totalSkipped = this.outcomes.filter((o) => o.result === "skipped_budget" || o.result === "skipped_policy").length;
    const totalFailed = this.outcomes.filter((o) => o.result === "failed").length;

    return {
      runId: this.runId,
      source: this.source,
      actor: this.actor,
      startedAt: this.startedAt,
      stoppedAt: new Date(),
      stoppedEarly: this._stopped,
      stopReason: this._stopReason,
      policyVersion: this.policyVersion,
      budgetVersion: this.budgetVersion,
      budget: budgetDigest,
      outcomes: this.outcomes,
      totalProcessed,
      totalSkipped,
      totalFailed,
    };
  }

  /**
   * Persist the current run digest (for durable audit).
   * Called automatically when the run stops, or manually for checkpoints.
   */
  async persist(): Promise<void> {
    if (this.onPersist) {
      await this.onPersist(this.generateDigest());
    }
  }
}
