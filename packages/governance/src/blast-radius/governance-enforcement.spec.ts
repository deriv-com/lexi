import { describe, it, expect, vi } from "vitest";
import { evaluateMutationGuard, type MutationGuardInput } from "./mutation-guard";
import { GovernanceRunContext } from "./governance-run-context";
import { ManualReviewQueueService, type ManualReviewQueueStore, type ManualReviewItem } from "./manual-review-queue";
import { evaluateNeverTouch } from "./never-touch-policy";
import { classifyAction } from "./action-classification";
import { DEFAULT_BUDGET_LIMITS } from "./run-budget";

// ---- Helpers ----

function baseIssueState(overrides: Partial<MutationGuardInput["currentIssueState"]> = {}): MutationGuardInput["currentIssueState"] {
  return {
    labels: ["bug"],
    priority: "P3",
    severity: "S3",
    hasRecentHumanActivity: false,
    hasOpenLinkedPR: false,
    isExplicitlyAssigned: false,
    hasActiveEngineeringWork: false,
    state: "open",
    ...overrides,
  };
}

function createMockReviewStore(): ManualReviewQueueStore {
  const items = new Map<string, ManualReviewItem>();
  return {
    create: vi.fn(async (item) => { items.set(item.id, item); return item; }),
    findByIssue: vi.fn(async (issueId) => [...items.values()].find((i) => i.issueId === issueId) ?? null),
    findActive: vi.fn(async (filter?) => {
      let results = [...items.values()].filter((i) => i.status !== "RESOLVED" && i.status !== "ABANDONED");
      if (filter?.status) results = results.filter((i) => i.status === filter.status);
      if (filter?.owningTeam) results = results.filter((i) => i.owningTeam === filter.owningTeam);
      if (filter?.assignee) results = results.filter((i) => i.assignee === filter.assignee);
      return results;
    }),
    update: vi.fn(async (id, patch) => {
      const item = items.get(id);
      if (item) Object.assign(item, patch);
      return item!;
    }),
  };
}

// ---- 15 Certification Tests ----

