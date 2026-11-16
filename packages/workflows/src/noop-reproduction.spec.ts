import { describe, expect, it, vi } from "vitest";
import { WorkflowStatus } from "@lexi/database";
import { GitHubProvider, GithubCommentDto, GithubIssueDto } from "@lexi/github";
import { SlackProvider } from "@lexi/slack";
import { NoopReproductionProvider } from "@lexi/governance";
import { AiProvider, Decision, DecisionEngine } from "@lexi/ai";
import { OwnershipResolver, parseOwnershipConfig } from "@lexi/ownership";
import { MetricsRegistry } from "@lexi/metrics";
import { PinoLoggerService } from "@lexi/logger";
import { WorkflowOrchestrator } from "./workflow-orchestrator";
import { InMemoryWorkflowRepository } from "./testing/in-memory-workflow.repository";

/**
 * A deployment with no reproduction adapter runs the engine against the
 * NoopReproductionProvider. Every submission completes at once as "not
 * reproduced, no reproduction attempted", so the cycle must finish in one
 * `processIssue` call — and "nothing was checked" must never be mistaken for
 * "checked and not seen": the issue stays open.
 */

const OWNERSHIP_YAML = `
components:
  web:
    team: Web
    channel: web-bug-triage
    owners: [alice]
  unassigned:
    team: Triage
    channel: bug-triage-general
    owners: [bob]
labelMappings:
  "domain:web": web
priorityLabels: []
statusLabels:
  toDo: "status:to_do"
  inProgress: "status:in_progress"
`;

const ISSUE: GithubIssueDto = {
  githubIssueId: 2001,
  githubNumber: 42,
  repoOwner: "acme",
  repoName: "web",
  title: "Save button does nothing",
  body: "Steps to reproduce: open settings, press Save. Expected: saved. Actual: nothing happens.",
  url: "https://github.com/acme/web/issues/42",
  authorLogin: "alice",
  labels: ["bug", "domain:web"],
  state: "open",
  stateReason: null,
  assignees: [],
  githubCreatedAt: new Date().toISOString(),
  githubUpdatedAt: new Date().toISOString(),
};

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
    sendMessage: vi.fn().mockResolvedValue({ ok: true, channel: "C0TEST01", ts: "111.222" }),
    updateMessage: vi.fn().mockResolvedValue({ ok: true, channel: "C0TEST01", ts: "111.222" }),
  };
}

function makeDecisionEngine(decision: Decision): DecisionEngine {
  const provider: AiProvider = { generateDecision: vi.fn().mockResolvedValue(decision) };
  return new DecisionEngine(provider, new PinoLoggerService({ level: "silent" }));
}

describe("WorkflowOrchestrator with the NoopReproductionProvider", () => {
  it("finishes the cycle in one call and never closes an issue nothing reproduced", async () => {
    const repository = new InMemoryWorkflowRepository();
    const github = makeGithubProvider(ISSUE);
    const reproduction = new NoopReproductionProvider();
    const submitSpy = vi.spyOn(reproduction, "submitIssue");

    const orchestrator = new WorkflowOrchestrator(
      repository,
      github,
      reproduction,
      // Even a confident "cannot reproduce" from the judge must not close an
      // issue when the reproduction provider reported that it attempted nothing.
      makeDecisionEngine({
        classification: "CANNOT_REPRODUCE",
        component: "web",
        team: "Web",
        confidence: 0.95,
        labels: ["bug"],
        summary: "Not reproduced",
        reasoning: "The reproduction result says the bug was not observed.",
        nextAction: "Close if policy allows",
      }),
      new OwnershipResolver(parseOwnershipConfig(OWNERSHIP_YAML)),
      makeSlackProvider(),
      new MetricsRegistry({ collectDefault: false }),
      new PinoLoggerService({ level: "silent" }),
      undefined,
      undefined,
      { writesEnabled: true },
    );

    const issue = await repository.upsertIssue({
      githubIssueId: ISSUE.githubIssueId,
      githubNumber: ISSUE.githubNumber,
      repoOwner: ISSUE.repoOwner,
      repoName: ISSUE.repoName,
      title: ISSUE.title,
      body: ISSUE.body,
      url: ISSUE.url,
      authorLogin: ISSUE.authorLogin,
      labels: ISSUE.labels,
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    const execution = await orchestrator.processIssue(issue.id);

    expect(submitSpy).toHaveBeenCalledTimes(1);
    // A synchronous provider is polled inline, so the execution does not sit at
    // WAITING: it is analysed and the owning team notified in the same call.
    expect(execution.status).toBe(WorkflowStatus.SLACK_NOTIFIED);

    const attempt = await repository.getLatestReproductionAttemptForIssue(issue.id);
    expect(attempt?.providerName).toBe("noop");
    expect(attempt?.resultDetails).toMatchObject({ reproductionAttempted: false });

    expect(github.closeIssue).not.toHaveBeenCalled();
  });
});
