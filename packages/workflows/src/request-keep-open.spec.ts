import { describe, it, expect, vi } from "vitest";
import { WorkflowOrchestrator } from "./workflow-orchestrator";
import { InMemoryWorkflowRepository } from "./testing/in-memory-workflow.repository";
import { WorkflowStateMachine } from "./workflow-state-machine";
import { CrossOrgClosureChecker } from "./cross-org-closure-checker";
import { MetricsRegistry } from "@lexi/metrics";
import { PinoLoggerService } from "@lexi/logger";
import type { GitHubProvider } from "@lexi/github";
import type { SlackProvider } from "@lexi/slack";

describe("requestKeepOpen governance", () => {
  it("records hold in audit without GitHub labels when writes disabled", async () => {
    const repository = new InMemoryWorkflowRepository();
    const github: GitHubProvider = {
      listBugHuntIssues: vi.fn(),
      listIssues: vi.fn(),
      listIssuesUpdatedSince: vi.fn().mockResolvedValue([]),
      listReleases: vi.fn().mockResolvedValue([]),
      createIssue: vi.fn(),
      getIssue: vi.fn(),
      getPullRequest: vi.fn(),
      listComments: vi.fn(),
      addComment: vi.fn(),
      listTimeline: vi.fn(),
      listLinkedPullRequests: vi.fn(),
      setLabels: vi.fn(),
      addLabels: vi.fn(),
      removeLabels: vi.fn(),
      assignUsers: vi.fn(),
      closeIssue: vi.fn(),
      reopenIssue: vi.fn(),
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
    const orchestrator = new WorkflowOrchestrator(
      repository,
      github,
      { submitIssue: vi.fn(), getStatus: vi.fn(), getResult: vi.fn(), cancel: vi.fn() },
      { decide: vi.fn() } as never,
      { resolve: vi.fn(), getComponentConfig: vi.fn() } as never,
      { sendMessage: vi.fn(), updateMessage: vi.fn() } as SlackProvider,
      new MetricsRegistry({ collectDefault: false }),
      new PinoLoggerService({ level: "silent" }),
      new WorkflowStateMachine(),
      new CrossOrgClosureChecker(github, new PinoLoggerService({ level: "silent" }), []),
      {
        writesEnabled: false,
        onCancelPendingClosure: vi.fn(),
      },
    );

    const issue = await repository.upsertIssue({
      githubIssueId: 1,
      githubNumber: 909,
      repoOwner: "o",
      repoName: "r",
      title: "t",
      body: "b",
      url: "u",
      authorLogin: "a",
      labels: ["bug"],
      state: "open",
      githubCreatedAt: new Date(),
      githubUpdatedAt: new Date(),
    });

    const result = await orchestrator.requestKeepOpen(issue.id, "slack:user");
    expect(result.executed).toBe(false);
    expect(result.message).toContain("writes are disabled");
    expect(github.addLabels).not.toHaveBeenCalled();
  });
});
