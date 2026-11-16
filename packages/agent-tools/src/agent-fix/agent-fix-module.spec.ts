import { describe, expect, it, vi } from "vitest";
import { WriteGateBlockedError } from "@lexi/github";
import { createAgentFixToolModule, DISPATCH_AGENT_FIX_PERMISSION, MAX_BRIEF_CHARS, REBASE_BRANCH_PERMISSION } from "./agent-fix-module";
import type { GithubDispatchClient } from "../github/github-client";
import { ctx, text, toolOf } from "../testing/fixtures";

function client(overrides: Partial<GithubDispatchClient> = {}): GithubDispatchClient {
  return {
    dispatchWorkflow: vi.fn(async () => undefined),
    findDispatchedRun: vi.fn(async () => ({ runId: 55, runUrl: "https://github.com/acme/web/actions/runs/55", status: "queued" })),
    listWorkflowRunJobs: vi.fn(async () => []),
    downloadWorkflowJobLogs: vi.fn(async () => ""),
    listWorkflowRunArtifacts: vi.fn(async () => []),
    downloadWorkflowRunArtifact: vi.fn(async () => Buffer.alloc(0)),
    getDefaultBranch: vi.fn(async () => "main"),
    ...overrides,
  };
}

const build = (github = client(), extra = {}) =>
  createAgentFixToolModule({ github, repositories: [{ slug: "acme/web", team: "web" }], correlate: { attempts: 1 }, ...extra });

describe("agent-fix tools", () => {
  it("declares the dispatch tools mutating with their permissions", () => {
    const module = build();
    expect(toolOf(module, "dispatch_agent_fix")).toMatchObject({ mutating: true, requiredPermission: DISPATCH_AGENT_FIX_PERMISSION });
    expect(toolOf(module, "rebase_branch")).toMatchObject({ mutating: true, requiredPermission: REBASE_BRANCH_PERMISSION });
    expect(toolOf(module, "get_agent_run_result").mutating).toBeFalsy();
    expect(toolOf(module, "dispatch_agent_fix").resource?.({ repository: "acme/web" })).toEqual({ repository: "acme/web", team: "web" });
  });

  it("dispatches agent-fix on the default branch with the workflow's inputs", async () => {
    const github = client();
    const result = await toolOf(build(github), "dispatch_agent_fix").invoke(
      { repository: "acme/web", brief: "Checkout button does nothing", scope_hint: "src/checkout", resume_pr_number: 34 },
      ctx,
    );
    expect(github.dispatchWorkflow).toHaveBeenCalledWith("acme", "web", "agent-fix.yml", "main", {
      brief: "Checkout button does nothing",
      requester: "U0TEST01",
      thread_ref: "C0TEST01:1700000000.000100",
      scope_hint: "src/checkout",
      resume_pr_number: "34",
    });
    expect(result.outcome).toMatchObject({ executed: true, auditId: "55" });
    expect(text(result)).toContain("actions/runs/55");
  });

  it("uses a configured ref and requester name, and says when the run is not visible yet", async () => {
    const github = client({ findDispatchedRun: vi.fn(async () => null) });
    const result = await toolOf(build(github, { workflowRef: "stable", requesterName: () => "alice", agentFixWorkflow: "fix.yml" }), "dispatch_agent_fix").invoke(
      { repository: "acme/web", brief: "x" },
      ctx,
    );
    expect(github.dispatchWorkflow).toHaveBeenCalledWith("acme", "web", "fix.yml", "stable", expect.objectContaining({ requester: "alice" }));
    expect(result.outcome?.executed).toBe(true);
    expect(text(result)).toContain("not visible yet");
  });

  it("refuses to dispatch without a known ref", async () => {
    const github = client({ getDefaultBranch: vi.fn(async () => null) });
    const result = await toolOf(build(github), "dispatch_agent_fix").invoke({ repository: "acme/web", brief: "x" }, ctx);
    expect(result.outcome?.executed).toBe(false);
    expect(github.dispatchWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    [{ repository: "other/repo", brief: "x" }, "not a repository"],
    [{ repository: "acme/web", brief: "" }, "non-empty"],
    [{ repository: "acme/web", brief: "x".repeat(MAX_BRIEF_CHARS + 1) }, "Shorten"],
    [{ repository: "acme/web", brief: "x", resume_issue_number: -1 }, "positive integer"],
  ])("refuses %#", async (args, expected) => {
    const github = client();
    const result = await toolOf(build(github), "dispatch_agent_fix").invoke(args, ctx);
    expect(result.outcome?.executed).toBe(false);
    expect(text(result)).toContain(expected);
    expect(github.dispatchWorkflow).not.toHaveBeenCalled();
  });

  it("reports the write gate as not dispatched", async () => {
    const github = client({ dispatchWorkflow: vi.fn(async () => { throw new WriteGateBlockedError("github.dispatchWorkflow"); }) });
    const result = await toolOf(build(github), "dispatch_agent_fix").invoke({ repository: "acme/web", brief: "x" }, ctx);
    expect(result.outcome).toMatchObject({ executed: false, blocked: true });
    expect(github.findDispatchedRun).not.toHaveBeenCalled();
  });

  describe("rebase_branch", () => {
    it("dispatches a rebase of an agent branch", async () => {
      const github = client();
      const result = await toolOf(build(github), "rebase_branch").invoke({ repository: "acme/web", branch: "lexi/fix-pay", onto: "release" }, ctx);
      expect(github.dispatchWorkflow).toHaveBeenCalledWith("acme", "web", "rebase-branch.yml", "main", { branch: "lexi/fix-pay", onto: "release" });
      expect(result.outcome?.executed).toBe(true);
    });

    it.each([["main"], ["release/2.0"], ["feature/x"], ["lexi/../main"]])("refuses %s", async (branch) => {
      const github = client();
      const result = await toolOf(build(github), "rebase_branch").invoke({ repository: "acme/web", branch }, ctx);
      expect(result.outcome?.executed).toBe(false);
      expect(github.dispatchWorkflow).not.toHaveBeenCalled();
    });
  });

  it("reads a run's result from its URL", async () => {
    const github = client({
      getWorkflowRun: vi.fn(async () => ({ runId: 55, runUrl: "", status: "completed", conclusion: "success" })),
      listWorkflowRunJobs: vi.fn(async () => [{ jobId: 1, name: "rebase", status: "completed", conclusion: "success", htmlUrl: "", startedAt: null, completedAt: null }]),
      downloadWorkflowJobLogs: vi.fn(async () => "REBASE_RESULT: REBASED"),
    });
    const out = JSON.parse(text(await toolOf(build(github), "get_agent_run_result").invoke({ url: "https://github.com/acme/web/actions/runs/55" }, ctx)));
    expect(out).toMatchObject({ repository: "acme/web", runId: 55, status: "rebased", conclusion: "success" });
  });

  it("refuses a run in a repository outside the scope", async () => {
    const result = await toolOf(build(), "get_agent_run_result").invoke({ url: "https://github.com/other/repo/actions/runs/5" }, ctx);
    expect(result.isError).toBe(true);
  });
});
