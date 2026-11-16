import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkflowStatus } from "@lexi/database";
import { GitHubProvider, GithubIssueDto } from "@lexi/github";
import { SlackProvider } from "@lexi/slack";
import {
  ReproductionProvider,
  ReproductionResult,
  ReproductionStatus,
} from "@lexi/contracts";
import { AiProvider, Decision, DecisionEngine } from "@lexi/ai";
import { OwnershipResolver, parseOwnershipConfig } from "@lexi/ownership";
import { MetricsRegistry } from "@lexi/metrics";
import { PinoLoggerService } from "@lexi/logger";
import { WorkflowOrchestrator } from "./workflow-orchestrator";
import { InMemoryWorkflowRepository } from "./testing/in-memory-workflow.repository";
import { CrossOrgClosureChecker } from "./cross-org-closure-checker";
import { WorkflowStateMachine } from "./workflow-state-machine";

/**
 * Regression cover for executions parked in WAITING.
 *
 * WAITING is only ever a resting state while an asynchronous provider has work
 * in flight. With a synchronous provider it is a few lines wide, and anything
 * found sitting there is stranded: the retry queue cannot see it (its attempt
 * row is already terminal, and listActiveReproductionAttempts selects only
 * PENDING/RUNNING), so it stays "active" forever and every later process call
 * no-ops against it while reporting success.
 */

