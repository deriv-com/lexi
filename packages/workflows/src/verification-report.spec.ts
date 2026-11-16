import { describe, it, expect } from "vitest";
import { buildVerificationReport, buildVerificationReportComment } from "./verification-report";
import type { ReproductionAttemptRecord } from "./types";

describe("buildVerificationReportComment", () => {
  it("uses Verification Report framing with policy outcome", () => {
    const attempt: ReproductionAttemptRecord = {
      id: "att-1",
      issueId: "issue-1",
      workflowExecutionId: "exec-1",
      providerName: "bug-repro-engine",
      externalId: "plan_abc",
      status: "COMPLETED",
      resultSummary: "No console errors observed",
      resultDetails: {
        scenarioFit: 0.88,
        incompleteEvidence: false,
        executionPlan: {
          bugClasses: ["console", "signup"],
          routingConfidence: 0.94,
          primaryScenario: { scenarioId: "web.signup_console_check", scenarioVersion: "1.0.0" },
          reasoning: "Issue mentions Novu and CSP",
        },
        evaluations: [
          {
            scenarioId: "web.signup_console_check",
            scenarioFit: 0.88,
            bugObserved: false,
            reasoning: "No critical console errors",
          },
        ],
        evidence: [
          {
            type: "log",
            url: "http://localhost:4320/api/v1/artifacts/run_1/console_report.json",
            description: "console_report.json",
          },
        ],
        outcomeKind: "bug_not_observed",
      },
      logsUrl: "http://localhost:4320/api/v1/artifacts/run_1/console_report.json",
      retryCount: 0,
      submittedAt: new Date(),
      completedAt: new Date(),
    };

    const report = buildVerificationReport(
      {
        id: "issue-1",
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
        currentStatus: "SLACK_NOTIFIED",
        assignedOwner: null,
        assignedTeam: "Web",
        githubCreatedAt: new Date(),
        githubUpdatedAt: new Date(),
        updatedAt: new Date(),
      },
      {
        classification: "CANNOT_REPRODUCE",
        component: "web",
        team: "Web",
        confidence: 0.91,
        labels: ["bug"],
        summary: "Console errors not observed in reproduction",
        reasoning: "Signup path completed without Novu/Intercom console failures.",
        nextAction: "Close if gates pass",
      },
      "Web",
      "alice-web",
      { allowed: true, reason: "All auto-close gates passed." },
      attempt,
      [],
    );

    const comment = buildVerificationReportComment(report);

    expect(comment).toContain("**Verification Report**");
    expect(comment).not.toContain("Decision Audit");
    expect(comment).toContain("web.signup_console_check");
    expect(comment).toContain("console_report.json");
    expect(comment).toContain("Policy outcome");
    expect(comment).toContain("Auto-close allowed");
  });
});
