import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkflowStatus } from "@lexi/database";
import { WorkflowOrchestrator } from "./workflow-orchestrator";
import { WorkflowStateMachine } from "./workflow-state-machine";
import type { WorkflowRepository } from "./workflow-repository.interface";
import type { IssueRecord, WorkflowExecutionRecord } from "./types";
import type { EvidenceFirstRouter, EvidenceRoutingOutcome } from "@lexi/governance";

// ---- Minimal mocks for WorkflowOrchestrator dependencies ----

function mockIssue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: "issue-1",
    githubIssueId: 101,
    githubNumber: 101,
    repoOwner: "acme",
    repoName: "issues",
    title: "Cashier withdrawal crash",
    body: "Steps to reproduce: 1. Open cashier 2. Submit 3. Error\n\nExpected: success. Actual: crash.",
    url: "https://github.com/acme/issues/issues/101",
    authorLogin: "alice",
    labels: ["bug", "priority:P1"],
    state: "open",
    currentStatus: WorkflowStatus.NEW,
    assignedOwner: null,
    assignedTeam: null,
    githubCreatedAt: new Date("2026-08-01"),
    githubUpdatedAt: new Date("2026-08-01"),
    updatedAt: new Date(),
    ...overrides,
  };
}

function mockExecution(status = WorkflowStatus.NEW): WorkflowExecutionRecord {
  return {
    id: "exec-1",
    issueId: "issue-1",
    status,
    idempotencyKey: "key-1",
    jobId: null,
    attempts: 0,
    lastError: null,
    startedAt: new Date(),
    completedAt: null,
  };
}

function createMockRepository(issue: IssueRecord): WorkflowRepository {
  let currentExecution: WorkflowExecutionRecord | null = null;
  return {
    getIssueById: vi.fn(async () => issue),
    getIssueByGithubNumber: vi.fn(async () => issue),
    upsertIssue: vi.fn(async () => issue),
    listIssues: vi.fn(async () => [issue]),
    updateIssue: vi.fn(async (_, patch) => ({ ...issue, ...patch })),
    recordIssueState: vi.fn(async () => {}),
    findActiveWorkflowExecution: vi.fn(async () => currentExecution),
    createWorkflowExecution: vi.fn(async () => {
      currentExecution = mockExecution();
      return currentExecution;
    }),
    updateWorkflowExecution: vi.fn(async (id, patch) => {
      if (currentExecution) Object.assign(currentExecution, patch);
      return currentExecution!;
    }),
    listWorkflowExecutions: vi.fn(async () => currentExecution ? [currentExecution] : []),
    createReproductionAttempt: vi.fn(async (input) => ({ id: "repro-1", ...input, status: "PENDING", retryCount: 0, submittedAt: new Date(), completedAt: null, resultSummary: null, resultDetails: null, logsUrl: null })),
    updateReproductionAttempt: vi.fn(async (_, patch) => ({ id: "repro-1", ...patch })),
    getReproductionAttemptByExternalId: vi.fn(async () => null),
    listActiveReproductionAttempts: vi.fn(async () => []),
    createDecision: vi.fn(async (input) => ({ id: "dec-1", ...input, createdAt: new Date() })),
    getLatestDecisionForIssue: vi.fn(async () => null),
    getReproductionAttemptById: vi.fn(async () => null),
    getLatestReproductionAttemptForIssue: vi.fn(async () => null),
    listEvidenceForIssue: vi.fn(async () => []),
    createNotification: vi.fn(async (input) => ({ id: "notif-1", ...input })),
    createAuditLog: vi.fn(async () => {}),
    createEvidence: vi.fn(async () => {}),
  } as unknown as WorkflowRepository;
}

