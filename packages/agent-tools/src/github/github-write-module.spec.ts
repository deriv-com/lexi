import { describe, expect, it, vi } from "vitest";
import { GitHubMutationGateway, WriteGateBlockedError, type GitHubProvider } from "@lexi/github";
import { createGithubWriteToolModule, GITHUB_WRITE_PERMISSIONS } from "./github-write-module";
import type { GithubWriteClient } from "./github-client";
import { ctx, issue, pullRequest, text, toolOf } from "../testing/fixtures";

const TEMPLATE = "## Description\n\n<!-- what and why -->\n\n## Testing\n";

function client(overrides: Partial<GithubWriteClient> = {}): GithubWriteClient {
  return {
    getIssue: vi.fn(async () => issue()),
    getPullRequest: vi.fn(async () => pullRequest()),
    getFileContents: vi.fn(async (_o: string, _r: string, path: string) => (path === ".github/pull_request_template.md" ? TEMPLATE : null)),
    addComment: vi.fn(async () => ({ id: 501, authorLogin: "lexi-bot", body: "", createdAt: "" })),
    addLabels: vi.fn(async (_o: string, _r: string, _n: number, labels: string[]) => ["bug", ...labels]),
    removeLabels: vi.fn(async () => undefined),
    closeIssue: vi.fn(async () => issue({ state: "closed" })),
    reopenIssue: vi.fn(async () => issue()),
    createIssue: vi.fn(async () => issue()),
    createPullRequest: vi.fn(async () => ({ ...pullRequest({ number: 77, url: "https://github.com/acme/web/pull/77" }), draft: true })),
    closePullRequest: vi.fn(async () => pullRequest({ state: "closed" })),
    reopenPullRequest: vi.fn(async () => pullRequest()),
    getDefaultBranch: vi.fn(async () => "main"),
    createBranch: vi.fn(async (_o: string, _r: string, opts: { name: string }) => ({ name: opts.name, sha: "b".repeat(40), url: "u" })),
    mergePullRequest: vi.fn(async () => ({ merged: true, sha: "c".repeat(40), message: "merged" })),
    getReviewStatus: vi.fn(async () => ({
      number: 34,
      url: "",
      state: "open" as const,
      draft: false,
      reviews: [],
      checks: [{ name: "test", status: "completed" as const, conclusion: "success" as const }],
      requestedReviewers: [],
      requestedTeams: [],
      mergeable: true,
    })),
    branchExists: vi.fn(async () => true),
    ...overrides,
  };
}

const build = (github = client(), extra = {}) =>
  createGithubWriteToolModule({ github, repositories: [{ slug: "acme/web", team: "web" }], labelAllowlist: ["bug", /^priority:p[0-3]$/], ...extra });

