import { describe, expect, it, vi } from "vitest";
import { createGithubReadToolModule, redactLog, summarizeReviewStatus } from "./github-read-module";
import type { GithubReadClient } from "./github-client";
import { ctx, issue, pullRequest, text, toolOf } from "../testing/fixtures";

function client(overrides: Partial<GithubReadClient> = {}): GithubReadClient {
  return {
    getIssue: vi.fn(async () => issue()),
    getPullRequest: vi.fn(async () => pullRequest()),
    listComments: vi.fn(async () => [{ id: 1, authorLogin: "bob", body: "Seen on mobile too.", createdAt: "2026-01-03T00:00:00Z" }]),
    listIssues: vi.fn(async () => [issue(), issue({ githubNumber: 13, title: "Login page slow", body: "Takes ten seconds.", labels: ["perf"] })]),
    getFileContents: vi.fn(async () => "line one\nline two\n"),
    getPullRequestFiles: vi.fn(async () => [{ filename: "src/pay.ts", status: "modified", additions: 3, deletions: 1, changes: 4 }]),
    listWorkflowRunJobs: vi.fn(async () => [
      { jobId: 7, name: "test", status: "completed", conclusion: "failure", htmlUrl: "https://github.com/acme/web/actions/runs/55/job/7", startedAt: null, completedAt: null },
      { jobId: 8, name: "lint", status: "completed", conclusion: "success", htmlUrl: "https://github.com/acme/web/actions/runs/55/job/8", startedAt: null, completedAt: null },
    ]),
    listWorkflowRunArtifacts: vi.fn(async () => [{ id: 3, name: "report", sizeInBytes: 10, expired: false }]),
    downloadWorkflowJobLogs: vi.fn(async () => "2026-01-01T00:00:00.0000000Z npm test\nFAIL pay.spec.ts\n"),
    ...overrides,
  };
}

const module = (github = client(), extra = {}) => createGithubReadToolModule({ github, repositories: ["acme/web"], ...extra });