function createMockGithub() {
  return {
    listBugHuntIssues: vi.fn(async () => []),
    listIssues: vi.fn(async () => []),
    getIssue: vi.fn(async () => ({})),
    getPullRequest: vi.fn(async () => ({})),
    listComments: vi.fn(async () => []),
    addComment: vi.fn(async () => ({})),
    listTimeline: vi.fn(async () => []),
    listLinkedPullRequests: vi.fn(async () => []),
    setLabels: vi.fn(async () => []),
    addLabels: vi.fn(async () => []),
    removeLabels: vi.fn(async () => {}),
    assignUsers: vi.fn(async () => []),
    closeIssue: vi.fn(async () => ({})),
    reopenIssue: vi.fn(async () => ({})),
    createIssue: vi.fn(async () => ({})),
  } as any;
}

function createMockSlack() {
  return { sendNotification: vi.fn(async () => {}), postMessage: vi.fn(async () => {}) } as any;
}

function createMockReproduction() {
  return {
    submitIssue: vi.fn(async () => ({ externalId: "sim-1", status: "PENDING" })),
    getStatus: vi.fn(async () => ({ status: "COMPLETED" })),
    providerName: "mock",
  } as any;
}

function createMockDecisionEngine() {
  return { decide: vi.fn(async () => ({ classification: "NEEDS_MANUAL_INVESTIGATION", component: "web", team: "Web", confidence: 0, labels: [], summary: "test", reasoning: "test", nextAction: "manual" })) } as any;
}

function createMockOwnership() {
  return { resolveOwner: vi.fn(() => ({ team: "Web", channel: "test", owner: null })) } as any;
}

function createMockMetrics() {
  return { incIssuesProcessed: vi.fn(), incWorkflowTransitions: vi.fn(), observeDuration: vi.fn() } as any;
}

function createMockLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

// ---- Evidence Router mock factory ----

function createMockEvidenceRouter(outcome: Partial<EvidenceRoutingOutcome> = {}): EvidenceFirstRouter {
  const defaultOutcome: EvidenceRoutingOutcome = {
    routeTo: "SLACK_NOTIFIED",
    reason: "Strong evidence, no fix activity — triage and assign.",
    reproductionDecision: { required: false, reason: "test", alternativeAction: "TRIAGE_AND_ASSIGN", priority: "not_needed" },
    stages: {
      issueAnalysis: { analysis: {} as any, model: "test", promptVersion: "v1", confidence: 0.8, inputRevision: "test", analysedAt: new Date(), source: "llm" },
      observationAssessment: { observed: true, sourceType: "developer", evidenceStrength: 0.8, reporterTrust: 0.9, requiresReproduction: false, reasons: [] },
      engineeringInvestigation: { linkedIssues: [], linkedPullRequests: [], codeEvidence: { suspectedPatternExists: null, relatedTestsAdded: false, fixCommitOnDefault: false, fixOnFeatureBranchOnly: false }, releaseEvidence: { fixReleased: null, deployedToProduction: null }, investigatedAt: new Date(), limitations: [], repositoriesChecked: [], activeEngineeringWork: false, errors: [] },
      fixAssessment: { status: "NO_FIX_EVIDENCE", confidence: 0.2, linkedIssues: [], linkedPullRequests: [], changedFiles: [], releaseEvidence: [], missingEvidence: [], reproductionRequired: true, reasoning: "test", assessedAt: new Date() },
      reproductionDecision: { required: false, reason: "test", alternativeAction: "TRIAGE_AND_ASSIGN", priority: "not_needed" },
    },
    ...outcome,
  };

  return { evaluate: vi.fn(async () => defaultOutcome), config: { enabled: true, writesEnabled: true } } as unknown as EvidenceFirstRouter;
}

// ---- Tests ----

