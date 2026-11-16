/**
 * General AgentPlanService — multi-step investigation plans.
 *
 * Evolves the existing batch-plan machinery into arbitrary plans with:
 * - Dependencies between steps
 * - Checkpoints and resumability
 * - Per-step approval requirements
 * - Budget tracking per plan
 * - Audit/replay of every step
 * - Cancellation at any point
 *
 * A plan is a DAG of steps where each step has:
 * - A kind (query, investigate, verify, mutate, aggregate, decide)
 * - A tool to invoke
 * - Arguments (possibly referencing outputs of prior steps)
 * - Dependencies (which steps must complete first)
 * - Whether human approval is needed before execution
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

export type PlanStepKind =
  | "query"        // Read from corpus/DB
  | "investigate"  // Call engineering intelligence
  | "verify"       // Run reproduction/verification
  | "mutate"       // Governed write action
  | "aggregate"    // Compute over results of prior steps
  | "decide"       // Make a policy decision
  | "notify";      // Send a message/notification

export type PlanStepStatus =
  | "pending"
  | "awaiting_approval"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

export type PlanStatus =
  | "draft"
  | "awaiting_approval"
  | "approved"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface PlanStep {
  id: string;
  kind: PlanStepKind;
  description: string;
  tool?: string;
  args?: Record<string, unknown>;
  /** IDs of steps that must complete before this one can start. */
  dependsOn: string[];
  /** If true, plan pauses here until human approves. */
  requiresApproval: boolean;
  /** Reference to the output of this step (for downstream steps to use). */
  resultRef?: string;
  status: PlanStepStatus;
  result?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface AgentPlan {
  id: string;
  /** Natural language goal. */
  goal: string;
  /** Who initiated the plan. */
  actorId: string;
  /** Scope description (what issues/repos/teams are covered). */
  scope: string;
  /** The ordered steps. */
  steps: PlanStep[];
  status: PlanStatus;
  /** Budget constraints for this plan. */
  budget: PlanBudget;
  /** Slack context for communication. */
  channel?: string;
  threadTs?: string;
  /** Timestamps. */
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Total execution time across all steps. */
  totalDurationMs?: number;
  /** Audit IDs generated during execution. */
  auditIds: string[];
  /** Plan-level approval (for the whole plan, not per-step). */
  approvedBy?: string;
  approvedAt?: string;
}

export interface PlanBudget {
  maxSteps: number;
  maxDurationMs: number;
  maxMutations: number;
  maxVerifications: number;
  consumed: {
    steps: number;
    durationMs: number;
    mutations: number;
    verifications: number;
  };
}

// ---------------------------------------------------------------------------
// Plan builder (fluent API for creating plans)
// ---------------------------------------------------------------------------

export class PlanBuilder {
  private steps: PlanStep[] = [];
  private goal = "";
  private scope = "";

  setGoal(goal: string): this {
    this.goal = goal;
    return this;
  }

  setScope(scope: string): this {
    this.scope = scope;
    return this;
  }

  addStep(
    kind: PlanStepKind,
    description: string,
    options?: {
      tool?: string;
      args?: Record<string, unknown>;
      dependsOn?: string[];
      requiresApproval?: boolean;
    },
  ): string {
    const id = `step-${this.steps.length + 1}`;
    this.steps.push({
      id,
      kind,
      description,
      tool: options?.tool,
      args: options?.args,
      dependsOn: options?.dependsOn ?? (this.steps.length > 0 ? [this.steps[this.steps.length - 1].id] : []),
      requiresApproval: options?.requiresApproval ?? false,
      status: "pending",
    });
    return id;
  }