describe("github read tools", () => {
  it("refuses a repository outside the configured scope without calling GitHub", async () => {
    const github = client();
    const result = await toolOf(module(github), "get_issue").invoke({ repository: "other/repo", number: 1 }, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("acme/web");
    expect(github.getIssue).not.toHaveBeenCalled();
  });

  it("reads an issue with its recent comments", async () => {
    const result = await toolOf(module(), "get_issue").invoke({ repository: "acme/web", number: 12 }, ctx);
    const body = JSON.parse(text(result));
    expect(body).toMatchObject({ repository: "acme/web", number: 12, state: "open", body: expect.stringContaining("pay") });
    expect(body.comments).toEqual([{ author: "bob", createdAt: "2026-01-03T00:00:00Z", body: "Seen on mobile too." }]);
  });

  it("rejects a non-integer issue number", async () => {
    const result = await toolOf(module(), "get_issue").invoke({ repository: "acme/web", number: "12" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("summarises a pull request's checks and reviews", async () => {
    const github = client({
      getReviewStatus: vi.fn(async () => ({
        number: 34,
        url: "https://github.com/acme/web/pull/34",
        state: "open" as const,
        draft: false,
        reviews: [{ reviewer: "bob", state: "APPROVED" as const, submittedAt: new Date("2026-01-04") }],
        checks: [
          { name: "test", status: "completed" as const, conclusion: "failure" as const },
          { name: "lint", status: "completed" as const, conclusion: "success" as const },
          { name: "e2e", status: "in_progress" as const, conclusion: null },
        ],
        requestedReviewers: [],
        requestedTeams: [],
        mergeable: true,
      })),
    });
    const body = JSON.parse(text(await toolOf(module(github), "get_pull_request").invoke({ repository: "acme/web", number: 34 }, ctx)));
    expect(body.status.checks).toEqual({ total: 3, passed: 1, failed: 1, pending: 1, skipped: 0 });
    expect(body.status.failingChecks).toEqual(["test (failure)"]);
    expect(body.status.reviews).toEqual({ bob: "APPROVED" });
  });

  it("says when review status is unavailable instead of inventing it", async () => {
    const body = JSON.parse(text(await toolOf(module(), "get_pull_request").invoke({ repository: "acme/web", number: 34 }, ctx)));
    expect(body.status).toContain("unavailable");
  });

  it("falls back to scanning recent issues and says what it searched", async () => {
    const body = JSON.parse(text(await toolOf(module(), "search_issues").invoke({ repository: "acme/web", query: "checkout" }, ctx)));
    expect(body.matches.map((m: { number: number }) => m.number)).toEqual([12]);
    expect(body.searched).toContain("2 most recently updated");
  });

  it("uses the client's search when it has one", async () => {
    const searchIssues = vi.fn(async () => [issue({ githubNumber: 40 })]);
    const body = JSON.parse(text(await toolOf(module(client({ searchIssues })), "search_issues").invoke({ repository: "acme/web", query: "x" }, ctx)));
    expect(searchIssues).toHaveBeenCalledWith("acme", "web", "x", 20);
    expect(body.matches[0].number).toBe(40);
  });

  it("lists pull requests and reports truncation", async () => {
    const row = { number: 1, title: "t", url: "u", state: "open" as const, draft: false, authorLogin: "alice", createdAt: "c", updatedAt: "u", headRef: "h", baseRef: "b" };
    const listPullRequests = vi.fn(async () => [row, { ...row, number: 2 }, { ...row, number: 3 }]);
    const body = JSON.parse(text(await toolOf(module(client({ listPullRequests })), "list_pull_requests").invoke({ repository: "acme/web", limit: 2 }, ctx)));
    expect(body.truncated).toBe(true);
    expect(body.pullRequests).toHaveLength(2);
    expect(listPullRequests).toHaveBeenCalledWith("acme", "web", expect.objectContaining({ state: "open", perPage: 3 }));
  });

  it("pages a large file and points at the next offset", async () => {
    const big = "x".repeat(5_000);
    const github = client({ getFileContents: vi.fn(async () => big) });
    const small = { ...ctx, maxResultChars: 2_000 };
    const first = text(await toolOf(module(github), "get_file").invoke({ repository: "acme/web", path: "a.txt" }, small));
    expect(first).toContain("of 5000");
    const next = /offset (\d+)/.exec(first)?.[1];
    expect(Number(next)).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(2_000);
    const second = text(await toolOf(module(github), "get_file").invoke({ repository: "acme/web", path: "a.txt", offset: Number(next) }, small));
    expect(second).toContain(`characters ${next}-`);
  });

  it("reports a missing file as found=false, not an error", async () => {
    const github = client({ getFileContents: vi.fn(async () => null) });
    const result = await toolOf(module(github), "get_file").invoke({ repository: "acme/web", path: "nope.ts" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(text(result)).found).toBe(false);
  });

  it("refuses a path that climbs out of the repository", async () => {
    const result = await toolOf(module(), "get_file").invoke({ repository: "acme/web", path: "../secrets" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("reads a run from its URL", async () => {
    const body = JSON.parse(
      text(await toolOf(module(), "get_workflow_run").invoke({ url: "https://github.com/acme/web/actions/runs/55" }, ctx)),
    );
    expect(body.runId).toBe(55);
    expect(body.jobs.map((j: { name: string }) => j.name)).toEqual(["test", "lint"]);
    expect(body.artifacts[0].name).toBe("report");
  });

  it("reads failed job logs, strips timestamps and redacts tokens", async () => {
    const github = client({ downloadWorkflowJobLogs: vi.fn(async () => "2026-01-01T00:00:00.1Z token ghp_abcdefghijklmnop\nFAIL\n") });
    const out = text(await toolOf(module(github), "get_workflow_logs").invoke({ repository: "acme/web", run_id: 55 }, ctx));
    expect(out).toContain('job 7 "test"');
    expect(out).not.toContain("job 8");
    expect(out).toContain("ghp_[REDACTED]");
    expect(out).not.toContain("2026-01-01T00");
  });

  it("lists workflow runs", async () => {
    const listWorkflowRuns = vi.fn(async () => [{ runId: 5, runUrl: "https://github.com/acme/web/actions/runs/5", status: "completed", conclusion: "success", headBranch: "main" }]);
    const body = JSON.parse(text(await toolOf(module(client({ listWorkflowRuns })), "list_workflow_runs").invoke({ repository: "acme/web", workflow: "ci.yml" }, ctx)));
    expect(body.runs[0]).toMatchObject({ runId: 5, conclusion: "success", branch: "main" });
  });

  it("wraps a provider error without leaking a token", async () => {
    const github = client({ getIssue: vi.fn(async () => { throw new Error("401 Bearer abc.def"); }) });
    const result = await toolOf(module(github), "get_issue").invoke({ repository: "acme/web", number: 1 }, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Bearer [REDACTED]");
  });

  it("can require a read permission with a repository resource", () => {
    const tool = toolOf(module(client(), { readPermission: "issue.read" }), "get_issue");
    expect(tool.requiredPermission).toBe("issue.read");
    expect(tool.mutating).toBeFalsy();
    expect(tool.resource?.({ repository: "acme/web", number: 3 })).toEqual({ repository: "acme/web" });
  });

  it("declares no tool as mutating", () => {
    expect(module().tools.every((t) => !t.mutating && !t.requiredPermission)).toBe(true);
  });

  it("helpers", () => {
    // Assembled at runtime so the source never holds a key-shaped block.
    const fence = (edge: string) => `-----${edge} RSA ${"PRIVATE"} KEY-----`;
    expect(redactLog(`${fence("BEGIN")}\nabc\n${fence("END")}`)).toBe("[REDACTED PRIVATE KEY]");
    expect(summarizeReviewStatus({ number: 1, url: "", state: "open", draft: false, reviews: [], checks: [], requestedReviewers: [], requestedTeams: [], mergeable: null, checksRead: false }).checksRead).toBe(false);
  });
});
