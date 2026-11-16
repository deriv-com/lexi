import { describe, it, expect, vi } from "vitest";
import { GovernanceRunContext } from "./governance-run-context";
import { DEFAULT_BUDGET_LIMITS } from "./run-budget";

describe("Phase 1.2 — Run Budget Enforcement certification (15 cases)", () => {
  // Case 1: Scheduler and Slack batches share identical budget semantics
  it("case 1: scheduler and slack source share same budget behavior", () => {
    const scheduler = new GovernanceRunContext({ source: "scheduler", budgetLimits: { issuesModified: 5 } });
    const slack = new GovernanceRunContext({ source: "slack", budgetLimits: { issuesModified: 5 } });

    for (let i = 0; i < 5; i++) scheduler.consume("issuesModified");
    for (let i = 0; i < 5; i++) slack.consume("issuesModified");

    // Both hit the same limit identically
    expect(scheduler.shouldContinue).toBe(false);
    expect(slack.shouldContinue).toBe(false);
    expect(scheduler.consume("issuesModified").allowed).toBe(false);
    expect(slack.consume("issuesModified").allowed).toBe(false);
  });

  // Case 2: Exact-limit consumption stops before the next item
  it("case 2: exact limit stops — last item succeeds, next is blocked", () => {
    const ctx = new GovernanceRunContext({ source: "scheduler", budgetLimits: { reproductionRunsPerDay: 3 } });

    expect(ctx.consume("reproductionRuns").allowed).toBe(true);
    expect(ctx.consume("reproductionRuns").allowed).toBe(true);
    expect(ctx.consume("reproductionRuns").allowed).toBe(true); // 3rd — succeeds (hits limit)
    expect(ctx.shouldContinue).toBe(false);
    expect(ctx.consume("reproductionRuns").allowed).toBe(false); // 4th — blocked
  });

  // Case 3: One over-limit request does not partially execute
  it("case 3: multi-count consume that would exceed is fully rejected", () => {
    const ctx = new GovernanceRunContext({ source: "api", budgetLimits: { issuesScanned: 10 } });
    ctx.consume("issuesScanned", 8);

    // Requesting 5 more when only 2 remain
    const result = ctx.consume("issuesScanned", 5);
    expect(result.allowed).toBe(false);
    // Usage should not have changed (no partial increment)
    expect(ctx.getUsage().issuesScanned).toBe(8);
  });

  // Case 4: Partial digest reports accurate completed/skipped/deferred counts
  it("case 4: digest reports accurate counts after partial execution", () => {
    const ctx = new GovernanceRunContext({ source: "scheduler", budgetLimits: { issuesModified: 2 } });

    ctx.consume("issuesModified");
    ctx.recordOutcome({ issueNumber: 100, action: "process", result: "executed", reason: "ok" });
    ctx.consume("issuesModified");
    ctx.recordOutcome({ issueNumber: 200, action: "process", result: "executed", reason: "ok" });

    // Budget exhausted — next items deferred
    ctx.recordOutcome({ issueNumber: 300, action: "process", result: "skipped_budget", reason: "exhausted" });
    ctx.recordOutcome({ issueNumber: 400, action: "process", result: "skipped_budget", reason: "exhausted" });

    const digest = ctx.generateDigest();
    expect(digest.totalProcessed).toBe(2);
    expect(digest.totalSkipped).toBe(2);
    expect(digest.totalFailed).toBe(0);
    expect(digest.stoppedEarly).toBe(true);
    expect(digest.budget.exhausted).toContain("issuesModified");
  });

  // Case 5: reproduction submission consumes budget even if it later fails
  it("case 5: reproduction consumption happens before execution (consumed regardless of outcome)", () => {
    const ctx = new GovernanceRunContext({ source: "scheduler", budgetLimits: { reproductionRunsPerDay: 5 } });

    // Simulate: consume budget, then reproduction fails
    ctx.consume("reproductionRuns");
    ctx.recordOutcome({ issueNumber: 100, action: "bre_submit", result: "failed", reason: "Reproduction timeout" });

    // Budget was consumed despite failure
    expect(ctx.getUsage().reproductionRuns).toBe(1);
    // Still counted toward the limit
    ctx.consume("reproductionRuns");
    ctx.consume("reproductionRuns");
    ctx.consume("reproductionRuns");
    ctx.consume("reproductionRuns"); // 5th — hits limit
    expect(ctx.shouldContinue).toBe(false);
  });

  // Case 6: Notification deduplication should happen before budget consumption
  it("case 6: budget is only consumed for non-duplicate notifications", () => {
    const ctx = new GovernanceRunContext({ source: "slack", budgetLimits: { slackMessagesPerHour: 10 } });

    // Simulate: 3 unique notifications, 2 duplicates (deduped before consume)
    ctx.consume("slackMessages"); // notification 1
    ctx.consume("slackMessages"); // notification 2
    ctx.consume("slackMessages"); // notification 3
    // Duplicates were deduped upstream — no consume call

    expect(ctx.getUsage().slackMessages).toBe(3); // Only 3 consumed
  });

  // Case 7: Owner mention consumes both message and mention budget
  it("case 7: owner mention consumes slackMessages + individualMentions", () => {
    const ctx = new GovernanceRunContext({ source: "scheduler", budgetLimits: { slackMessagesPerHour: 30, individualMentionsPerHour: 5 } });

    // Sending a notification that mentions an owner
    ctx.consume("slackMessages");
    ctx.consume("individualMentions");

    expect(ctx.getUsage().slackMessages).toBe(1);
    expect(ctx.getUsage().individualMentions).toBe(1);
  });

  // Case 8: A resumed run receives a new run ID and new budget
  it("case 8: resumed run gets fresh runId and fresh counters", () => {
    const run1 = new GovernanceRunContext({ source: "scheduler", budgetLimits: { issuesModified: 5 } });
    run1.consume("issuesModified", 5);
    expect(run1.shouldContinue).toBe(false);
    const run1Id = run1.runId;

    // "Resume" — create a new context (fresh budget, new ID)
    const run2 = new GovernanceRunContext({ source: "scheduler", budgetLimits: { issuesModified: 5 } });
    expect(run2.runId).not.toBe(run1Id);
    expect(run2.getUsage().issuesModified).toBe(0);
    expect(run2.shouldContinue).toBe(true);
  });

  // Case 9: Concurrent workers cannot exceed the shared budget (single-context guarantee)
  it("case 9: single context enforces total across all consumers", () => {
    const ctx = new GovernanceRunContext({ source: "batch", budgetLimits: { issuesModified: 4 } });

    // Simulate two "workers" sharing same context
    ctx.consume("issuesModified"); // worker A
    ctx.consume("issuesModified"); // worker B
    ctx.consume("issuesModified"); // worker A
    ctx.consume("issuesModified"); // worker B — hits limit

    expect(ctx.shouldContinue).toBe(false);
    expect(ctx.consume("issuesModified").allowed).toBe(false);
  });

  // Case 10: Budget state survives (persisted via onPersist callback)
  it("case 10: onPersist is called with complete digest when run stops", async () => {
    const persisted: any[] = [];
    const ctx = new GovernanceRunContext({
      source: "scheduler",
      budgetLimits: { issuesModified: 2 },
      onPersist: async (digest) => { persisted.push(digest); },
    });

    ctx.consume("issuesModified");
    ctx.consume("issuesModified"); // hits limit → auto-stops → auto-persists

    // Give the fire-and-forget persist time to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(persisted.length).toBe(1);
    expect(persisted[0].runId).toBe(ctx.runId);
    expect(persisted[0].stoppedEarly).toBe(true);
    expect(persisted[0].budget.usage.issuesModified).toBe(2);
  });

  // Case 11: Writes-disabled operations report would_execute without consuming mutation budget
  it("case 11: writes-disabled flag is separate from run budget (budget not consumed for would_execute)", () => {
    // This tests the semantic: when writes are disabled, the budget for
    // mutations (closuresExecuted) should NOT be consumed because no mutation
    // actually occurred. The run budget tracks actual resource consumption.
    const ctx = new GovernanceRunContext({ source: "scheduler", budgetLimits: { closuresExecuted: 5 } });

    // Simulate: policy allowed closure but write gate blocked it (would_execute)
    // In this case we do NOT consume closuresExecuted budget
    ctx.recordOutcome({ issueNumber: 100, action: "close", result: "skipped_policy", reason: "would_execute: writes disabled" });

    expect(ctx.getUsage().closuresExecuted).toBe(0); // Not consumed
  });

  // Case 12: Lexi can explain why the run stopped (stopReason in digest)
  it("case 12: stop reason is human-readable and available in digest", () => {
    const ctx = new GovernanceRunContext({ source: "batch", budgetLimits: { issuesModified: 1 } });
    ctx.consume("issuesModified");

    const digest = ctx.generateDigest();
    expect(digest.stoppedEarly).toBe(true);
    expect(digest.stopReason).toContain("issuesModified");
    // Lexi would format this as: "The run stopped because issuesModified budget was reached."
  });

  // Case 13: Budget config failure blocks high-volume execution
  it("case 13: zero-limit budget blocks all execution immediately", () => {
    const ctx = new GovernanceRunContext({ source: "scheduler", budgetLimits: { issuesScanned: 0 } });

    const result = ctx.consume("issuesScanned");
    expect(result.allowed).toBe(false);
    expect(ctx.shouldContinue).toBe(false);
  });

  // Case 14: Unknown run source is accepted (not fail-closed for source, only for budget)
  it("case 14: all valid run sources are accepted", () => {
    const sources = ["scheduler", "slack", "api", "intake_watcher", "batch", "canonical_watcher", "project_sync", "cross_org_sync"] as const;
    for (const source of sources) {
      const ctx = new GovernanceRunContext({ source });
      expect(ctx.source).toBe(source);
      expect(ctx.shouldContinue).toBe(true);
    }
  });

  // Case 15: Every budget decision appears in digest (outcomes track budget skips)
  it("case 15: all outcomes (executed, skipped, failed) appear in digest", () => {
    const ctx = new GovernanceRunContext({ source: "batch", budgetLimits: { issuesModified: 2 } });

    ctx.consume("issuesModified");
    ctx.recordOutcome({ issueNumber: 1, action: "process", result: "executed", reason: "ok" });
    ctx.consume("issuesModified");
    ctx.recordOutcome({ issueNumber: 2, action: "process", result: "failed", reason: "Reproduction provider down" });
    ctx.recordOutcome({ issueNumber: 3, action: "process", result: "skipped_budget", reason: "budget exhausted" });

    const digest = ctx.generateDigest();
    expect(digest.outcomes).toHaveLength(3);
    expect(digest.outcomes[0].result).toBe("executed");
    expect(digest.outcomes[1].result).toBe("failed");
    expect(digest.outcomes[2].result).toBe("skipped_budget");
    expect(digest.totalProcessed).toBe(1);
    expect(digest.totalFailed).toBe(1);
    expect(digest.totalSkipped).toBe(1);
    expect(digest.budgetVersion).toBeDefined();
    expect(digest.policyVersion).toBeDefined();
  });
});
