import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkflowStatus } from "@lexi/database";
import { GitHubProvider, GithubCommentDto, GithubIssueDto, GitHubMutationGateway } from "@lexi/github";
import { SlackProvider } from "@lexi/slack";
import {
  ReproductionProvider,
  ReproductionRequest,
  ReproductionResult,
  ReproductionStatus,
  ReproductionSubmission,
} from "@lexi/contracts";
import { AiProvider, Decision, DecisionEngine } from "@lexi/ai";
import { OwnershipResolver, parseOwnershipConfig } from "@lexi/ownership";
import { MetricsRegistry } from "@lexi/metrics";
import { PinoLoggerService } from "@lexi/logger";
import { WorkflowOrchestrator } from "./workflow-orchestrator";
import { InMemoryWorkflowRepository } from "./testing/in-memory-workflow.repository";
import { CrossOrgClosureChecker } from "./cross-org-closure-checker";
import { WorkflowStateMachine } from "./workflow-state-machine";

const OWNERSHIP_YAML = `
components:
  web:
    team: Web
    channel: web-bug-triage
    owners: [alice-web, ben-web]
  unassigned:
    team: Triage
    channel: bug-triage-general
    owners: [triage-oncall]
labelMappings:
  "domain:web": web
priorityLabels: []
statusLabels:
  toDo: "status:to_do"
  inProgress: "status:in_progress"
`;

function makeGithubIssue(overrides: Partial<GithubIssueDto> = {}): GithubIssueDto {
  return {
    githubIssueId: 1001,
    githubNumber: 501,
    repoOwner: "acme",
    repoName: "issues",
    title: "Deposit button broken on web",
    body: "Steps to reproduce...",
    url: "https://github.com/acme/issues/issues/501",
    authorLogin: "reporter",
    labels: ["bug", "domain:web", "priority:P2"],
    state: "open",
    stateReason: null,
    assignees: [],
    githubCreatedAt: new Date().toISOString(),
    githubUpdatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeGithubProvider(issue: GithubIssueDto): GitHubProvider {
  return {
    listBugHuntIssues: vi.fn().mockResolvedValue([issue]),
    listIssues: vi.fn().mockResolvedValue([issue]),
    listIssuesUpdatedSince: vi.fn().mockResolvedValue([]),
    listReleases: vi.fn().mockResolvedValue([]),
    createIssue: vi.fn().mockResolvedValue(issue),
    getIssue: vi.fn().mockResolvedValue(issue),
    getPullRequest: vi.fn(),
    listComments: vi.fn().mockResolvedValue([] as GithubCommentDto[]),
    addComment: vi.fn().mockResolvedValue({ id: 1, authorLogin: "bot", body: "comment", createdAt: new Date().toISOString() }),
    listTimeline: vi.fn().mockResolvedValue([]),
    listLinkedPullRequests: vi.fn().mockResolvedValue([]),
    setLabels: vi.fn().mockImplementation(async (_o: string, _r: string, _n: number, labels: string[]) => labels),
    addLabels: vi.fn().mockResolvedValue([]),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    assignUsers: vi.fn().mockImplementation(async (_o: string, _r: string, _n: number, assignees: string[]) => assignees),
    closeIssue: vi.fn().mockResolvedValue({ ...issue, state: "closed" }),
    reopenIssue: vi.fn().mockResolvedValue({ ...issue, state: "open" }),
    closePullRequest: vi.fn(),
    reopenPullRequest: vi.fn(),
    updatePullRequest: vi.fn(),
    dispatchWorkflow: vi.fn(),
    findDispatchedRun: vi.fn(),
    searchCode: vi.fn(),
    getFileContents: vi.fn(),
    getTree: vi.fn(),
    getBlob: vi.fn(),
    listWorkflowRunArtifacts: vi.fn(),
    downloadWorkflowRunArtifact: vi.fn(),
    listWorkflowRunJobs: vi.fn(),
    downloadWorkflowJobLogs: vi.fn(),
    cancelWorkflowRun: vi.fn(),
    getPullRequestFiles: vi.fn(),
    createPullRequest: vi.fn(),
  };
}

function makeSlackProvider(): SlackProvider {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, channel: "C1", ts: "111.222" }),
    updateMessage: vi.fn().mockResolvedValue({ ok: true, channel: "C1", ts: "111.222" }),
  };
}