const OWNERSHIP_YAML = `
components:
  web:
    team: Web
    channel: web-bug-triage
    owners: [alice-web]
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

const UNNAMED_PROVIDER = "unknown-reproduction-adapter";

function makeGithubIssue(): GithubIssueDto {
  return {
    githubIssueId: 2001,
    githubNumber: 54,
    repoOwner: "acme",
    repoName: "issues",
    title: "Deposit button broken on web",
    body: "Steps to reproduce...",
    url: "https://github.com/acme/issues/issues/54",
    authorLogin: "reporter",
    labels: ["bug", "domain:web"],
    state: "open",
    stateReason: null,
    assignees: [],
    githubCreatedAt: new Date().toISOString(),
    githubUpdatedAt: new Date().toISOString(),
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
    listComments: vi.fn().mockResolvedValue([]),
    addComment: vi.fn().mockResolvedValue({
      id: 1,
      authorLogin: "bot",
      body: "comment",
      createdAt: new Date().toISOString(),
    }),
    listTimeline: vi.fn().mockResolvedValue([]),
    listLinkedPullRequests: vi.fn().mockResolvedValue([]),
    setLabels: vi.fn().mockImplementation(async (_o, _r, _n, labels: string[]) => labels),
    addLabels: vi.fn().mockResolvedValue([]),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    assignUsers: vi.fn().mockImplementation(async (_o, _r, _n, assignees: string[]) => assignees),
    closeIssue: vi.fn().mockResolvedValue({ ...issue, state: "closed" }),
    reopenIssue: vi.fn().mockResolvedValue({ ...issue, state: "open" }),
  } as unknown as GitHubProvider;
}

function makeSlackProvider(): SlackProvider {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, channel: "C1", ts: "111.222" }),
    updateMessage: vi.fn().mockResolvedValue({ ok: true, channel: "C1", ts: "111.222" }),
  };
}

function cannotReproduceResult(): ReproductionResult {
  return {
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
}

function makeDecisionEngine(): DecisionEngine {
  const decision: Decision = {
    classification: "CANNOT_REPRODUCE",
    component: "web",
    team: "Web",
    confidence: 0.91,
    labels: ["bug"],
    summary: "Not reproducible",
    reasoning: "No failure observed",
    nextAction: "Close as cannot reproduce",
  };
  const provider: AiProvider = { generateDecision: vi.fn().mockResolvedValue(decision) };
  return new DecisionEngine(provider, new PinoLoggerService({ level: "silent" }));
}

describe("stranded WAITING executions", () => {
  let repository: InMemoryWorkflowRepository;
  let ownership: OwnershipResolver;
  let metrics: MetricsRegistry;
  let logger: PinoLoggerService;
  let github: GitHubProvider;

  beforeEach(() => {
    repository = new InMemoryWorkflowRepository();
    ownership = new OwnershipResolver(parseOwnershipConfig(OWNERSHIP_YAML));
    metrics = new MetricsRegistry({ collectDefault: false });
    logger = new PinoLoggerService({ level: "silent" });
    github = makeGithubProvider(makeGithubIssue());
  });

  function build(reproduction: ReproductionProvider): WorkflowOrchestrator {
    return new WorkflowOrchestrator(
      repository,
      github,
      reproduction,
      makeDecisionEngine(),
      ownership,
      makeSlackProvider(),
      metrics,
      logger,
      new WorkflowStateMachine(),
      new CrossOrgClosureChecker(github, logger, []),
      { writesEnabled: true },
    );
  }

  async function seedIssue() {
    const issue = makeGithubIssue();
    return repository.upsertIssue({
      githubIssueId: issue.githubIssueId,
      githubNumber: issue.githubNumber,
      repoOwner: issue.repoOwner,
      repoName: issue.repoName,
      title: issue.title,
      body: issue.body,
      url: issue.url,
      authorLogin: issue.authorLogin,
      labels: issue.labels,
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });
  }

  /** Async provider: submission stays PENDING, so WAITING is legitimate. */
  function asyncProvider(pollStatus: ReproductionStatus = "COMPLETED"): ReproductionProvider {
    return {
      submitIssue: vi.fn().mockResolvedValue({ externalId: "async-1", status: "PENDING" }),
      getStatus: vi.fn().mockResolvedValue(pollStatus),
      getResult: vi.fn().mockResolvedValue(cannotReproduceResult()),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("leaves a WAITING execution untouched while its attempt is still PENDING", async () => {
    const reproduction = asyncProvider();
    const orchestrator = build(reproduction);
    const record = await seedIssue();

    const first = await orchestrator.processIssue(record.id);
    expect(first.status).toBe(WorkflowStatus.WAITING);

    // The retry queue owns this one — re-processing must stay a benign no-op
    // rather than double-submitting or force-failing it.
    const second = await orchestrator.processIssue(record.id);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe(WorkflowStatus.WAITING);
    expect(reproduction.submitIssue).toHaveBeenCalledTimes(1);
  });

  it("finalizes an execution stranded in WAITING behind a terminal attempt", async () => {
    const reproduction = asyncProvider("COMPLETED");
    const orchestrator = build(reproduction);
    const record = await seedIssue();

    await orchestrator.processIssue(record.id);

    // Simulate the dropped inline poll: the attempt is terminal, but the
    // execution never moved off WAITING. No poll cycle can pick this up.
    const attempt = Array.from(repository.reproductionAttempts.values())[0];
    await repository.updateReproductionAttempt(attempt.id, { status: "COMPLETED" });

    const recovered = await orchestrator.processIssue(record.id);

    expect(recovered.status).not.toBe(WorkflowStatus.WAITING);
    expect(reproduction.getResult).toHaveBeenCalled();
    // and it did not silently start a second reproduction cycle
    expect(reproduction.submitIssue).toHaveBeenCalledTimes(1);
  });

  it("refuses to finalize a stranded execution from another execution's attempt", async () => {
    const reproduction = asyncProvider("COMPLETED");
    const orchestrator = build(reproduction);
    const record = await seedIssue();

    // A terminal attempt left behind by an earlier, unrelated cycle.
    await repository.createReproductionAttempt({
      issueId: record.id,
      workflowExecutionId: "some-older-execution",
      providerName: UNNAMED_PROVIDER,
      externalId: "stale-1",
      status: "COMPLETED",
    });

    const execution = await repository.createWorkflowExecution(record.id, "key-2");
    await repository.updateWorkflowExecution(execution.id, { status: WorkflowStatus.WAITING });

    const result = await orchestrator.processIssue(record.id);

    expect(result.status).toBe(WorkflowStatus.FAILED);
    expect(result.lastError).toMatch(/belongs to execution some-older-execution/);
    // Crucially it did not decide anything from the other cycle's evidence.
    expect(reproduction.getResult).not.toHaveBeenCalled();
  });

  it("fails a WAITING execution that has no reproduction attempt to poll", async () => {
    const orchestrator = build(asyncProvider());
    const record = await seedIssue();

    const execution = await repository.createWorkflowExecution(record.id, "key-1");
    await repository.updateWorkflowExecution(execution.id, { status: WorkflowStatus.WAITING });

    const result = await orchestrator.processIssue(record.id);

    expect(result.status).toBe(WorkflowStatus.FAILED);
    expect(result.lastError).toMatch(/no reproduction attempt/i);
    // FAILED is excluded from findActiveWorkflowExecution, so it stops blocking
    // the next cycle.
    expect(await repository.findActiveWorkflowExecution(record.id)).toBeNull();
  });

  it("marks the execution FAILED when the inline poll throws, instead of leaving it WAITING", async () => {
    const reproduction: ReproductionProvider = {
      // Synchronous provider: resolves terminally on submit, so the inline poll runs.
      submitIssue: vi.fn().mockResolvedValue({ externalId: "sync-1", status: "COMPLETED" }),
      getStatus: vi.fn().mockRejectedValue(new Error("Unknown reproduction attempt: sync-1")),
      getResult: vi.fn(),
      cancel: vi.fn(),
    };
    const orchestrator = build(reproduction);
    const record = await seedIssue();

    await expect(orchestrator.processIssue(record.id)).rejects.toThrow(/Unknown reproduction attempt/);

    // The caller now reports a failure, and nothing is left looking in-flight.
    expect(await repository.findActiveWorkflowExecution(record.id)).toBeNull();
    const failed = await repository.listWorkflowExecutions({ status: WorkflowStatus.FAILED });
    expect(failed).toHaveLength(1);
    expect(failed[0].lastError).toMatch(/inline reproduction poll failed/i);
  });
});

describe("attempts recorded under a provider that is no longer active", () => {
  let repository: InMemoryWorkflowRepository;
  let logger: PinoLoggerService;
  let github: GitHubProvider;

  beforeEach(() => {
    repository = new InMemoryWorkflowRepository();
    logger = new PinoLoggerService({ level: "silent" });
    github = makeGithubProvider(makeGithubIssue());
  });

  // The provider-switch stall: attempts recorded by one adapter, still PENDING
  // days later because the configured reproduction provider had since been
  // switched to another. The retry queue kept selecting them and kept silently
  // skipping them on the provider guard.
  it("retires the attempt and fails its execution instead of skipping forever", async () => {
    const reproduction: ReproductionProvider = {
      providerName: "llm-reproduction-judge",
      submitIssue: vi.fn(),
      getStatus: vi.fn(),
      getResult: vi.fn(),
      cancel: vi.fn(),
    } as unknown as ReproductionProvider;

    const orchestrator = new WorkflowOrchestrator(
      repository,
      github,
      reproduction,
      makeDecisionEngine(),
      new OwnershipResolver(parseOwnershipConfig(OWNERSHIP_YAML)),
      makeSlackProvider(),
      new MetricsRegistry({ collectDefault: false }),
      logger,
      new WorkflowStateMachine(),
      new CrossOrgClosureChecker(github, logger, []),
      { writesEnabled: true },
    );

    const issue = makeGithubIssue();
    const record = await repository.upsertIssue({
      githubIssueId: issue.githubIssueId,
      githubNumber: issue.githubNumber,
      repoOwner: issue.repoOwner,
      repoName: issue.repoName,
      title: issue.title,
      body: issue.body,
      url: issue.url,
      authorLogin: issue.authorLogin,
      labels: issue.labels,
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    const execution = await repository.createWorkflowExecution(record.id, "stale-key");
    await repository.updateWorkflowExecution(execution.id, { status: WorkflowStatus.WAITING });
    const attempt = await repository.createReproductionAttempt({
      issueId: record.id,
      workflowExecutionId: execution.id,
      providerName: "mock-reproduction-adapter",
      externalId: "sim-555b9f4a-abc",
      status: "PENDING",
    });

    await orchestrator.pollAllActiveReproductions();

    // The dead adapter is never called with a foreign external id.
    expect(reproduction.getStatus).not.toHaveBeenCalled();

    // The attempt is terminal, so the retry queue stops re-selecting it.
    const retired = await repository.getReproductionAttemptById(attempt.id);
    expect(retired?.status).toBe("FAILED");
    expect(retired?.resultDetails).toMatchObject({
      error: "provider_changed",
      outcomeKind: "infra_failure",
      reproduced: null,
      incompleteEvidence: true,
      recordedProvider: "mock-reproduction-adapter",
      activeProvider: "llm-reproduction-judge",
    });
    expect(await repository.listActiveReproductionAttempts()).toHaveLength(0);

    // And the execution stops looking in-flight, so a fresh process can run.
    expect(await repository.findActiveWorkflowExecution(record.id)).toBeNull();
    const failed = await repository.listWorkflowExecutions({ status: WorkflowStatus.FAILED });
    expect(failed).toHaveLength(1);
    expect(failed[0].lastError).toMatch(/no longer active/);
  });
});

describe("pollAllActiveReproductions error isolation", () => {
  let repository: InMemoryWorkflowRepository;
  let logger: PinoLoggerService;

  beforeEach(() => {
    repository = new InMemoryWorkflowRepository();
    logger = new PinoLoggerService({ level: "silent" });
  });

  it("keeps polling the remaining attempts after one throws", async () => {
    const github = makeGithubProvider(makeGithubIssue());
    const reproduction: ReproductionProvider = {
      submitIssue: vi.fn(),
      // The first attempt is unpollable — e.g. provider state lost across a
      // restart. Before the fix this aborted the whole sweep and silently froze
      // every other in-flight issue.
      getStatus: vi.fn().mockImplementation(async (externalId: string) => {
        if (externalId === "poison") throw new Error("Unknown reproduction attempt: poison");
        return "RUNNING";
      }),
      getResult: vi.fn(),
      cancel: vi.fn(),
    };

    const orchestrator = new WorkflowOrchestrator(
      repository,
      github,
      reproduction,
      makeDecisionEngine(),
      new OwnershipResolver(parseOwnershipConfig(OWNERSHIP_YAML)),
      makeSlackProvider(),
      new MetricsRegistry({ collectDefault: false }),
      logger,
      new WorkflowStateMachine(),
      new CrossOrgClosureChecker(github, logger, []),
      { writesEnabled: true },
    );

    const issue = await repository.upsertIssue({
      githubIssueId: 3001,
      githubNumber: 267,
      repoOwner: "acme",
      repoName: "issues",
      title: "t",
      body: "b",
      url: "u",
      authorLogin: "a",
      labels: ["bug"],
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    for (const externalId of ["poison", "healthy-1", "healthy-2"]) {
      await repository.createReproductionAttempt({
        issueId: issue.id,
        workflowExecutionId: null,
        providerName: UNNAMED_PROVIDER,
        externalId,
        status: "PENDING",
      });
    }

    await expect(orchestrator.pollAllActiveReproductions()).resolves.toBe(3);

    const polled = (reproduction.getStatus as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(polled).toContain("poison");
    expect(polled).toContain("healthy-1");
    expect(polled).toContain("healthy-2");
  });
});