describe("github write tools", () => {
  it("declares every tool mutating with the documented permission", () => {
    const module = build();
    for (const tool of module.tools) {
      expect(tool.mutating).toBe(true);
      expect(tool.requiredPermission).toBe(GITHUB_WRITE_PERMISSIONS[tool.definition.name as keyof typeof GITHUB_WRITE_PERMISSIONS]);
    }
    expect(module.tools.map((t) => t.definition.name)).toEqual(Object.keys(GITHUB_WRITE_PERMISSIONS));
  });

  it("scopes authorization to the repository, its team and the number", () => {
    const tool = toolOf(build(), "comment_on_issue");
    expect(tool.resource?.({ repository: "acme/web", number: 12 })).toEqual({ repository: "acme/web", team: "web", issueNumber: 12 });
    expect(tool.resource?.({ repository: "other/repo", number: 12 })).toBeUndefined();
  });

  it("omits the label tools when no allowlist is configured", () => {
    const names = createGithubWriteToolModule({ github: client(), repositories: ["acme/web"] }).tools.map((t) => t.definition.name);
    expect(names).not.toContain("add_labels");
  });

  it("comments and reports it executed", async () => {
    const github = client();
    const result = await toolOf(build(github), "comment_on_issue").invoke({ repository: "acme/web", number: 12, body: "Reproduced." }, ctx);
    expect(result.outcome).toMatchObject({ executed: true, authorized: true, auditId: "501" });
    expect(github.addComment).toHaveBeenCalledWith("acme", "web", 12, "Reproduced.");
  });

  it("refuses an out-of-scope repository without writing", async () => {
    const github = client();
    const result = await toolOf(build(github), "comment_on_issue").invoke({ repository: "evil/repo", number: 1, body: "x" }, ctx);
    expect(result.outcome).toMatchObject({ executed: false, blocked: true });
    expect(github.addComment).not.toHaveBeenCalled();
  });

  it("reports a dry-run gate as not performed", async () => {
    const github = client({ addComment: vi.fn(async () => { throw new WriteGateBlockedError("github.addComment", "GOVERNED_DRY_RUN=true"); }) });
    const result = await toolOf(build(github), "comment_on_issue").invoke({ repository: "acme/web", number: 12, body: "x" }, ctx);
    expect(result.outcome).toMatchObject({ executed: false, blocked: true });
    expect(text(result)).toContain("GOVERNED_DRY_RUN=true");
    expect(text(result)).toContain("Nothing was changed");
  });

  it("is honest through the real mutation gateway when writes are disabled", async () => {
    const inner = client() as unknown as GitHubProvider;
    const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
    const gateway = new GitHubMutationGateway(inner, { writesEnabled: false, dryRun: false }, logger);
    const result = await toolOf(build(gateway as unknown as GithubWriteClient), "comment_on_issue").invoke(
      { repository: "acme/web", number: 12, body: "x" },
      ctx,
    );
    expect(result.outcome?.executed).toBe(false);
    expect((inner as unknown as GithubWriteClient).addComment).not.toHaveBeenCalled();
  });

  it("reports a provider failure without leaking a token", async () => {
    const github = client({ addComment: vi.fn(async () => { throw new Error("boom token=abc123"); }) });
    const result = await toolOf(build(github), "comment_on_issue").invoke({ repository: "acme/web", number: 12, body: "x" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.outcome?.executed).toBe(false);
    expect(text(result)).toContain("token=[REDACTED]");
  });

  it("adds only allowlisted labels", async () => {
    const github = client();
    const ok = await toolOf(build(github), "add_labels").invoke({ repository: "acme/web", number: 12, labels: ["priority:p1"] }, ctx);
    expect(ok.outcome?.executed).toBe(true);
    const bad = await toolOf(build(github), "add_labels").invoke({ repository: "acme/web", number: 12, labels: ["bug", "wontfix"] }, ctx);
    expect(bad.outcome?.executed).toBe(false);
    expect(text(bad)).toContain("wontfix");
    expect(github.addLabels).toHaveBeenCalledTimes(1);
  });

  it("removes allowlisted labels", async () => {
    const github = client();
    const result = await toolOf(build(github), "remove_labels").invoke({ repository: "acme/web", number: 12, labels: ["BUG"] }, ctx);
    expect(result.outcome?.executed).toBe(true);
    expect(github.removeLabels).toHaveBeenCalledWith("acme", "web", 12, ["BUG"]);
  });

  describe("close_issue", () => {
    it("posts the reason, then closes", async () => {
      const github = client();
      const result = await toolOf(build(github), "close_issue").invoke(
        { repository: "acme/web", number: 12, reason: "Fixed in #34", state_reason: "completed" },
        ctx,
      );
      expect(result.outcome?.executed).toBe(true);
      expect(vi.mocked(github.addComment).mock.calls[0][3]).toContain("Fixed in #34");
      expect(github.closeIssue).toHaveBeenCalledWith("acme", "web", 12, "completed");
    });

    it("leaves the issue open when the reason cannot be posted", async () => {
      const github = client({ addComment: vi.fn(async () => { throw new Error("403"); }) });
      const result = await toolOf(build(github), "close_issue").invoke(
        { repository: "acme/web", number: 12, reason: "dup", state_reason: "not_planned" },
        ctx,
      );
      expect(result.outcome?.executed).toBe(false);
      expect(text(result)).toContain("left OPEN");
      expect(github.closeIssue).not.toHaveBeenCalled();
    });

    it("is a no-op on an already closed issue", async () => {
      const github = client({ getIssue: vi.fn(async () => issue({ state: "closed" })) });
      const result = await toolOf(build(github), "close_issue").invoke(
        { repository: "acme/web", number: 12, reason: "r", state_reason: "completed" },
        ctx,
      );
      expect(result.outcome?.executed).toBe(false);
      expect(github.addComment).not.toHaveBeenCalled();
    });

    it("requires a state_reason", async () => {
      const result = await toolOf(build(), "close_issue").invoke({ repository: "acme/web", number: 12, reason: "r" }, ctx);
      expect(result.outcome?.executed).toBe(false);
    });
  });

  it("reopens a closed issue and refuses an open one", async () => {
    const closed = client({ getIssue: vi.fn(async () => issue({ state: "closed" })) });
    expect((await toolOf(build(closed), "reopen_issue").invoke({ repository: "acme/web", number: 12 }, ctx)).outcome?.executed).toBe(true);
    const open = client();
    expect((await toolOf(build(open), "reopen_issue").invoke({ repository: "acme/web", number: 12 }, ctx)).outcome?.executed).toBe(false);
    expect(open.reopenIssue).not.toHaveBeenCalled();
  });

  describe("create_branch", () => {
    it("creates a prefixed branch from the default branch", async () => {
      const github = client();
      const result = await toolOf(build(github), "create_branch").invoke({ repository: "acme/web", name: "lexi/fix-pay" }, ctx);
      expect(result.outcome?.executed).toBe(true);
      expect(github.createBranch).toHaveBeenCalledWith("acme", "web", { name: "lexi/fix-pay", from: "main" });
    });

    it("refuses a name outside the configured prefixes or an illegal ref", async () => {
      const github = client();
      expect((await toolOf(build(github), "create_branch").invoke({ repository: "acme/web", name: "main2" }, ctx)).outcome?.executed).toBe(false);
      expect((await toolOf(build(github), "create_branch").invoke({ repository: "acme/web", name: "lexi/../x" }, ctx)).outcome?.executed).toBe(false);
      expect(github.createBranch).not.toHaveBeenCalled();
    });
  });

  describe("create_pull_request", () => {
    it("fits the body to the template and appends the closing reference", async () => {
      const github = client();
      const result = await toolOf(build(github), "create_pull_request").invoke(
        { repository: "acme/web", title: "Fix pay", head: "lexi/fix-pay", body: "Makes pay work.", issue_number: 12 },
        ctx,
      );
      expect(result.outcome).toMatchObject({ executed: true, auditId: "77" });
      const options = vi.mocked(github.createPullRequest).mock.calls[0][2];
      expect(options).toMatchObject({ head: "lexi/fix-pay", base: "main", draft: true });
      expect(options.body).toContain("## Description\n\nMakes pay work.");
      expect(options.body).toContain("## Testing");
      expect(options.body?.endsWith("Fixes #12")).toBe(true);
    });

    it("refuses head equal to base", async () => {
      const result = await toolOf(build(), "create_pull_request").invoke({ repository: "acme/web", title: "t", head: "main" }, ctx);
      expect(result.outcome?.executed).toBe(false);
    });

    it("refuses when the default branch is unknown and no base is given", async () => {
      const github = client({ getDefaultBranch: vi.fn(async () => null) });
      const result = await toolOf(build(github), "create_pull_request").invoke({ repository: "acme/web", title: "t", head: "lexi/x" }, ctx);
      expect(result.outcome?.executed).toBe(false);
      expect(github.createPullRequest).not.toHaveBeenCalled();
    });
  });

  describe("merge_pull_request", () => {
    it("merges a green PR into a non-default base, pinned to the head sha", async () => {
      const github = client();
      const result = await toolOf(build(github), "merge_pull_request").invoke({ repository: "acme/web", number: 34 }, ctx);
      expect(result.outcome?.executed).toBe(true);
      expect(github.mergePullRequest).toHaveBeenCalledWith("acme", "web", 34, { sha: "a".repeat(40) });
    });

    it.each([
      ["a merged PR", { getPullRequest: vi.fn(async () => pullRequest({ merged: true, mergedAt: "x", state: "closed" })) }, "already merged"],
      ["a draft", { getPullRequest: vi.fn(async () => pullRequest({ draft: true })) }, "draft"],
      ["conflicts", { getPullRequest: vi.fn(async () => pullRequest({ mergeable: false })) }, "conflicts"],
      ["the default branch as base", { getPullRequest: vi.fn(async () => pullRequest({ baseRef: "main" })) }, "default branch"],
      [
        "failing checks",
        { getReviewStatus: vi.fn(async () => ({ number: 34, url: "", state: "open" as const, draft: false, reviews: [], checks: [{ name: "test", status: "completed" as const, conclusion: "failure" as const }], requestedReviewers: [], requestedTeams: [], mergeable: true })) },
        "failing checks",
      ],
      [
        "unread checks",
        { getReviewStatus: vi.fn(async () => ({ number: 34, url: "", state: "open" as const, draft: false, reviews: [], checks: [], requestedReviewers: [], requestedTeams: [], mergeable: true, checksRead: false })) },
        "could not be read",
      ],
      [
        "changes requested",
        { getReviewStatus: vi.fn(async () => ({ number: 34, url: "", state: "open" as const, draft: false, reviews: [{ reviewer: "bob", state: "CHANGES_REQUESTED" as const, submittedAt: new Date() }], checks: [], requestedReviewers: [], requestedTeams: [], mergeable: true })) },
        "requested changes",
      ],
    ] as Array<[string, Partial<GithubWriteClient>, string]>)("refuses %s", async (_label, overrides, expected) => {
      const github = client(overrides);
      const result = await toolOf(build(github), "merge_pull_request").invoke({ repository: "acme/web", number: 34 }, ctx);
      expect(result.outcome?.executed).toBe(false);
      expect(text(result)).toContain(expected);
      expect(github.mergePullRequest).not.toHaveBeenCalled();
    });

    it("merges into the default branch only when the operator allows it", async () => {
      const github = client({ getPullRequest: vi.fn(async () => pullRequest({ baseRef: "main" })) });
      const result = await toolOf(build(github, { allowMergeIntoDefaultBranch: true }), "merge_pull_request").invoke({ repository: "acme/web", number: 34 }, ctx);
      expect(result.outcome?.executed).toBe(true);
    });

    it("does not report a merge GitHub declined", async () => {
      const github = client({ mergePullRequest: vi.fn(async () => ({ merged: false, sha: null, message: "Base branch was modified" })) });
      const result = await toolOf(build(github), "merge_pull_request").invoke({ repository: "acme/web", number: 34 }, ctx);
      expect(result.outcome?.executed).toBe(false);
    });
  });

  describe("close and reopen pull requests", () => {
    it("closes after posting the reason", async () => {
      const github = client();
      const result = await toolOf(build(github), "close_pull_request").invoke({ repository: "acme/web", number: 34, reason: "Superseded by #40" }, ctx);
      expect(result.outcome?.executed).toBe(true);
      expect(github.closePullRequest).toHaveBeenCalled();
    });

    it("refuses to close a merged PR", async () => {
      const github = client({ getPullRequest: vi.fn(async () => pullRequest({ merged: true, state: "closed", mergedAt: "2026-01-01" })) });
      const result = await toolOf(build(github), "close_pull_request").invoke({ repository: "acme/web", number: 34, reason: "r" }, ctx);
      expect(result.outcome?.executed).toBe(false);
      expect(github.addComment).not.toHaveBeenCalled();
    });

    it("refuses a reopen when the head branch is gone, and proceeds when the probe cannot answer", async () => {
      const gone = client({ getPullRequest: vi.fn(async () => pullRequest({ state: "closed" })), branchExists: vi.fn(async () => false) });
      expect((await toolOf(build(gone), "reopen_pull_request").invoke({ repository: "acme/web", number: 34 }, ctx)).outcome?.executed).toBe(false);
      const unknown = client({ getPullRequest: vi.fn(async () => pullRequest({ state: "closed" })), branchExists: vi.fn(async () => null) });
      expect((await toolOf(build(unknown), "reopen_pull_request").invoke({ repository: "acme/web", number: 34 }, ctx)).outcome?.executed).toBe(true);
    });

    it("refuses when the fresh read fails", async () => {
      const github = client({ getPullRequest: vi.fn(async () => { throw new Error("Not Found"); }) });
      const result = await toolOf(build(github), "close_pull_request").invoke({ repository: "acme/web", number: 34, reason: "r" }, ctx);
      expect(result.outcome?.executed).toBe(false);
      expect(text(result)).toContain("Could not read");
    });
  });
});
