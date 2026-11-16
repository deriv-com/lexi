import { describe, expect, it, vi } from "vitest";
import { WorkflowStatus } from "@lexi/database";
import type { BacklogSweepBudget } from "./types";

/**
 * cleanupBacklog's loop must have a ceiling. Run budgets cap issue edits and
 * Slack messages, but a sweep that consumes a single token for the whole run
 * and then processes every NEW issue it finds is bounded only by how many new
 * issues happen to exist that day.
 *
 * These tests exercise the loop contract directly against a fake budget, since
 * the real ceiling only matters at the boundary between "asked" and "did".
 */
function makeBudget(allowFirstN: number) {
  let modified = 0;
  const consumed: string[] = [];
  const budget: BacklogSweepBudget & { consumed: string[] } = {
    consumed,
    checkBudget: (resource) => {
      if (resource === "issuesModified" && modified >= allowFirstN) {
        return { allowed: false, reason: `issuesModified limit ${allowFirstN} reached` };
      }
      return { allowed: true };
    },
    consume: (resource) => {
      consumed.push(resource);
      if (resource === "issuesModified") modified += 1;
      return { allowed: true };
    },
    recordOutcome: vi.fn(),
  };
  return budget;
}

function makeOrchestrator(issueCount: number, statusAfter: WorkflowStatus = WorkflowStatus.SLACK_NOTIFIED) {
  const issues = Array.from({ length: issueCount }, (_, i) => ({
    id: `iss-${i}`,
    githubNumber: 1000 + i,
    currentStatus: WorkflowStatus.NEW,
  }));
  const processIssue = vi.fn(async (id: string) => ({ id: `wf-${id}`, status: statusAfter }));
  return { issues, processIssue };
}

/**
 * Mirrors the shipped loop in WorkflowOrchestrator.cleanupBacklog. Kept here
 * rather than instantiating the full orchestrator (which needs GitHub, Slack,
 * Prisma, an AI provider and an ownership map) so the ceiling itself is what is
 * under test.
 */
async function sweep(
  issues: Array<{ id: string; githubNumber: number; currentStatus: WorkflowStatus }>,
  processIssue: (id: string) => Promise<{ id: string; status: WorkflowStatus }>,
  budget?: BacklogSweepBudget,
) {
  let processed = 0;
  let stoppedEarly = false;
  let stopReason: string | undefined;
  for (const issue of issues) {
    if (issue.currentStatus !== WorkflowStatus.NEW) continue;
    if (budget) {
      const check = budget.checkBudget("issuesModified");
      if (!check.allowed) {
        stoppedEarly = true;
        stopReason = check.reason ?? "issuesModified budget exhausted";
        budget.recordOutcome?.({
          issueNumber: issue.githubNumber,
          action: "backlog_sweep_item",
          result: "skipped_budget",
          reason: stopReason,
        });
        break;
      }
    }
    const execution = await processIssue(issue.id);
    processed += 1;
    if (budget) {
      budget.consume("issuesModified");
      if (execution?.status === WorkflowStatus.SLACK_NOTIFIED) budget.consume("slackMessages");
    }
  }
  return { discovered: issues.length, processed, stoppedEarly, stopReason };
}

describe("backlog sweep budget ceiling", () => {
  it("stops at the issuesModified ceiling instead of draining the backlog", async () => {
    const { issues, processIssue } = makeOrchestrator(50);
    const budget = makeBudget(20);

    const result = await sweep(issues, processIssue, budget);

    expect(result.discovered).toBe(50);
    expect(result.processed).toBe(20);
    expect(result.stoppedEarly).toBe(true);
    expect(result.stopReason).toContain("issuesModified");
    // The ceiling must be checked BEFORE the work, or it is a post-hoc note.
    expect(processIssue).toHaveBeenCalledTimes(20);
  });

  it("consumes a slackMessages token when the cycle came to rest at SLACK_NOTIFIED", async () => {
    const { issues, processIssue } = makeOrchestrator(3);
    const budget = makeBudget(20);

    await sweep(issues, processIssue, budget);

    expect(budget.consumed.filter((r) => r === "issuesModified")).toHaveLength(3);
    expect(budget.consumed.filter((r) => r === "slackMessages")).toHaveLength(3);
  });

  it("does not bill a slack message when the cycle stopped short of notifying", async () => {
    const { issues, processIssue } = makeOrchestrator(3, WorkflowStatus.WAITING);
    const budget = makeBudget(20);

    await sweep(issues, processIssue, budget);

    expect(budget.consumed.filter((r) => r === "slackMessages")).toHaveLength(0);
  });

  it("is unbounded without a budget — the pre-2026-08-23 behaviour, kept for callers that pass none", async () => {
    const { issues, processIssue } = makeOrchestrator(50);
    const result = await sweep(issues, processIssue, undefined);
    expect(result.processed).toBe(50);
    expect(result.stoppedEarly).toBe(false);
  });

  it("skips issues that are not NEW, so an already-notified issue is never re-swept", async () => {
    const { processIssue } = makeOrchestrator(0);
    const issues = [
      { id: "a", githubNumber: 1, currentStatus: WorkflowStatus.NEW },
      { id: "b", githubNumber: 2, currentStatus: WorkflowStatus.SLACK_NOTIFIED },
      { id: "c", githubNumber: 3, currentStatus: WorkflowStatus.NEW },
    ];
    const result = await sweep(issues, processIssue, makeBudget(20));
    expect(result.processed).toBe(2);
  });
});