  build(actorId: string, budget?: Partial<PlanBudget>): AgentPlan {
    return {
      id: randomUUID(),
      goal: this.goal,
      actorId,
      scope: this.scope,
      steps: this.steps,
      status: "draft",
      budget: {
        maxSteps: budget?.maxSteps ?? 20,
        maxDurationMs: budget?.maxDurationMs ?? 300_000,
        maxMutations: budget?.maxMutations ?? 10,
        maxVerifications: budget?.maxVerifications ?? 5,
        consumed: { steps: 0, durationMs: 0, mutations: 0, verifications: 0 },
      },
      createdAt: new Date().toISOString(),
      auditIds: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Plan persistence interface
// ---------------------------------------------------------------------------

export interface AgentPlanPersistence {
  savePlan(plan: AgentPlan): Promise<void>;
  getPlan(planId: string): Promise<AgentPlan | null>;
  updatePlan(planId: string, update: Partial<AgentPlan>): Promise<void>;
  listPlansForActor(actorId: string, limit?: number): Promise<AgentPlan[]>;
}

// ---------------------------------------------------------------------------
// Plan execution engine
// ---------------------------------------------------------------------------

export type StepExecutor = (step: PlanStep, plan: AgentPlan) => Promise<{ result: unknown } | { error: string }>;

export class AgentPlanExecutionEngine {
  constructor(
    private readonly persistence: AgentPlanPersistence,
    private readonly executor: StepExecutor,
    private readonly logger: { log(msg: string, ctx?: string): void; warn(msg: string, ctx?: string): void },
  ) {}

  /**
   * Execute the next available steps in a plan.
   * Respects dependencies, approvals, and budget.
   * Returns when: all steps done, approval needed, or budget exhausted.
   */
  async executeNext(planId: string): Promise<{
    status: PlanStatus;
    completedSteps: string[];
    awaitingApproval?: string;
    budgetExhausted?: boolean;
  }> {
    const plan = await this.persistence.getPlan(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);

    if (plan.status === "cancelled" || plan.status === "completed" || plan.status === "failed") {
      return { status: plan.status, completedSteps: [] };
    }

    if (plan.status === "draft" || plan.status === "awaiting_approval") {
      return { status: plan.status, completedSteps: [] };
    }

    const completedSteps: string[] = [];
    const startTime = Date.now();

    for (const step of plan.steps) {
      if (step.status !== "pending") continue;

      // Check dependencies
      const depsComplete = step.dependsOn.every((depId) => {
        const dep = plan.steps.find((s) => s.id === depId);
        return dep?.status === "completed";
      });
      if (!depsComplete) continue;

      // Check approval requirement
      if (step.requiresApproval && step.status === "pending") {
        step.status = "awaiting_approval";
        plan.status = "paused";
        await this.persistence.updatePlan(planId, { steps: plan.steps, status: "paused" });
        return { status: "paused", completedSteps, awaitingApproval: step.id };
      }

      // Budget check
      if (plan.budget.consumed.steps >= plan.budget.maxSteps) {
        await this.persistence.updatePlan(planId, { status: "paused" });
        return { status: "paused", completedSteps, budgetExhausted: true };
      }

      if (step.kind === "mutate") {
        if (plan.budget.consumed.mutations >= plan.budget.maxMutations) {
          step.status = "skipped";
          step.error = "Mutation budget exhausted";
          continue;
        }
        plan.budget.consumed.mutations++;
      }

      if (step.kind === "verify") {
        if (plan.budget.consumed.verifications >= plan.budget.maxVerifications) {
          step.status = "skipped";
          step.error = "Verification budget exhausted";
          continue;
        }
        plan.budget.consumed.verifications++;
      }

      // Execute
      step.status = "running";
      step.startedAt = new Date().toISOString();
      plan.budget.consumed.steps++;

      try {
        const outcome = await this.executor(step, plan);
        if ("error" in outcome) {
          step.status = "failed";
          step.error = outcome.error;
        } else {
          step.status = "completed";
          step.result = outcome.result;
          step.resultRef = step.id;
        }
      } catch (err) {
        step.status = "failed";
        step.error = err instanceof Error ? err.message : "unknown";
      }

      step.completedAt = new Date().toISOString();
      completedSteps.push(step.id);

      // Duration budget check
      plan.budget.consumed.durationMs = Date.now() - startTime;
      if (plan.budget.consumed.durationMs >= plan.budget.maxDurationMs) {
        await this.persistence.updatePlan(planId, { steps: plan.steps, budget: plan.budget, status: "paused" });
        return { status: "paused", completedSteps, budgetExhausted: true };
      }
    }

    // Check if all steps are done
    const allDone = plan.steps.every((s) => s.status === "completed" || s.status === "skipped" || s.status === "failed");
    const anyFailed = plan.steps.some((s) => s.status === "failed");
    const finalStatus: PlanStatus = allDone ? (anyFailed ? "failed" : "completed") : "running";

    plan.status = finalStatus;
    plan.completedAt = allDone ? new Date().toISOString() : undefined;
    plan.totalDurationMs = Date.now() - (plan.startedAt ? new Date(plan.startedAt).getTime() : startTime);

    await this.persistence.updatePlan(planId, {
      steps: plan.steps,
      budget: plan.budget,
      status: finalStatus,
      completedAt: plan.completedAt,
      totalDurationMs: plan.totalDurationMs,
    });

    return { status: finalStatus, completedSteps };
  }

  /**
   * Approve a step that's awaiting approval.
   */
  async approveStep(planId: string, stepId: string, approver: string): Promise<void> {
    const plan = await this.persistence.getPlan(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);

    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Step ${stepId} not found`);
    if (step.status !== "awaiting_approval") throw new Error(`Step ${stepId} is not awaiting approval`);

    step.status = "pending"; // Reset to pending so executeNext picks it up
    step.approvedBy = approver;
    step.approvedAt = new Date().toISOString();
    step.requiresApproval = false; // Already approved

    plan.status = "running";
    await this.persistence.updatePlan(planId, { steps: plan.steps, status: "running" });
  }

  /**
   * Cancel a plan (and all pending steps).
   */
  async cancelPlan(planId: string, actor: string): Promise<void> {
    const plan = await this.persistence.getPlan(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);

    for (const step of plan.steps) {
      if (step.status === "pending" || step.status === "awaiting_approval") {
        step.status = "cancelled";
      }
    }

    plan.status = "cancelled";
    plan.completedAt = new Date().toISOString();
    await this.persistence.updatePlan(planId, { steps: plan.steps, status: "cancelled", completedAt: plan.completedAt });

    this.logger.log(`Plan ${planId} cancelled by ${actor}`, "AgentPlanExecutionEngine");
  }

  /**
   * Get a human-readable summary of the plan's current state.
   */
  summarizePlan(plan: AgentPlan): string {
    const lines: string[] = [];
    lines.push(`*Plan: ${plan.goal}*`);
    lines.push(`Scope: ${plan.scope}`);
    lines.push(`Status: ${plan.status}`);
    lines.push(``);

    for (const step of plan.steps) {
      const icon = step.status === "completed" ? "✅"
        : step.status === "running" ? "⏳"
        : step.status === "failed" ? "❌"
        : step.status === "awaiting_approval" ? "🔒"
        : step.status === "skipped" ? "⏭️"
        : step.status === "cancelled" ? "🚫"
        : "⬜";
      lines.push(`${icon} ${step.description}`);
      if (step.error) lines.push(`   _${step.error}_`);
    }

    lines.push(``);
    lines.push(`Budget: ${plan.budget.consumed.steps}/${plan.budget.maxSteps} steps, ${plan.budget.consumed.mutations}/${plan.budget.maxMutations} mutations`);

    return lines.join("\n");
  }
}