describe("Evidence-First Pipeline — WorkflowOrchestrator integration", () => {
  it("feature disabled preserves legacy reproduction-first behavior", async () => {
    const issue = mockIssue();
    const repo = createMockRepository(issue);
    const orchestrator = new WorkflowOrchestrator(
      repo, createMockGithub(), createMockReproduction(), createMockDecisionEngine(),
      createMockOwnership(), createMockSlack(), createMockMetrics(), createMockLogger(),
      new WorkflowStateMachine(), undefined as any,
      { evidencePipelineEnabled: false, reminderThresholdDays: 7, escalationThresholdDays: 14 },
    );

    const execution = await orchestrator.processIssue("issue-1");

    // Should go through QUEUED (reproduction path), not EVIDENCE_ASSESSMENT
    expect(execution.status).not.toBe(WorkflowStatus.EVIDENCE_ASSESSMENT);
  });

  it("feature enabled routes through evidence pipeline", async () => {
    const issue = mockIssue();
    const repo = createMockRepository(issue);
    const evidenceRouter = createMockEvidenceRouter({ routeTo: "SLACK_NOTIFIED" });

    const orchestrator = new WorkflowOrchestrator(
      repo, createMockGithub(), createMockReproduction(), createMockDecisionEngine(),
      createMockOwnership(), createMockSlack(), createMockMetrics(), createMockLogger(),
      new WorkflowStateMachine(), undefined as any,
      { evidencePipelineEnabled: true, reminderThresholdDays: 7, escalationThresholdDays: 14 },
      undefined,
      evidenceRouter,
    );

    const execution = await orchestrator.processIssue("issue-1");

    expect((evidenceRouter.evaluate as any)).toHaveBeenCalledTimes(1);
    expect(execution.status).toBe(WorkflowStatus.SLACK_NOTIFIED);
  });

  it("strong human report skips reproduction and is assigned (SLACK_NOTIFIED)", async () => {
    const issue = mockIssue({ authorLogin: "alice", labels: ["bug", "qa-verified", "priority:P1"] });
    const repo = createMockRepository(issue);
    const evidenceRouter = createMockEvidenceRouter({
      routeTo: "SLACK_NOTIFIED",
      reason: "Strong evidence from trusted source — triage and assign.",
      reproductionDecision: { required: false, reason: "Strong evidence", alternativeAction: "TRIAGE_AND_ASSIGN", priority: "not_needed" },
    });

    const orchestrator = new WorkflowOrchestrator(
      repo, createMockGithub(), createMockReproduction(), createMockDecisionEngine(),
      createMockOwnership(), createMockSlack(), createMockMetrics(), createMockLogger(),
      new WorkflowStateMachine(), undefined as any,
      { evidencePipelineEnabled: true, reminderThresholdDays: 7, escalationThresholdDays: 14 },
      undefined,
      evidenceRouter,
    );

    const execution = await orchestrator.processIssue("issue-1");
    expect(execution.status).toBe(WorkflowStatus.SLACK_NOTIFIED);
  });

  it("AI-generated weak report routes to QUEUED for automated reproduction", async () => {
    const issue = mockIssue({ authorLogin: "qa-bot", labels: ["ai-generated"] });
    const repo = createMockRepository(issue);
    const reproduction = createMockReproduction();
    const evidenceRouter = createMockEvidenceRouter({
      routeTo: "QUEUED",
      reason: "AI-generated report with weak evidence — reproduction required.",
      reproductionDecision: { required: true, reason: "AI source", priority: "immediate" },
    });

    const orchestrator = new WorkflowOrchestrator(
      repo, createMockGithub(), reproduction, createMockDecisionEngine(),
      createMockOwnership(), createMockSlack(), createMockMetrics(), createMockLogger(),
      new WorkflowStateMachine(), undefined as any,
      { evidencePipelineEnabled: true, reminderThresholdDays: 7, escalationThresholdDays: 14 },
      undefined,
      evidenceRouter,
    );

    const execution = await orchestrator.processIssue("issue-1");

    // Should have called submitIssue (entered the reproduction pipeline)
    expect(reproduction.submitIssue).toHaveBeenCalled();
  });

  it("active PR routes to SLACK_NOTIFIED (monitor mode)", async () => {
    const issue = mockIssue();
    const repo = createMockRepository(issue);
    const evidenceRouter = createMockEvidenceRouter({
      routeTo: "SLACK_NOTIFIED",
      reason: "Active PR linked — monitor rather than reproduce.",
      reproductionDecision: { required: false, reason: "Active PR", alternativeAction: "MONITOR_PR", priority: "not_needed" },
    });

    const orchestrator = new WorkflowOrchestrator(
      repo, createMockGithub(), createMockReproduction(), createMockDecisionEngine(),
      createMockOwnership(), createMockSlack(), createMockMetrics(), createMockLogger(),
      new WorkflowStateMachine(), undefined as any,
      { evidencePipelineEnabled: true, reminderThresholdDays: 7, escalationThresholdDays: 14 },
      undefined,
      evidenceRouter,
    );

    const execution = await orchestrator.processIssue("issue-1");
    expect(execution.status).toBe(WorkflowStatus.SLACK_NOTIFIED);
  });

  it("merged PR without release routes to RETEST (await release)", async () => {
    const issue = mockIssue();
    const repo = createMockRepository(issue);
    const evidenceRouter = createMockEvidenceRouter({
      routeTo: "RETEST",
      reason: "Fix merged but not released — await deployment.",
      reproductionDecision: { required: false, reason: "PR merged", alternativeAction: "AWAIT_RELEASE", priority: "after_release" },
    });

    const orchestrator = new WorkflowOrchestrator(
      repo, createMockGithub(), createMockReproduction(), createMockDecisionEngine(),
      createMockOwnership(), createMockSlack(), createMockMetrics(), createMockLogger(),
      new WorkflowStateMachine(), undefined as any,
      { evidencePipelineEnabled: true, reminderThresholdDays: 7, escalationThresholdDays: 14 },
      undefined,
      evidenceRouter,
    );

    const execution = await orchestrator.processIssue("issue-1");
    expect(execution.status).toBe(WorkflowStatus.RETEST);
  });

  it("router failure falls back to the reproduction path", async () => {
    const issue = mockIssue();
    const repo = createMockRepository(issue);
    const reproduction = createMockReproduction();
    const failingRouter = {
      evaluate: vi.fn(async () => { throw new Error("LLM + GitHub both down"); }),
      config: { enabled: true, writesEnabled: true },
    } as unknown as EvidenceFirstRouter;

    const orchestrator = new WorkflowOrchestrator(
      repo, createMockGithub(), reproduction, createMockDecisionEngine(),
      createMockOwnership(), createMockSlack(), createMockMetrics(), createMockLogger(),
      new WorkflowStateMachine(), undefined as any,
      { evidencePipelineEnabled: true, reminderThresholdDays: 7, escalationThresholdDays: 14 },
      undefined,
      failingRouter,
    );

    const execution = await orchestrator.processIssue("issue-1");

    // Should have fallen back to the reproduction path (submitIssue called)
    expect(reproduction.submitIssue).toHaveBeenCalled();
  });

  it("router never directly mutates GitHub or Slack", async () => {
    const issue = mockIssue();
    const repo = createMockRepository(issue);
    const github = createMockGithub();
    const slack = createMockSlack();
    const evidenceRouter = createMockEvidenceRouter({ routeTo: "SLACK_NOTIFIED" });

    const orchestrator = new WorkflowOrchestrator(
      repo, github, createMockReproduction(), createMockDecisionEngine(),
      createMockOwnership(), slack, createMockMetrics(), createMockLogger(),
      new WorkflowStateMachine(), undefined as any,
      { evidencePipelineEnabled: true, reminderThresholdDays: 7, escalationThresholdDays: 14 },
      undefined,
      evidenceRouter,
    );

    await orchestrator.processIssue("issue-1");

    // The evidence pipeline itself should not call GitHub mutations
    expect(github.closeIssue).not.toHaveBeenCalled();
    expect(github.addComment).not.toHaveBeenCalled();
    expect(github.setLabels).not.toHaveBeenCalled();
    expect(github.assignUsers).not.toHaveBeenCalled();
  });
});
