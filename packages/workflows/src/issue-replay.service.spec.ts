import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkflowRepository } from "./testing/in-memory-workflow.repository";
import { IssueReplayService } from "./issue-replay.service";
import { formatReplayReport } from "./replay-report";

describe("IssueReplayService", () => {
  it("builds flight-recorder replay for a processed issue", async () => {
    const repo = new InMemoryWorkflowRepository();
    const issue = await repo.upsertIssue({
      githubIssueId: 101,
      githubNumber: 101,
      repoOwner: "acme",
      repoName: "issues",
      title: "Console errors for Novu on signup",
      body: "browser console CSP violation",
      url: "https://github.com/acme/issues/issues/101",
      authorLogin: "tester",
      labels: ["domain:web"],
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    const attempt = await repo.createReproductionAttempt({
      issueId: issue.id,
      workflowExecutionId: null,
      providerName: "bug-repro-engine",
      externalId: "plan_856",
      status: "COMPLETED",
    });
    await repo.updateReproductionAttempt(attempt.id, {
      resultSummary: "No console errors observed",
      resultDetails: {
        scenarioFit: 0.91,
        incompleteEvidence: false,
        outcomeKind: "bug_not_observed",
        executionPlan: {
          bugClasses: ["console", "signup"],
          routingConfidence: 0.95,
          primaryScenario: {
            scenarioId: "web.signup_demo_complete_console_check",
            scenarioVersion: "1.0.0",
          },
          fallbackScenarios: [{ scenarioId: "web.signup_console_check", scenarioVersion: "1.0.0" }],
          reasoning: "Post-signup console class inferred from Novu/CSP keywords",
          maxAttempts: 2,
          stopCondition: "good_scenario_fit",
        },
        evaluations: [
          {
            scenarioId: "web.signup_demo_complete_console_check",
            scenarioFit: 0.91,
            bugObserved: false,
            reasoning: "No critical console errors",
          },
        ],
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
      reasoning: "Clean console on signup path",
      nextAction: "Close if policy allows",
    });

    const service = new IssueReplayService(repo, {
      autoCloseMinConfidence: 0.85,
      autoCloseMinScenarioFit: 0.75,
      scenarioConfigPath: "config/repro-scenarios.yaml",
    });

    const report = await service.getReplayReport(issue.id);
    expect(report).not.toBeNull();
    expect(report?.planner.primaryScenarioId).toBe("web.signup_demo_complete_console_check");
    expect(report?.reproduction.scenarioFit).toBe(0.91);
    expect(report?.policy.allowed).toBe(true);

    const full = formatReplayReport(report!);
    expect(full).toContain("web.signup_demo_complete_console_check");
    expect(full).toContain("Auto-close allowed");

    const plannerOnly = formatReplayReport(report!, "planner");
    expect(plannerOnly).toContain("console");
    expect(plannerOnly).toContain("Candidate scenarios");

    expect(report?.evidence).toBeUndefined();
    const evidenceTravel = service.formatTimeTravel(report!, "evidence");
    expect(evidenceTravel).toContain("not yet available");

    const plannerTravel = service.formatTimeTravel(report!, "planner");
    expect(plannerTravel).toContain("Time Travel: planner");
    expect(plannerTravel).toContain("web.signup_demo_complete_console_check");

    const policyTravel = service.formatTimeTravel(report!, "policy");
    expect(policyTravel).toContain("Time Travel: policy");
    expect(policyTravel).toContain("auto-close allowed");
  });

  it("prints phase and attemptId when a loader returns records", async () => {
    const repo = new InMemoryWorkflowRepository();
    const issue = await repo.upsertIssue({
      githubIssueId: 900,
      githubNumber: 900,
      repoOwner: "acme",
      repoName: "issues",
      title: "Evidence replay",
      body: "console error",
      url: "https://github.com/acme/issues/issues/900",
      authorLogin: "tester",
      labels: ["domain:web"],
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    const loadEvidenceForIssue = async (githubNumber: number, repository: string) => {
      expect(githubNumber).toBe(900);
      expect(repository).toBe("acme/issues");
      return {
        available: true,
        records: [{ phase: "red", attemptId: "attempt-42" }],
      };
    };

    const service = new IssueReplayService(repo, { loadEvidenceForIssue });
    const report = await service.getReplayReport(issue.id);
    expect(report?.evidence?.records[0]?.phase).toBe("red");

    const evidenceTravel = service.formatTimeTravel(report!, "evidence");
    expect(evidenceTravel).toContain("phase=red");
    expect(evidenceTravel).toContain("attemptId=attempt-42");
    expect(evidenceTravel).not.toContain("not yet available");
  });

  it("leaves evidence unset when the loader throws", async () => {
    const repo = new InMemoryWorkflowRepository();
    const issue = await repo.upsertIssue({
      githubIssueId: 901,
      githubNumber: 901,
      repoOwner: "acme",
      repoName: "issues",
      title: "Evidence replay failure",
      body: "console error",
      url: "https://github.com/acme/issues/issues/901",
      authorLogin: "tester",
      labels: ["domain:web"],
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    const service = new IssueReplayService(repo, {
      loadEvidenceForIssue: async () => {
        throw new Error("store unavailable");
      },
    });

    const report = await service.getReplayReport(issue.id);
    expect(report?.evidence).toBeUndefined();
    expect(service.formatTimeTravel(report!, "evidence")).toContain("not yet available");
  });

  it("reports bug classes and candidate scenarios from an injected planner", async () => {
    const repo = new InMemoryWorkflowRepository();
    const issue = await repo.upsertIssue({
      githubIssueId: 902,
      githubNumber: 902,
      repoOwner: "acme",
      repoName: "issues",
      title: "Console error on settings page",
      body: "TypeError in the browser console",
      url: "https://github.com/acme/issues/issues/902",
      authorLogin: "tester",
      labels: ["domain:web"],
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    const planner = {
      inferBugClasses: vi.fn().mockReturnValue(["console_error", "ui_state"]),
      primaryBugClass: vi.fn().mockReturnValue("console_error"),
      listCandidateScenarios: vi
        .fn()
        .mockReturnValue([{ scenarioId: "web.settings_console_check", bugClasses: ["console_error"], priority: 1 }]),
    };
    const service = new IssueReplayService(repo, { planner, scenarioConfigPath: "scenarios.yaml" });

    const report = await service.getReplayReport(issue.id);
    expect(report?.planner.inferredBugClasses).toEqual(["console_error", "ui_state"]);
    expect(report?.planner.primaryBugClass).toBe("console_error");
    expect(report?.planner.candidateScenarios[0]?.scenarioId).toBe("web.settings_console_check");
    expect(planner.listCandidateScenarios).toHaveBeenCalledWith(
      { title: issue.title, body: issue.body, labels: issue.labels },
      "scenarios.yaml",
    );
    expect(formatReplayReport(report!, "planner")).toContain("web.settings_console_check");
  });

  it("falls back to an empty planner view when no planner is injected", async () => {
    const repo = new InMemoryWorkflowRepository();
    const issue = await repo.upsertIssue({
      githubIssueId: 903,
      githubNumber: 903,
      repoOwner: "acme",
      repoName: "issues",
      title: "Untriaged report",
      body: null,
      url: "https://github.com/acme/issues/issues/903",
      authorLogin: "tester",
      labels: [],
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    const report = await new IssueReplayService(repo).getReplayReport(issue.id);
    expect(report?.planner.inferredBugClasses).toEqual([]);
    expect(report?.planner.primaryBugClass).toBe("unknown");
    expect(report?.planner.candidateScenarios).toEqual([]);
  });
});