describe("P0 Governance Enforcement — 15 certification cases", () => {
  // Case 1: Security-labelled issue cannot be closed
  it("case 1: security-labelled issue cannot be closed", () => {
    const result = evaluateMutationGuard({
      action: "close.not_observed",
      actorId: "automation",
      actorIsHuman: false,
      currentIssueState: baseIssueState({ labels: ["bug", "security"] }),
      writesEnabled: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.matchedRules.some((r) => r.includes("security"))).toBe(true);
  });

  // Case 2: P0/P1 cannot enter automated pending closure
  it("case 2: P0/P1 cannot enter automated pending closure", () => {
    const result = evaluateMutationGuard({
      action: "close.not_observed",
      actorId: "scheduler",
      actorIsHuman: false,
      currentIssueState: baseIssueState({ priority: "P1" }),
      writesEnabled: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.matchedRules.some((r) => r.includes("P1"))).toBe(true);
  });

  // Case 3: Recent human activity blocks destructive actions
  it("case 3: recent human activity blocks destructive actions", () => {
    const result = evaluateMutationGuard({
      action: "close.duplicate",
      actorId: "automation",
      actorIsHuman: false,
      currentIssueState: baseIssueState({ hasRecentHumanActivity: true }),
      writesEnabled: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.matchedRules.some((r) => r.includes("human activity"))).toBe(true);
  });

  // Case 4: Open linked PR blocks closure
  it("case 4: open linked PR blocks closure", () => {
    const result = evaluateMutationGuard({
      action: "close.fixed",
      actorId: "automation",
      actorIsHuman: false,
      currentIssueState: baseIssueState({ hasOpenLinkedPR: true }),
      writesEnabled: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.matchedRules.some((r) => r.includes("PR"))).toBe(true);
  });

  // Case 5: Human priority cannot be automatically lowered
  it("case 5: human-set priority cannot be lowered by automation", () => {
    const result = evaluateMutationGuard({
      action: "priority.lower",
      actorId: "automation",
      actorIsHuman: false,
      currentIssueState: baseIssueState(),
      writesEnabled: true,
    });
    // priority.lower is classified as human_gated
    expect(result.allowed).toBe(false);
    expect(result.actionClass).toBe("human_gated");
  });

  // Case 6: Unknown action defaults to human-gated
  it("case 6: unknown action defaults to human-gated", () => {
    const classification = classifyAction("some.unknown.mutation");
    expect(classification.actionClass).toBe("human_gated");
    expect(classification.requiresConfirmation).toBe(true);

    const result = evaluateMutationGuard({
      action: "some.unknown.mutation",
      actorId: "automation",
      actorIsHuman: false,
      currentIssueState: baseIssueState(),
      writesEnabled: true,
    });
    expect(result.allowed).toBe(false);
  });

  // Case 7: Batch and scheduler share the same budget semantics
  it("case 7: batch and scheduler share the same run context budget", () => {
    const ctx = new GovernanceRunContext({ source: "scheduler", budgetLimits: { issuesModified: 3 } });

    // Scheduler modifies 2
    ctx.consume("issuesModified");
    ctx.consume("issuesModified");
    expect(ctx.shouldContinue).toBe(true);

    // "Batch" (same context) modifies 1 more — hits limit
    const result = ctx.consume("issuesModified");
    expect(result.allowed).toBe(true); // This one succeeds (3rd of 3)

    // Next one should be blocked
    const blocked = ctx.consume("issuesModified");
    expect(blocked.allowed).toBe(false);
    expect(ctx.shouldContinue).toBe(false);
  });

  // Case 8: Budget exhaustion stops before the next issue
  it("case 8: budget exhaustion stops before processing next issue", () => {
    const ctx = new GovernanceRunContext({ source: "api", budgetLimits: { issuesScanned: 2 } });

    ctx.consume("issuesScanned");
    ctx.consume("issuesScanned");

    // Now exhausted — should not continue
    expect(ctx.shouldContinue).toBe(false);
    expect(ctx.stoppedEarly).toBe(true);

    // Additional consume attempts are rejected
    const result = ctx.consume("issuesScanned");
    expect(result.allowed).toBe(false);
  });

  // Case 9: Partial-run digest reports actual counts
  it("case 9: partial-run digest reports completed and skipped counts", () => {
    const ctx = new GovernanceRunContext({ source: "scheduler", budgetLimits: { issuesModified: 2 } });

    ctx.consume("issuesModified");
    ctx.recordOutcome({ issueNumber: 100, action: "process", result: "executed", reason: "ok" });
    ctx.consume("issuesModified");
    ctx.recordOutcome({ issueNumber: 200, action: "process", result: "executed", reason: "ok" });

    // Budget exhausted — record skip
    ctx.recordOutcome({ issueNumber: 300, action: "process", result: "skipped_budget", reason: "budget exhausted" });

    const digest = ctx.generateDigest();
    expect(digest.totalProcessed).toBe(2);
    expect(digest.totalSkipped).toBe(1);
    expect(digest.stoppedEarly).toBe(true);
    expect(digest.budget.exhausted).toContain("issuesModified");
  });

  // Case 10: Manual queue item receives an SLA
  it("case 10: manual queue item receives an SLA deadline", async () => {
    const store = createMockReviewStore();
    const service = new ManualReviewQueueService(store);

    const item = await service.createReviewItem({
      issueId: "issue-1", issueNumber: 856, repo: "acme-internal/issues",
      reason: "Reproduction unsupported scenario", priority: "P2",
    });

    expect(item.slaDeadline).toBeInstanceOf(Date);
    expect(item.slaDeadline.getTime()).toBeGreaterThan(Date.now());
    // P2 gets 24h SLA
    const hoursUntilSla = (item.slaDeadline.getTime() - item.enteredAt.getTime()) / (1000 * 60 * 60);
    expect(hoursUntilSla).toBeCloseTo(24, 0);
  });

  // Case 11: Unowned manual item escalates after threshold
  it("case 11: unowned manual item is detected as overdue", async () => {
    const store = createMockReviewStore();
    const service = new ManualReviewQueueService(store);

    // Create an item that entered 5 hours ago with 4h SLA
    const item = await service.createReviewItem({
      issueId: "issue-1", issueNumber: 100, repo: "test/repo",
      reason: "needs investigation", priority: "P1", slaHours: 4,
    });
    // Manually backdate for test
    item.slaDeadline = new Date(Date.now() - 60 * 60 * 1000); // 1h past deadline
    await store.update(item.id, { slaDeadline: item.slaDeadline });

    const overdue = await service.getOverdueItems();
    expect(overdue).toHaveLength(1);
    expect(overdue[0].issueNumber).toBe(100);
  });

  // Case 12: Resolved manual item leaves the active queue
  it("case 12: resolved manual item leaves active queue", async () => {
    const store = createMockReviewStore();
    const service = new ManualReviewQueueService(store);

    const item = await service.createReviewItem({
      issueId: "issue-1", issueNumber: 100, repo: "test/repo", reason: "test",
    });

    await service.resolve(item.id, "Fixed by engineer.");

    const summary = await service.getQueueSummary();
    expect(summary.total).toBe(0);
  });

  // Case 13: Mutation gateway rechecks current state (stale data is blocked)
  it("case 13: mutation guard uses current issue state, not stale data", () => {
    // First check: issue was unprotected at plan time
    const atPlanTime = evaluateMutationGuard({
      action: "close.not_observed",
      actorId: "automation",
      actorIsHuman: false,
      currentIssueState: baseIssueState({ labels: ["bug"] }),
      writesEnabled: true,
    });
    expect(atPlanTime.allowed).toBe(true);

    // Second check at execution time: human added keep-open since then
    const atExecutionTime = evaluateMutationGuard({
      action: "close.not_observed",
      actorId: "automation",
      actorIsHuman: false,
      currentIssueState: baseIssueState({ labels: ["bug", "keep-open"] }),
      writesEnabled: true,
    });
    expect(atExecutionTime.allowed).toBe(false);
    expect(atExecutionTime.matchedRules.some((r) => r.toLowerCase().includes("keep-open") || r.toLowerCase().includes("hold"))).toBe(true);
  });

  // Case 14: A stale pre-approved action is blocked after human adds keep-open
  it("case 14: pre-approved action blocked when issue gains protection between approval and execution", () => {
    // Simulates: plan approved → human adds keep-open → execution re-checks
    const executionCheck = evaluateMutationGuard({
      action: "close.duplicate",
      actorId: "batch-plan-123",
      actorIsHuman: false,
      currentIssueState: baseIssueState({
        labels: ["bug", "duplicate", "keep-open"],
        hasRecentHumanActivity: true,
      }),
      writesEnabled: true,
    });
    expect(executionCheck.allowed).toBe(false);
    // Multiple protection reasons
    expect(executionCheck.matchedRules.length).toBeGreaterThanOrEqual(2);
  });

  // Case 15: Agent cannot override a prohibited policy result
  it("case 15: agent (conversational) cannot override prohibited action", () => {
    // Even with human actor flag, prohibited is NEVER overridable
    const result = evaluateMutationGuard({
      action: "security.mutate",
      actorId: "U0TEST01",
      actorIsHuman: true,
      currentIssueState: baseIssueState({ labels: ["security-issue"] }),
      writesEnabled: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.actionClass).toBe("prohibited");

    // Also test direct AI closure
    const aiClose = evaluateMutationGuard({
      action: "close.direct_ai",
      actorId: "U0TEST01",
      actorIsHuman: true,
      currentIssueState: baseIssueState(),
      writesEnabled: true,
    });
    expect(aiClose.allowed).toBe(false);
    expect(aiClose.actionClass).toBe("prohibited");
  });
});
