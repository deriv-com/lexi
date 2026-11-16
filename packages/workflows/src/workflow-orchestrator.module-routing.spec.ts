/**
 * Two-dimensional (module x platform) triage routing.
 *
 * `OwnershipResolver.resolveModuleOwnership(module, platform)` had zero
 * production callers: every bug routed through the legacy one-dimensional
 * `resolve()`, so a Portfolio bug on mobile was assigned to the *web* PIC.
 * These tests pin the orchestrator's half of that contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkflowStatus } from "@lexi/database";
import { GitHubProvider, GithubCommentDto, GithubIssueDto } from "@lexi/github";
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
import type {
  ModuleRouter,
  ModuleRoutingInference,
  ModuleLabelWriteOutcome,
  ModuleRoutingTarget,
} from "./workflow-orchestrator";
import { InMemoryWorkflowRepository } from "./testing/in-memory-workflow.repository";

/**
 * Two-dimensional config. `portfolio` is the case from the field report:
 * carol owns it on web, dave on mobile. A single `component` key cannot
 * express that, which is the whole reason for this restructure.
 */
const TWO_D_OWNERSHIP_YAML = `
platforms:
  web:
    team: Web
    channel: "#team-web"
    channelId: CWEB123
    teamLead: alice
  mobile:
    team: Mobile
    channel: "#team-mobile"
    channelId: CMOB456
    teamLead: bob
defaultModule: default
defaultPlatform: web
modules:
  default:
    description: Fallback
    web: { pic: alice }
    mobile: { pic: bob }
  portfolio:
    description: Portfolio, open positions and P&L
    web: { pic: carol }
    mobile: { pic: dave }
    keywords: [portfolio, open position]
    paths: ["/portfolio"]
labelMappings:
  "domain:web": web
  "domain:mobile": mobile
priorityLabels: []
statusLabels:
  toDo: "status:to_do"
  inProgress: "status:in_progress"
`;