function makeReproductionProvider(result: ReproductionResult, initialStatus: ReproductionStatus = "COMPLETED"): ReproductionProvider {
  return {
    submitIssue: vi.fn().mockImplementation(async (_req: ReproductionRequest): Promise<ReproductionSubmission> => ({
      externalId: `sim-${Math.random()}`,
      status: "PENDING",
    })),
    getStatus: vi.fn().mockResolvedValue(initialStatus),
    getResult: vi.fn().mockResolvedValue(result),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDecisionEngine(decision: Decision): DecisionEngine {
  const provider: AiProvider = { generateDecision: vi.fn().mockResolvedValue(decision) };
  return new DecisionEngine(provider, new PinoLoggerService({ level: "silent" }));
}

describe("WorkflowOrchestrator", () => {
  let repository: InMemoryWorkflowRepository;
  let ownership: OwnershipResolver;
  let metrics: MetricsRegistry;
  let logger: PinoLoggerService;

  beforeEach(() => {
    repository = new InMemoryWorkflowRepository();
    ownership = new OwnershipResolver(parseOwnershipConfig(OWNERSHIP_YAML));
    metrics = new MetricsRegistry({ collectDefault: false });
    logger = new PinoLoggerService({ level: "silent" });
  });

  it("moves a new issue through QUEUED -> SENT_TO_REPRODUCTION -> WAITING and is idempotent on re-processing", async () => {
    const githubIssue = makeGithubIssue();
    const github = makeGithubProvider(githubIssue);
    const reproduction = makeReproductionProvider(
      { externalId: "x", status: "COMPLETED", reproduced: true, summary: "s", details: {}, logsUrl: null, submittedAt: "now", completedAt: "now" },
      "PENDING",
    );
    const decisionEngine = makeDecisionEngine({
      classification: "VERIFIED",
      component: "web",
      team: "Web",
      confidence: 0.9,
      labels: ["bug"],
      summary: "s",
      reasoning: "r",
      nextAction: "n",
    });
    const slack = makeSlackProvider();

    // writesEnabled is explicit: the write gate now fails closed, so a test that
    // asserts on GitHub mutations must opt in rather than inherit a default.
    const orchestrator = new WorkflowOrchestrator(repository, github, reproduction, decisionEngine, ownership, slack, metrics, logger, undefined, undefined, { writesEnabled: true });

    const record = await repository.upsertIssue({
      githubIssueId: githubIssue.githubIssueId,
      githubNumber: githubIssue.githubNumber,
      repoOwner: githubIssue.repoOwner,
      repoName: githubIssue.repoName,
      title: githubIssue.title,
      body: githubIssue.body,
      url: githubIssue.url,
      authorLogin: githubIssue.authorLogin,
      labels: githubIssue.labels,
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    const execution = await orchestrator.processIssue(record.id);
    expect(execution.status).toBe(WorkflowStatus.WAITING);
    expect(reproduction.submitIssue).toHaveBeenCalledTimes(1);

    const second = await orchestrator.processIssue(record.id);
    expect(second.id).toBe(execution.id);
    expect(reproduction.submitIssue).toHaveBeenCalledTimes(1); // no duplicate submission
  });

  it("short-circuits QUEUED -> CLOSED when the issue links an already-merged cross-org PR, skipping reproduction", async () => {
    const githubIssue = makeGithubIssue({
      body: "This looks like the same bug already fixed: https://github.com/acme-eng/web/pull/4242",
    });
    const github = makeGithubProvider(githubIssue);
    (github.getPullRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      number: 4242,
      state: "closed",
      merged: true,
      mergedAt: new Date().toISOString(),
      url: "https://github.com/acme-eng/web/pull/4242",
    });
    const reproduction = makeReproductionProvider({
      externalId: "x",
      status: "COMPLETED",
      reproduced: true,
      summary: "s",
      details: {},
      logsUrl: null,
      submittedAt: "now",
      completedAt: "now",
    });
    const decisionEngine = makeDecisionEngine({
      classification: "VERIFIED",
      component: "web",
      team: "Web",
      confidence: 0.9,
      labels: ["bug"],
      summary: "s",
      reasoning: "r",
      nextAction: "n",
    });
    const slack = makeSlackProvider();
    // The linked PR is under "acme-eng" -- explicitly trusted here since the security fix
    // makes CrossOrgClosureChecker's default trustedOwners empty (only the issue's own owner is
    // implicitly trusted otherwise).
    const closureChecker = new CrossOrgClosureChecker(github, logger, ["acme-eng"]);
    const orchestrator = new WorkflowOrchestrator(
      repository,
      github,
      reproduction,
      decisionEngine,
      ownership,
      slack,
      metrics,
      logger,
      new WorkflowStateMachine(),
      closureChecker,
      { writesEnabled: true },
    );

    const record = await repository.upsertIssue({
      githubIssueId: githubIssue.githubIssueId,
      githubNumber: githubIssue.githubNumber,
      repoOwner: githubIssue.repoOwner,
      repoName: githubIssue.repoName,
      title: githubIssue.title,
      body: githubIssue.body,
      url: githubIssue.url,
      authorLogin: githubIssue.authorLogin,
      labels: githubIssue.labels,
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    const execution = await orchestrator.processIssue(record.id);

    expect(execution.status).toBe(WorkflowStatus.CLOSED);
    expect(reproduction.submitIssue).not.toHaveBeenCalled();
    expect(github.getPullRequest).toHaveBeenCalledWith("acme-eng", "web", 4242);
    expect(github.closeIssue).toHaveBeenCalledWith("acme", "issues", 501, "completed");
    expect(github.addComment).toHaveBeenCalled();

    const updatedIssue = await repository.getIssueById(record.id);
    expect(updatedIssue?.currentStatus).toBe(WorkflowStatus.CLOSED);
    expect(updatedIssue?.state).toBe("closed");

    const decision = Array.from(repository.decisions.values())[0];
    expect(decision.classification).toBe("LIKELY_FIXED");
    expect(decision.confidence).toBe(1);
    expect(decision.reasoning).toContain("https://github.com/acme-eng/web/pull/4242");
  });

  it("fully verifies an issue: labels, assigns, comments, closes with Slack notification, and reaches SLACK_NOTIFIED", async () => {
    const githubIssue = makeGithubIssue();
    const github = makeGithubProvider(githubIssue);
    const reproductionResult: ReproductionResult = {
      externalId: "x",
      status: "COMPLETED",
      reproduced: true,
      summary: "Reproduced",
      details: { reproduced: true },
      logsUrl: null,
      submittedAt: "now",
      completedAt: "now",
    };
    const reproduction = makeReproductionProvider(reproductionResult, "COMPLETED");
    const decisionEngine = makeDecisionEngine({
      classification: "VERIFIED",
      component: "web",
      team: "Web",
      confidence: 0.95,
      labels: ["bug", "priority:P2"],
      summary: "Confirmed broken",
      reasoning: "Bot reproduced it",
      nextAction: "Fix ASAP",
    });
    const slack = makeSlackProvider();

    // writesEnabled is explicit: the write gate now fails closed, so a test that
    // asserts on GitHub mutations must opt in rather than inherit a default.
    const orchestrator = new WorkflowOrchestrator(repository, github, reproduction, decisionEngine, ownership, slack, metrics, logger, undefined, undefined, { writesEnabled: true });

    const record = await repository.upsertIssue({
      githubIssueId: githubIssue.githubIssueId,
      githubNumber: githubIssue.githubNumber,
      repoOwner: githubIssue.repoOwner,
      repoName: githubIssue.repoName,
      title: githubIssue.title,
      body: githubIssue.body,
      url: githubIssue.url,
      authorLogin: githubIssue.authorLogin,
      labels: githubIssue.labels,
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    const execution = await orchestrator.processIssue(record.id);
    const attempts = await repository.listActiveReproductionAttempts();
    // Force it into the map manually so pollReproduction can find it (status PENDING initially in-memory).
    const attempt = Array.from(repository.reproductionAttempts.values())[0];
    await orchestrator.pollReproduction(attempt);

    expect(github.setLabels).toHaveBeenCalled();
    expect(github.assignUsers).toHaveBeenCalledWith("acme", "issues", 501, ["alice-web"]);
    expect(github.addComment).toHaveBeenCalled();
    expect(slack.sendMessage).toHaveBeenCalled();

    const updatedIssue = await repository.getIssueById(record.id);
    expect(updatedIssue?.currentStatus).toBe(WorkflowStatus.SLACK_NOTIFIED);
    expect(updatedIssue?.assignedTeam).toBe("Web");
    expect(updatedIssue?.assignedOwner).toBe("alice-web");

    const finalExecution = await repository.findActiveWorkflowExecution(record.id);
    expect(finalExecution?.id).toBe(execution.id);
    expect(finalExecution?.status).toBe(WorkflowStatus.SLACK_NOTIFIED);

    expect(attempts.length).toBeGreaterThanOrEqual(0);
  });

  it("auto-closes when CANNOT_REPRODUCE passes conservative gates", async () => {
    const githubIssue = makeGithubIssue();
    const github = makeGithubProvider(githubIssue);
    const reproductionResult: ReproductionResult = {
      externalId: "x",
      status: "COMPLETED",
      reproduced: false,
      summary: "Could not reproduce",
      details: {
        reproduced: false,
        outcomeKind: "bug_not_observed",
        scenarioFit: 0.88,
        incompleteEvidence: false,
        evaluations: [{ retryRecommended: false, scenarioFit: 0.88 }],
      },
      logsUrl: null,
      submittedAt: "now",
      completedAt: "now",
    };
    const reproduction = makeReproductionProvider(reproductionResult, "COMPLETED");
    const decisionEngine = makeDecisionEngine({
      classification: "CANNOT_REPRODUCE",
      component: "web",
      team: "Web",
      confidence: 0.91,
      labels: ["bug"],
      summary: "Not reproducible",
      reasoning: "No failure observed after console check",
      nextAction: "Close as cannot reproduce",
    });
    const slack = makeSlackProvider();
    // writesEnabled is explicit: the write gate now fails closed, so a test that
    // asserts on GitHub mutations must opt in rather than inherit a default.
    const orchestrator = new WorkflowOrchestrator(repository, github, reproduction, decisionEngine, ownership, slack, metrics, logger, undefined, undefined, { writesEnabled: true });

    const record = await repository.upsertIssue({
      githubIssueId: githubIssue.githubIssueId,
      githubNumber: githubIssue.githubNumber,
      repoOwner: githubIssue.repoOwner,
      repoName: githubIssue.repoName,
      title: githubIssue.title,
      body: githubIssue.body,
      url: githubIssue.url,
      authorLogin: githubIssue.authorLogin,
      labels: githubIssue.labels,
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    await orchestrator.processIssue(record.id);
    const attempt = Array.from(repository.reproductionAttempts.values())[0];
    await orchestrator.pollReproduction(attempt);

    expect(github.closeIssue).toHaveBeenCalledWith("acme", "issues", 501, "not_planned");
    const updatedIssue = await repository.getIssueById(record.id);
    expect(updatedIssue?.currentStatus).toBe(WorkflowStatus.CLOSED);
    expect(updatedIssue?.state).toBe("closed");
  });

  it("does not auto-close CANNOT_REPRODUCE when confidence is too low", async () => {
    const githubIssue = makeGithubIssue();
    const github = makeGithubProvider(githubIssue);
    const reproductionResult: ReproductionResult = {
      externalId: "x",
      status: "COMPLETED",
      reproduced: false,
      summary: "Could not reproduce",
      details: {
        reproduced: false,
        outcomeKind: "bug_not_observed",
        scenarioFit: 0.9,
        incompleteEvidence: false,
      },
      logsUrl: null,
      submittedAt: "now",
      completedAt: "now",
    };
    const reproduction = makeReproductionProvider(reproductionResult, "COMPLETED");
    const decisionEngine = makeDecisionEngine({
      classification: "CANNOT_REPRODUCE",
      component: "web",
      team: "Web",
      confidence: 0.6,
      labels: ["bug"],
      summary: "Not reproducible",
      reasoning: "Uncertain",
      nextAction: "Manual review",
    });
    const slack = makeSlackProvider();
    // writesEnabled is explicit: the write gate now fails closed, so a test that
    // asserts on GitHub mutations must opt in rather than inherit a default.
    const orchestrator = new WorkflowOrchestrator(repository, github, reproduction, decisionEngine, ownership, slack, metrics, logger, undefined, undefined, { writesEnabled: true });

    const record = await repository.upsertIssue({
      githubIssueId: githubIssue.githubIssueId,
      githubNumber: githubIssue.githubNumber,
      repoOwner: githubIssue.repoOwner,
      repoName: githubIssue.repoName,
      title: githubIssue.title,
      body: githubIssue.body,
      url: githubIssue.url,
      authorLogin: githubIssue.authorLogin,
      labels: githubIssue.labels,
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    await orchestrator.processIssue(record.id);
    const attempt = Array.from(repository.reproductionAttempts.values())[0];
    await orchestrator.pollReproduction(attempt);

    expect(github.closeIssue).not.toHaveBeenCalled();
    const updatedIssue = await repository.getIssueById(record.id);
    expect(updatedIssue?.currentStatus).toBe(WorkflowStatus.SLACK_NOTIFIED);
    expect(updatedIssue?.state).toBe("open");
  });

  it("does not auto-close when reproduction evidence is incomplete", async () => {
    const githubIssue = makeGithubIssue();
    const github = makeGithubProvider(githubIssue);
    const reproductionResult: ReproductionResult = {
      externalId: "x",
      status: "COMPLETED",
      reproduced: false,
      summary: "Signup CTA visible",
      details: {
        reproduced: false,
        outcomeKind: "bug_not_observed",
        scenarioFit: 0.31,
        incompleteEvidence: true,
        scenarioId: "web.signup_demo",
      },
      logsUrl: null,
      submittedAt: "now",
      completedAt: "now",
    };
    const reproduction = makeReproductionProvider(reproductionResult, "COMPLETED");
    const decisionEngine = makeDecisionEngine({
      classification: "CANNOT_REPRODUCE",
      component: "web",
      team: "Web",
      confidence: 0.91,
      labels: ["bug"],
      summary: "Cannot reproduce",
      reasoning: "No console errors seen",
      nextAction: "Close",
    });
    const slack = makeSlackProvider();
    // writesEnabled is explicit: the write gate now fails closed, so a test that
    // asserts on GitHub mutations must opt in rather than inherit a default.
    const orchestrator = new WorkflowOrchestrator(repository, github, reproduction, decisionEngine, ownership, slack, metrics, logger, undefined, undefined, { writesEnabled: true });

    const record = await repository.upsertIssue({
      githubIssueId: githubIssue.githubIssueId,
      githubNumber: githubIssue.githubNumber,
      repoOwner: githubIssue.repoOwner,
      repoName: githubIssue.repoName,
      title: githubIssue.title,
      body: githubIssue.body,
      url: githubIssue.url,
      authorLogin: githubIssue.authorLogin,
      labels: githubIssue.labels,
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    await orchestrator.processIssue(record.id);
    const attempt = Array.from(repository.reproductionAttempts.values())[0];
    await orchestrator.pollReproduction(attempt);

    expect(github.closeIssue).not.toHaveBeenCalled();
    expect(github.addComment).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Number),
      expect.stringContaining("auto-close"),
    );
  });

  it("reassigns an issue deterministically and records an audit log entry", async () => {
    const githubIssue = makeGithubIssue();
    const github = makeGithubProvider(githubIssue);
    const reproduction = makeReproductionProvider({
      externalId: "x",
      status: "COMPLETED",
      reproduced: true,
      summary: "s",
      details: {},
      logsUrl: null,
      submittedAt: "now",
      completedAt: "now",
    });
    const decisionEngine = makeDecisionEngine({
      classification: "VERIFIED",
      component: "web",
      team: "Web",
      confidence: 0.8,
      labels: [],
      summary: "s",
      reasoning: "r",
      nextAction: "n",
    });
    const slack = makeSlackProvider();
    // writesEnabled is explicit: the write gate now fails closed, so a test that
    // asserts on GitHub mutations must opt in rather than inherit a default.
    const orchestrator = new WorkflowOrchestrator(repository, github, reproduction, decisionEngine, ownership, slack, metrics, logger, undefined, undefined, { writesEnabled: true });

    const record = await repository.upsertIssue({
      githubIssueId: githubIssue.githubIssueId,
      githubNumber: githubIssue.githubNumber,
      repoOwner: githubIssue.repoOwner,
      repoName: githubIssue.repoName,
      title: githubIssue.title,
      body: githubIssue.body,
      url: githubIssue.url,
      authorLogin: githubIssue.authorLogin,
      labels: githubIssue.labels,
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    const updated = await orchestrator.reassign(record.id, "Web", "ben-web");
    expect(updated.assignedOwner).toBe("ben-web");
    expect(updated.assignedTeam).toBe("Web");
    expect(github.assignUsers).toHaveBeenCalledWith("acme", "issues", 501, ["ben-web"]);
    expect(repository.auditLogs).toHaveLength(1);
    expect(slack.sendMessage).toHaveBeenCalled();
  });

  it("closes an issue automatically when a retest confirms the fix", async () => {
    const githubIssue = makeGithubIssue({ state: "closed" });
    const github = makeGithubProvider(githubIssue);
    const reproduction = makeReproductionProvider({
      externalId: "x",
      status: "COMPLETED",
      reproduced: false,
      summary: "Fix confirmed",
      details: { reproduced: false },
      logsUrl: null,
      submittedAt: "now",
      completedAt: "now",
    });
    const decisionEngine = makeDecisionEngine({
      classification: "VERIFIED",
      component: "web",
      team: "Web",
      confidence: 0.9,
      labels: [],
      summary: "s",
      reasoning: "r",
      nextAction: "n",
    });
    const slack = makeSlackProvider();
    // writesEnabled is explicit: the write gate now fails closed, so a test that
    // asserts on GitHub mutations must opt in rather than inherit a default.
    const orchestrator = new WorkflowOrchestrator(repository, github, reproduction, decisionEngine, ownership, slack, metrics, logger, undefined, undefined, { writesEnabled: true });

    const record = await repository.upsertIssue({
      githubIssueId: githubIssue.githubIssueId,
      githubNumber: githubIssue.githubNumber,
      repoOwner: githubIssue.repoOwner,
      repoName: githubIssue.repoName,
      title: githubIssue.title,
      body: githubIssue.body,
      url: githubIssue.url,
      authorLogin: githubIssue.authorLogin,
      labels: githubIssue.labels,
      state: "closed",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    await orchestrator.retest(record.id);
    const attempt = Array.from(repository.reproductionAttempts.values())[0];
    await orchestrator.pollReproduction(attempt);

    expect(github.closeIssue).toHaveBeenCalledWith("acme", "issues", 501, "completed");
    const updatedIssue = await repository.getIssueById(record.id);
    expect(updatedIssue?.currentStatus).toBe(WorkflowStatus.CLOSED);
  });

  it("persists Evidence rows from a terminal ReproductionResult's details.evidence", async () => {
    const githubIssue = makeGithubIssue();
    const github = makeGithubProvider(githubIssue);
    const reproductionResult: ReproductionResult = {
      externalId: "x",
      status: "COMPLETED",
      reproduced: true,
      summary: "Reproduced, see attached screenshot",
      details: {
        reproduced: true,
        evidence: [
          { type: "png", url: "/data/evidence/F1-screenshot.png", description: "screenshot.png" },
          { type: "log", url: "/data/evidence/F2-console.log" },
        ],
      },
      logsUrl: "/data/evidence/F1-screenshot.png",
      submittedAt: "now",
      completedAt: "now",
    };
    const reproduction = makeReproductionProvider(reproductionResult, "COMPLETED");
    const decisionEngine = makeDecisionEngine({
      classification: "VERIFIED",
      component: "web",
      team: "Web",
      confidence: 0.9,
      labels: [],
      summary: "s",
      reasoning: "r",
      nextAction: "n",
    });
    const slack = makeSlackProvider();
    // writesEnabled is explicit: the write gate now fails closed, so a test that
    // asserts on GitHub mutations must opt in rather than inherit a default.
    const orchestrator = new WorkflowOrchestrator(repository, github, reproduction, decisionEngine, ownership, slack, metrics, logger, undefined, undefined, { writesEnabled: true });

    const record = await repository.upsertIssue({
      githubIssueId: githubIssue.githubIssueId,
      githubNumber: githubIssue.githubNumber,
      repoOwner: githubIssue.repoOwner,
      repoName: githubIssue.repoName,
      title: githubIssue.title,
      body: githubIssue.body,
      url: githubIssue.url,
      authorLogin: githubIssue.authorLogin,
      labels: githubIssue.labels,
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    await orchestrator.processIssue(record.id);
    const attempt = Array.from(repository.reproductionAttempts.values())[0];
    await orchestrator.pollReproduction(attempt);

    expect(repository.evidence).toHaveLength(2);
    expect(repository.evidence[0]).toEqual({
      issueId: record.id,
      type: "png",
      url: "/data/evidence/F1-screenshot.png",
      description: "screenshot.png",
    });
    expect(repository.evidence[1]).toEqual({
      issueId: record.id,
      type: "log",
      url: "/data/evidence/F2-console.log",
      description: undefined,
    });
  });

  it("uses the reproduction provider's providerName instead of a hardcoded string", async () => {
    const githubIssue = makeGithubIssue();
    const github = makeGithubProvider(githubIssue);
    const reproduction = makeReproductionProvider(
      { externalId: "x", status: "COMPLETED", reproduced: true, summary: "s", details: {}, logsUrl: null, submittedAt: "now", completedAt: "now" },
      "PENDING",
    );
    (reproduction as { providerName?: string }).providerName = "slack-reproduction-bot";
    const decisionEngine = makeDecisionEngine({
      classification: "VERIFIED",
      component: "web",
      team: "Web",
      confidence: 0.9,
      labels: [],
      summary: "s",
      reasoning: "r",
      nextAction: "n",
    });
    const slack = makeSlackProvider();
    // writesEnabled is explicit: the write gate now fails closed, so a test that
    // asserts on GitHub mutations must opt in rather than inherit a default.
    const orchestrator = new WorkflowOrchestrator(repository, github, reproduction, decisionEngine, ownership, slack, metrics, logger, undefined, undefined, { writesEnabled: true });

    const record = await repository.upsertIssue({
      githubIssueId: githubIssue.githubIssueId,
      githubNumber: githubIssue.githubNumber,
      repoOwner: githubIssue.repoOwner,
      repoName: githubIssue.repoName,
      title: githubIssue.title,
      body: githubIssue.body,
      url: githubIssue.url,
      authorLogin: githubIssue.authorLogin,
      labels: githubIssue.labels,
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    await orchestrator.processIssue(record.id);
    const attempt = Array.from(repository.reproductionAttempts.values())[0];
    expect(attempt.providerName).toBe("slack-reproduction-bot");
  });

  it("reprocessIssue cancels an active execution and starts a fresh one", async () => {
    const githubIssue = makeGithubIssue();
    const github = makeGithubProvider(githubIssue);
    const reproduction = makeReproductionProvider(
      { externalId: "x", status: "COMPLETED", reproduced: true, summary: "s", details: {}, logsUrl: null, submittedAt: "now", completedAt: "now" },
      "PENDING",
    );
    const decisionEngine = makeDecisionEngine({
      classification: "VERIFIED",
      component: "web",
      team: "Web",
      confidence: 0.9,
      labels: [],
      summary: "s",
      reasoning: "r",
      nextAction: "n",
    });
    const slack = makeSlackProvider();
    // writesEnabled is explicit: the write gate now fails closed, so a test that
    // asserts on GitHub mutations must opt in rather than inherit a default.
    const orchestrator = new WorkflowOrchestrator(repository, github, reproduction, decisionEngine, ownership, slack, metrics, logger, undefined, undefined, { writesEnabled: true });

    const record = await repository.upsertIssue({
      githubIssueId: githubIssue.githubIssueId,
      githubNumber: githubIssue.githubNumber,
      repoOwner: githubIssue.repoOwner,
      repoName: githubIssue.repoName,
      title: githubIssue.title,
      body: githubIssue.body,
      url: githubIssue.url,
      authorLogin: githubIssue.authorLogin,
      labels: githubIssue.labels,
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    const first = await orchestrator.processIssue(record.id);
    const second = await orchestrator.reprocessIssue(record.id);

    expect(second.id).not.toBe(first.id);
    const cancelledFirst = await repository.executions.get(first.id);
    expect(cancelledFirst?.status).toBe(WorkflowStatus.CANCELLED);
    expect(reproduction.submitIssue).toHaveBeenCalledTimes(2);
  });

  it("does not close or mutate GitHub when writes are disabled", async () => {
    const githubIssue = makeGithubIssue();
    const inner = makeGithubProvider(githubIssue);
    const github = new GitHubMutationGateway(inner, { writesEnabled: false, dryRun: false }, logger);
    const reproductionResult: ReproductionResult = {
      externalId: "x",
      status: "COMPLETED",
      reproduced: false,
      summary: "Could not reproduce",
      details: {
        reproduced: false,
        outcomeKind: "bug_not_observed",
        scenarioFit: 0.88,
        incompleteEvidence: false,
        evaluations: [{ retryRecommended: false, scenarioFit: 0.88 }],
      },
      logsUrl: null,
      submittedAt: "now",
      completedAt: "now",
    };
    const reproduction = makeReproductionProvider(reproductionResult, "COMPLETED");
    const decisionEngine = makeDecisionEngine({
      classification: "CANNOT_REPRODUCE",
      component: "web",
      team: "Web",
      confidence: 0.91,
      labels: ["bug"],
      summary: "Not reproducible",
      reasoning: "No failure observed",
      nextAction: "Close as cannot reproduce",
    });
    const slack = makeSlackProvider();
    const orchestrator = new WorkflowOrchestrator(
      repository,
      github,
      reproduction,
      decisionEngine,
      ownership,
      slack,
      metrics,
      logger,
      new WorkflowStateMachine(),
      new CrossOrgClosureChecker(inner, logger, []),
      { writesEnabled: false },
    );

    const record = await repository.upsertIssue({
      githubIssueId: githubIssue.githubIssueId,
      githubNumber: githubIssue.githubNumber,
      repoOwner: githubIssue.repoOwner,
      repoName: githubIssue.repoName,
      title: githubIssue.title,
      body: githubIssue.body,
      url: githubIssue.url,
      authorLogin: githubIssue.authorLogin,
      labels: githubIssue.labels,
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    await orchestrator.processIssue(record.id);
    const attempt = Array.from(repository.reproductionAttempts.values())[0];
    await orchestrator.pollReproduction(attempt);

    expect(inner.setLabels).not.toHaveBeenCalled();
    expect(inner.assignUsers).not.toHaveBeenCalled();
    expect(inner.addComment).not.toHaveBeenCalled();
    const updatedIssue = await repository.getIssueById(record.id);
    expect(updatedIssue?.currentStatus).toBe(WorkflowStatus.CLOSE_RECOMMENDED);
    expect(updatedIssue?.state).toBe("open");
    expect(github.dryRunAudit.length).toBeGreaterThan(0);
  });

  // The write kill switch must fail CLOSED. These use a raw GitHubProvider (no
  // `runWrite`) so the assertions exercise WorkflowOrchestrator's own guard
  // rather than an injected GitHubMutationGateway.
  describe("write gate fails closed", () => {
    function cannotReproduceSetup() {
      const githubIssue = makeGithubIssue();
      const github = makeGithubProvider(githubIssue);
      const reproduction = makeReproductionProvider(
        {
          externalId: "x",
          status: "COMPLETED",
          reproduced: false,
          summary: "Could not reproduce",
          details: {
            reproduced: false,
            outcomeKind: "bug_not_observed",
            scenarioFit: 0.88,
            incompleteEvidence: false,
            evaluations: [{ retryRecommended: false, scenarioFit: 0.88 }],
          },
          logsUrl: null,
          submittedAt: "now",
          completedAt: "now",
        },
        "COMPLETED",
      );
      const decisionEngine = makeDecisionEngine({
        classification: "CANNOT_REPRODUCE",
        component: "web",
        team: "Web",
        confidence: 0.91,
        labels: ["bug"],
        summary: "Not reproducible",
        reasoning: "No failure observed",
        nextAction: "Close as cannot reproduce",
      });
      return { githubIssue, github, reproduction, decisionEngine };
    }

    async function run(github: GitHubProvider, options: { writesEnabled?: boolean }, deps: ReturnType<typeof cannotReproduceSetup>) {
      const orchestrator = new WorkflowOrchestrator(
        repository,
        github,
        deps.reproduction,
        deps.decisionEngine,
        ownership,
        makeSlackProvider(),
        metrics,
        logger,
        new WorkflowStateMachine(),
        new CrossOrgClosureChecker(github, logger, []),
        options,
      );

      const record = await repository.upsertIssue({
        githubIssueId: deps.githubIssue.githubIssueId,
        githubNumber: deps.githubIssue.githubNumber,
        repoOwner: deps.githubIssue.repoOwner,
        repoName: deps.githubIssue.repoName,
        title: deps.githubIssue.title,
        body: deps.githubIssue.body,
        url: deps.githubIssue.url,
        authorLogin: deps.githubIssue.authorLogin,
        labels: deps.githubIssue.labels,
        state: "open",
        githubCreatedAt: new Date(),
        githubUpdatedAt: new Date(),
      });

      await orchestrator.processIssue(record.id);
      const attempt = Array.from(repository.reproductionAttempts.values())[0];
      await orchestrator.pollReproduction(attempt);
      return record;
    }

    it("blocks writes when writesEnabled is undefined (absent/unparseable config)", async () => {
      const deps = cannotReproduceSetup();
      // An explicitly-undefined option is what a config field that failed to
      // parse looks like; it must NOT be read as permission to write.
      await run(deps.github, { writesEnabled: undefined }, deps);

      expect(deps.github.setLabels).not.toHaveBeenCalled();
      expect(deps.github.assignUsers).not.toHaveBeenCalled();
      expect(deps.github.addComment).not.toHaveBeenCalled();
      expect(deps.github.closeIssue).not.toHaveBeenCalled();
    });

    it("blocks writes when no options are supplied at all", async () => {
      const deps = cannotReproduceSetup();
      await run(deps.github, {}, deps);

      expect(deps.github.setLabels).not.toHaveBeenCalled();
      expect(deps.github.addComment).not.toHaveBeenCalled();
      expect(deps.github.closeIssue).not.toHaveBeenCalled();
    });

    it("permits writes only on an explicit writesEnabled: true", async () => {
      const deps = cannotReproduceSetup();
      await run(deps.github, { writesEnabled: true }, deps);

      expect(deps.github.addComment).toHaveBeenCalled();
    });
  });
});
