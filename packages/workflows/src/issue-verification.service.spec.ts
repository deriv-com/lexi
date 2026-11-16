import { describe, it, expect } from "vitest";
import { InMemoryWorkflowRepository } from "./testing/in-memory-workflow.repository";
import { IssueVerificationService } from "./issue-verification.service";

describe("IssueVerificationService", () => {
  it("returns structured verification report for latest decision", async () => {
    const repo = new InMemoryWorkflowRepository();
    const issue = await repo.upsertIssue({
      githubIssueId: 101,
      githubNumber: 101,
      repoOwner: "acme",
      repoName: "issues",
      title: "Console errors",
      body: null,
      url: "https://github.com/acme/issues/issues/101",
      authorLogin: "tester",
      labels: ["bug"],
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    const attempt = await repo.createReproductionAttempt({
      issueId: issue.id,
      workflowExecutionId: null,
      providerName: "bug-repro-engine",
      externalId: "plan_1",
      status: "COMPLETED",
    });
    await repo.updateReproductionAttempt(attempt.id, {
      resultSummary: "No errors",
      resultDetails: {
        scenarioFit: 0.88,
        incompleteEvidence: false,
        outcomeKind: "bug_not_observed",
      },
      status: "COMPLETED",
      completedAt: new Date(),
    });

    await repo.createDecision({
      issueId: issue.id,
      reproductionAttemptId: attempt.id,
      classification: "CANNOT_REPRODUCE",
      component: "web",
      team: "Web",
      owner: null,
      confidence: 0.91,
      labels: ["bug"],
      summary: "Not observed",
      reasoning: "Clean run",
      nextAction: "Close",
    });

    const service = new IssueVerificationService(repo);
    const report = await service.getVerificationReport(issue.id);

    expect(report).not.toBeNull();
    expect(report?.classification).toBe("CANNOT_REPRODUCE");
    expect(report?.scenarioFit).toBe(0.88);
    expect(report?.policyOutcome.allowed).toBe(true);
  });
});