/** Legacy components-only config — the shape every existing spec still uses. */
const LEGACY_OWNERSHIP_YAML = `
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
    githubIssueId: 2001,
    githubNumber: 777,
    repoOwner: "acme",
    repoName: "issues",
    title: "Open positions list shows stale P&L",
    body: "Portfolio page does not refresh",
    url: "https://github.com/acme/issues/issues/777",
    authorLogin: "reporter",
    labels: ["bug", "domain:mobile"],
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
    addComment: vi.fn().mockResolvedValue({ id: 1, authorLogin: "bot", body: "c", createdAt: new Date().toISOString() }),
    listTimeline: vi.fn().mockResolvedValue([]),
    listLinkedPullRequests: vi.fn().mockResolvedValue([]),
    setLabels: vi.fn().mockImplementation(async (_o: string, _r: string, _n: number, labels: string[]) => labels),
    addLabels: vi.fn().mockResolvedValue([]),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    assignUsers: vi.fn().mockImplementation(async (_o: string, _r: string, _n: number, a: string[]) => a),
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

function makeReproductionProvider(
  result: ReproductionResult,
  initialStatus: ReproductionStatus = "COMPLETED",
): ReproductionProvider {
  return {
    submitIssue: vi.fn().mockImplementation(async (_r: ReproductionRequest): Promise<ReproductionSubmission> => ({
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

const REPRODUCED: ReproductionResult = {
  externalId: "x",
  status: "COMPLETED",
  reproduced: true,
  summary: "Reproduced",
  details: { reproduced: true },
  logsUrl: null,
  submittedAt: "now",
  completedAt: "now",
};

function verifiedDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    classification: "VERIFIED",
    component: "web",
    team: "Web",
    confidence: 0.95,
    labels: ["bug"],
    summary: "Confirmed",
    reasoning: "Bot reproduced it",
    nextAction: "Fix",
    ...overrides,
  };
}

/**
 * Stand-in for `ModuleInferenceService` (which lives in the host application and
 * so cannot be imported by a package). Records what the orchestrator asked it,
 * which is how the label-forwarding and no-write-on-fallback guards are checked.
 */
class FakeModuleRouter implements ModuleRouter {
  readonly inferCalls: Array<{ title?: string; body?: string; labels?: string[] }> = [];
  readonly applyCalls: Array<{ target: ModuleRoutingTarget; inference: ModuleRoutingInference }> = [];

  constructor(private readonly answer: ModuleRoutingInference) {}

  async infer(input: { title?: string; body?: string; labels?: string[]; paths?: string[] }): Promise<ModuleRoutingInference> {
    this.inferCalls.push(input);
    return this.answer;
  }

  /** Mirrors the real service: a fallback inference is never written back. */
  async applyModuleLabel(
    _github: GitHubProvider,
    target: ModuleRoutingTarget,
    inference: ModuleRoutingInference,
  ): Promise<ModuleLabelWriteOutcome> {
    this.applyCalls.push({ target, inference });
    const label = `module:${inference.module}`;
    if (inference.isFallback) {
      return { executed: false, label, reason: "fallback — a guess must not be recorded as fact" };
    }
    return { executed: true, label };
  }
}

function inference(overrides: Partial<ModuleRoutingInference> = {}): ModuleRoutingInference {
  return {
    module: "portfolio",
    platform: "mobile",
    confidence: 0.8,
    method: "heuristic",
    evidence: ['keyword "portfolio"'],
    isFallback: false,
    platformMethod: "label",
    ...overrides,
  };
}

describe("WorkflowOrchestrator — (module x platform) routing", () => {
  let repository: InMemoryWorkflowRepository;
  let metrics: MetricsRegistry;
  let logger: PinoLoggerService;

  beforeEach(() => {
    repository = new InMemoryWorkflowRepository();
    metrics = new MetricsRegistry({ collectDefault: false });
    logger = new PinoLoggerService({ level: "silent" });
  });

  async function driveToDecision(opts: {
    ownershipYaml: string;
    router?: ModuleRouter;
    issue?: GithubIssueDto;
    decision?: Decision;
  }) {
    const githubIssue = opts.issue ?? makeGithubIssue();
    const github = makeGithubProvider(githubIssue);
    const slack = makeSlackProvider();
    const orchestrator = new WorkflowOrchestrator(
      repository,
      github,
      makeReproductionProvider(REPRODUCED, "COMPLETED"),
      makeDecisionEngine(opts.decision ?? verifiedDecision()),
      new OwnershipResolver(parseOwnershipConfig(opts.ownershipYaml)),
      slack,
      metrics,
      logger,
      undefined,
      undefined,
      { writesEnabled: true },
      undefined,
      undefined,
      opts.router,
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

    return {
      github,
      slack,
      record,
      orchestrator,
      decision: Array.from(repository.decisions.values())[0],
      issueAfter: await repository.getIssueById(record.id),
    };
  }

  it("assigns the mobile PIC — not the web PIC — for a Portfolio bug on mobile", async () => {
    const router = new FakeModuleRouter(inference({ module: "portfolio", platform: "mobile" }));
    const { github, issueAfter } = await driveToDecision({ ownershipYaml: TWO_D_OWNERSHIP_YAML, router });

    expect(github.assignUsers).toHaveBeenCalledWith("acme", "issues", 777, ["dave"]);
    expect(issueAfter?.assignedOwner).toBe("dave");
    expect(issueAfter?.assignedTeam).toBe("Mobile");
  });

  it("assigns the web PIC for the same module on web", async () => {
    const router = new FakeModuleRouter(inference({ module: "portfolio", platform: "web" }));
    const { github, issueAfter } = await driveToDecision({
      ownershipYaml: TWO_D_OWNERSHIP_YAML,
      router,
      issue: makeGithubIssue({ labels: ["bug", "domain:web"] }),
    });

    expect(github.assignUsers).toHaveBeenCalledWith("acme", "issues", 777, ["carol"]);
    expect(issueAfter?.assignedTeam).toBe("Web");
  });

  it("notifies the platform channel resolved two-dimensionally", async () => {
    const router = new FakeModuleRouter(inference({ platform: "mobile" }));
    const { slack } = await driveToDecision({ ownershipYaml: TWO_D_OWNERSHIP_YAML, router });

    const channels = (slack.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].channel);
    expect(channels).toContain("#team-mobile");
    expect(channels).not.toContain("#team-web");
  });

  // GUARD: a `domain:*` label is authoritative. The injected router is a port,
  // and a future implementation of it may weigh prose over labels.
  it("lets a domain:* label override the router's platform", async () => {
    const router = new FakeModuleRouter(inference({ module: "portfolio", platform: "web", platformMethod: "heuristic" }));
    const { github, issueAfter } = await driveToDecision({
      ownershipYaml: TWO_D_OWNERSHIP_YAML,
      router,
      issue: makeGithubIssue({ labels: ["bug", "domain:mobile"] }),
    });

    expect(github.assignUsers).toHaveBeenCalledWith("acme", "issues", 777, ["dave"]);
    expect(issueAfter?.assignedTeam).toBe("Mobile");
  });

  it("forwards the issue's labels to the router so it can read domain:* and module:*", async () => {
    const router = new FakeModuleRouter(inference());
    await driveToDecision({ ownershipYaml: TWO_D_OWNERSHIP_YAML, router });

    expect(router.inferCalls.length).toBeGreaterThan(0);
    expect(router.inferCalls[0].labels).toEqual(["bug", "domain:mobile"]);
    expect(router.inferCalls[0].title).toBe("Open positions list shows stale P&L");
  });

  // GUARD: never harden a guess into the authoritative pass-1 answer.
  it("does not write a module label for a fallback inference", async () => {
    const router = new FakeModuleRouter(
      inference({ module: "default", isFallback: true, confidence: 0.2, method: "heuristic" }),
    );
    const { github } = await driveToDecision({ ownershipYaml: TWO_D_OWNERSHIP_YAML, router });

    // The orchestrator must not even ask: the router refuses a fallback too,
    // but it is an injected port and this is the side that does the writing.
    expect(router.applyCalls).toEqual([]);
    const written = (github.addLabels as ReturnType<typeof vi.fn>).mock.calls.flatMap((c) => c[3] ?? []);
    expect(written).not.toContain("module:default");
    const setLabelled = (github.setLabels as ReturnType<typeof vi.fn>).mock.calls.flatMap((c) => c[3] ?? []);
    expect(setLabelled.filter((l: string) => l.startsWith("module:"))).toEqual([]);
  });

  it("applies the module label through the router (the governed runWrite seam) for a confident inference", async () => {
    const router = new FakeModuleRouter(inference({ module: "portfolio" }));
    const { github } = await driveToDecision({ ownershipYaml: TWO_D_OWNERSHIP_YAML, router });

    expect(router.applyCalls).toHaveLength(1);
    expect(router.applyCalls[0].target).toMatchObject({
      owner: "acme",
      repo: "issues",
      issueNumber: 777,
    });
    // ...and the freshly-applied label survives the subsequent setLabels sweep,
    // which is computed from the (now stale) issue.labels snapshot.
    const setLabelled = (github.setLabels as ReturnType<typeof vi.fn>).mock.calls.flatMap((c) => c[3] ?? []);
    expect(setLabelled).toContain("module:portfolio");
  });

  // GUARD: `component` is a PERSISTED column that a year of rows already use
  // with the legacy meaning. It must not silently become the module key.
  it("keeps writing the legacy component to the persisted decision column", async () => {
    const router = new FakeModuleRouter(inference({ module: "portfolio", platform: "mobile" }));
    const { decision } = await driveToDecision({ ownershipYaml: TWO_D_OWNERSHIP_YAML, router });

    expect(decision.component).toBe("mobile");
    expect(decision.component).not.toBe("portfolio");
    // Team/owner are the two-dimensional answer; only `component` stays legacy.
    expect(decision.team).toBe("Mobile");
    expect(decision.owner).toBe("dave");
    // The module is still recoverable from the row, via the reasoning text.
    expect(decision.reasoning).toContain("portfolio");
  });

  // GUARD: an optional dependency must degrade, not crash. Both expectations
  // below are TODAY's one-dimensional answer, captured before the change:
  // no label maps (`domain:mobile` is unmapped in the legacy config), so the
  // AI's suggested component "web" wins and the owner is a round-robin pick.
  it("degrades to one-dimensional routing when no router is injected", async () => {
    const { github, issueAfter, decision } = await driveToDecision({ ownershipYaml: LEGACY_OWNERSHIP_YAML });

    expect(github.assignUsers).toHaveBeenCalledWith("acme", "issues", 777, ["alice-web"]);
    expect(issueAfter?.assignedTeam).toBe("Web");
    expect(decision.component).toBe("web");
  });

  it("degrades to one-dimensional routing when the config has no platforms block", async () => {
    const router = new FakeModuleRouter(inference());
    const { issueAfter, decision } = await driveToDecision({ ownershipYaml: LEGACY_OWNERSHIP_YAML, router });

    // resolveModuleOwnership throws on a components-only config; that must not
    // reach the caller as a failed triage run.
    expect(issueAfter?.currentStatus).toBe(WorkflowStatus.SLACK_NOTIFIED);
    expect(decision.component).toBe("web");
    expect(decision.team).toBe("Web");
  });

  it("degrades when the router itself throws", async () => {
    const router: ModuleRouter = {
      infer: vi.fn().mockRejectedValue(new Error("inference backend down")),
      applyModuleLabel: vi.fn(),
    };
    const { issueAfter, decision } = await driveToDecision({ ownershipYaml: TWO_D_OWNERSHIP_YAML, router });

    expect(issueAfter?.currentStatus).toBe(WorkflowStatus.SLACK_NOTIFIED);
    // Falls back to the legacy label-derived answer rather than failing.
    expect(decision.component).toBe("mobile");
  });

  it("routes the progress-check reminder to the two-dimensional platform channel", async () => {
    const router = new FakeModuleRouter(inference({ platform: "mobile" }));
    // No `domain:*` label: the router is the only thing that can say "mobile".
    const githubIssue = makeGithubIssue({ labels: ["bug"] });
    const github = makeGithubProvider(githubIssue);
    const slack = makeSlackProvider();
    const orchestrator = new WorkflowOrchestrator(
      repository,
      github,
      makeReproductionProvider(REPRODUCED),
      makeDecisionEngine(verifiedDecision()),
      new OwnershipResolver(parseOwnershipConfig(TWO_D_OWNERSHIP_YAML)),
      slack,
      metrics,
      logger,
      undefined,
      undefined,
      { writesEnabled: true, reminderThresholdDays: 0, escalationThresholdDays: 999 },
      undefined,
      undefined,
      router,
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
    await repository.updateIssue(record.id, { currentStatus: WorkflowStatus.SLACK_NOTIFIED });

    await orchestrator.runProgressCheck(record.id);

    const channels = (slack.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].channel);
    expect(channels).toContain("#team-mobile");
  });

  it("routes a reassignment announcement to the two-dimensional platform channel", async () => {
    const router = new FakeModuleRouter(inference({ platform: "mobile" }));
    // No `domain:*` label: the router is the only thing that can say "mobile".
    const githubIssue = makeGithubIssue({ labels: ["bug"] });
    const github = makeGithubProvider(githubIssue);
    const slack = makeSlackProvider();
    const orchestrator = new WorkflowOrchestrator(
      repository,
      github,
      makeReproductionProvider(REPRODUCED),
      makeDecisionEngine(verifiedDecision()),
      new OwnershipResolver(parseOwnershipConfig(TWO_D_OWNERSHIP_YAML)),
      slack,
      metrics,
      logger,
      undefined,
      undefined,
      { writesEnabled: true },
      undefined,
      undefined,
      router,
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

    await orchestrator.reassign(record.id);

    const channels = (slack.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].channel);
    expect(channels).toContain("#team-mobile");
  });

  // Without a router, `reassign()` must keep picking from the legacy pool.
  it("reassign falls back to the module PIC when no explicit owner is given", async () => {
    const router = new FakeModuleRouter(inference({ module: "portfolio", platform: "mobile" }));
    const githubIssue = makeGithubIssue({ labels: ["bug"] });
    const github = makeGithubProvider(githubIssue);
    const orchestrator = new WorkflowOrchestrator(
      repository,
      github,
      makeReproductionProvider(REPRODUCED),
      makeDecisionEngine(verifiedDecision()),
      new OwnershipResolver(parseOwnershipConfig(TWO_D_OWNERSHIP_YAML)),
      makeSlackProvider(),
      metrics,
      logger,
      undefined,
      undefined,
      { writesEnabled: true },
      undefined,
      undefined,
      router,
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

    const updated = await orchestrator.reassign(record.id);
    expect(updated.assignedOwner).toBe("dave");
    expect(updated.assignedTeam).toBe("Mobile");
  });
});
