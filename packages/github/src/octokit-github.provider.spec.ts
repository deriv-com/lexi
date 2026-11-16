import { describe, it, expect, vi, beforeEach } from "vitest";
import { OctokitGithubProvider, BranchDeletionUnverifiedError } from "./octokit-github.provider";
import { PinoLoggerService } from "@lexi/logger";

// Cross-org client resolution (getClientForRepo) constructs real `new
// Octokit(...)` instances and calls the real `resolveInstallationId` — mock
// both so the cross-org test suite below never signs a real JWT or makes a
// real HTTP call. Does not affect the rest of this file: every other test
// constructs `provider` without `appAuth`, so getClientForRepo short-circuits
// to the injected `octokit` mock and never touches either mocked module.
const mockResolveInstallationId = vi.fn();
vi.mock("./octokit.factory", () => ({
  resolveInstallationId: (...args: unknown[]) => mockResolveInstallationId(...args),
}));

function makeActionsSurface() {
  return {
    createWorkflowDispatch: vi.fn().mockResolvedValue({}),
    listWorkflowRuns: vi.fn().mockResolvedValue({ data: { workflow_runs: [] } }),
    getWorkflowRun: vi.fn().mockResolvedValue({ data: { status: "in_progress", conclusion: null } }),
    listJobsForWorkflowRun: vi.fn().mockResolvedValue({ data: { jobs: [] } }),
    downloadJobLogsForWorkflowRun: vi.fn().mockResolvedValue({ data: "" }),
    cancelWorkflowRun: vi.fn().mockResolvedValue({ status: 202 }),
  };
}

function makePullsSurface() {
  return {
    get: vi.fn().mockResolvedValue({
      data: {
        number: 3099,
        state: "open",
        merged: false,
        merged_at: null,
        html_url: "https://github.com/acme/web-app/pull/3099",
        head: { ref: "claude/otp-rate-limit-error-code" },
      },
    }),
    update: vi.fn().mockResolvedValue({
      data: {
        number: 3099,
        state: "closed",
        merged: false,
        merged_at: null,
        html_url: "https://github.com/acme/web-app/pull/3099",
      },
    }),
    list: vi.fn().mockResolvedValue({
      data: [
        {
          number: 12,
          title: "oldest",
          html_url: "https://github.com/acme/web-app/pull/12",
          state: "open",
          draft: false,
          user: { login: "alice" },
          created_at: "2025-01-01T00:00:00.000Z",
          updated_at: "2025-01-02T00:00:00.000Z",
          head: { ref: "old-branch" },
          base: { ref: "main" },
        },
      ],
    }),
    updateBranch: vi.fn().mockResolvedValue({ data: { message: "Updating branch.", url: "https://api.github.com" } }),
    listReviews: vi.fn().mockResolvedValue({ data: [] }),
  };
}

function makeCrossOrgRestSurface() {
  return {
    actions: makeActionsSurface(),
    pulls: makePullsSurface(),
    issues: {
      create: vi.fn().mockResolvedValue({
        data: {
          id: 9001,
          number: 88,
          title: "Move FATCA and PEP",
          body: "spec body",
          html_url: "https://github.com/acme/web-app/issues/88",
          user: { login: "lexi" },
          labels: [{ name: "type:spec" }, { name: "spec:draft" }],
          state: "open",
          assignees: [],
          created_at: "2026-08-18T00:00:00.000Z",
          updated_at: "2026-08-18T00:00:00.000Z",
        },
      }),
      setLabels: vi.fn().mockResolvedValue({
        data: [{ name: "type:spec" }, { name: "spec:approved" }],
      }),
      createComment: vi.fn().mockResolvedValue({
        data: { id: 1, user: { login: "bot" }, body: "closing", created_at: "2026-08-18T00:00:00.000Z" },
      }),
      get: vi.fn().mockResolvedValue({
        data: {
          id: 9002,
          number: 1504,
          title: "[TAG] P2P Production - production_v20260831_0",
          body: "<!-- lexi-p2p-release-requester: U0TEST03 -->",
          html_url: "https://github.com/acme/p2p-web/issues/1504",
          user: { login: "lexi" },
          labels: [],
          state: "open",
          assignees: [],
          milestone: null,
          closed_at: null,
          created_at: "2026-08-31T00:00:00.000Z",
          updated_at: "2026-08-31T00:00:00.000Z",
        },
      }),
      listComments: vi.fn().mockResolvedValue({
        data: [{ id: 7, user: { login: "olivia" }, body: "ready", created_at: "2026-08-31T00:00:00.000Z" }],
      }),
      listForRepo: vi.fn().mockResolvedValue({ data: [] }),
      listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
      update: vi.fn().mockResolvedValue({
        data: {
          id: 9002,
          number: 1504,
          title: "[TAG] P2P Production",
          body: "",
          html_url: "https://github.com/acme/p2p-web/issues/1504",
          user: { login: "lexi" },
          labels: [],
          state: "closed",
          assignees: [],
          created_at: "2026-08-31T00:00:00.000Z",
          updated_at: "2026-08-31T00:00:00.000Z",
        },
      }),
      addLabels: vi.fn().mockResolvedValue({ data: [{ name: "release" }] }),
      removeLabel: vi.fn().mockResolvedValue({ data: [] }),
    },
    git: {
      getRef: vi.fn().mockResolvedValue({ data: {} }),
    },
    repos: {
      compareCommitsWithBasehead: vi.fn().mockResolvedValue({
        data: { status: "behind", ahead_by: 0, behind_by: 3 },
      }),
      listTags: vi.fn().mockResolvedValue({
        data: [{ name: "production_v20260831_0", commit: { sha: "abc123" } }],
      }),
    },
    checks: {
      listForRef: vi.fn().mockResolvedValue({ data: { check_runs: [] } }),
    },
  };
}

const constructedClients: Array<{
  auth: Record<string, unknown>;
  rest: ReturnType<typeof makeCrossOrgRestSurface>;
}> = [];
vi.mock("@octokit/rest", () => ({
  // Vitest 4 rejects `new` on an arrow-function mock implementation.
  Octokit: vi.fn().mockImplementation(function MockOctokit(config: { auth: Record<string, unknown> }) {
    const client = { auth: config.auth, rest: makeCrossOrgRestSurface() };
    constructedClients.push(client);
    return client;
  }),
}));
vi.mock("@octokit/auth-app", () => ({ createAppAuth: "createAppAuth-strategy-marker" }));

function makeIssue(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    number: 42,
    title: "Sample bug",
    body: "Something is broken",
    html_url: "https://github.com/acme-internal/issues/issues/42",
    user: { login: "reporter" },
    labels: [{ name: "bug" }, { name: "domain:web" }],
    state: "open",
    assignees: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("OctokitGithubProvider", () => {
  let octokit: {
    request: ReturnType<typeof vi.fn>;
    rest: {
      issues: Record<string, ReturnType<typeof vi.fn>>;
      pulls: Record<string, ReturnType<typeof vi.fn>>;
      repos: Record<string, ReturnType<typeof vi.fn>>;
      actions: Record<string, ReturnType<typeof vi.fn>>;
      search: Record<string, ReturnType<typeof vi.fn>>;
      git: Record<string, ReturnType<typeof vi.fn>>;
    };
  };
  let logger: PinoLoggerService;
  let provider: OctokitGithubProvider;

  beforeEach(() => {
    octokit = {
      request: vi.fn().mockResolvedValue({ data: {} }),
      rest: {
        issues: {
          listForRepo: vi.fn().mockResolvedValue({ data: [makeIssue()] }),
          get: vi.fn().mockResolvedValue({ data: makeIssue() }),
          listComments: vi.fn().mockResolvedValue({ data: [] }),
          createComment: vi.fn().mockResolvedValue({
            data: { id: 99, user: { login: "bot" }, body: "hello", created_at: "2026-01-03T00:00:00.000Z" },
          }),
          listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
          setLabels: vi.fn().mockResolvedValue({ data: [{ name: "bug" }, { name: "priority:P1" }] }),
          addLabels: vi.fn().mockResolvedValue({ data: [{ name: "bug" }] }),
          removeLabel: vi.fn().mockResolvedValue({}),
          addAssignees: vi.fn().mockResolvedValue({}),
          removeAssignees: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({ data: makeIssue({ state: "closed" }) }),
        },
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              number: 99,
              state: "closed",
              merged: true,
              merged_at: "2026-01-05T00:00:00.000Z",
              html_url: "https://github.com/acme/legacy-app/pull/99",
            },
          }),
          update: vi.fn().mockResolvedValue({
            data: {
              number: 321,
              state: "closed",
              merged: false,
              merged_at: null,
              html_url: "https://github.com/acme/web-app/pull/321",
            },
          }),
          listFiles: vi.fn().mockResolvedValue({ data: [] }),
          list: vi.fn().mockResolvedValue({ data: [] }),
          updateBranch: vi.fn().mockResolvedValue({ data: { message: "Updating branch." } }),
          create: vi.fn().mockResolvedValue({
            data: {
              number: 654,
              state: "open",
              merged: false,
              merged_at: null,
              html_url: "https://github.com/acme/web-app/pull/654",
              draft: false,
            },
          }),
          merge: vi.fn().mockResolvedValue({
            data: { merged: true, sha: "ffffffffffffffffffffffffffffffffffffffff", message: "Pull Request successfully merged" },
          }),
        },
        repos: {
          getContent: vi.fn(),
          getCommit: vi.fn(),
          listTags: vi.fn().mockResolvedValue({ data: [] }),
          compareCommitsWithBasehead: vi.fn(),
          merge: vi.fn().mockResolvedValue({
            status: 201,
            data: { sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
          }),
          listReleases: vi.fn().mockResolvedValue({
            data: [
              {
                tag_name: "v1.2.3",
                name: "1.2.3",
                body: "notes",
                target_commitish: "abc123",
                published_at: "2026-02-01T00:00:00.000Z",
                author: { login: "releaser" },
                prerelease: false,
                html_url: "https://github.com/acme-internal/issues/releases/tag/v1.2.3",
              },
            ],
          }),
        },
        actions: {
          createWorkflowDispatch: vi.fn().mockResolvedValue({ status: 204 }),
          listWorkflowRuns: vi.fn().mockResolvedValue({ data: { workflow_runs: [] } }),
          getWorkflowRun: vi.fn(),
          listJobsForWorkflowRun: vi.fn().mockResolvedValue({ data: { jobs: [] } }),
          downloadJobLogsForWorkflowRun: vi.fn(),
          listWorkflowRunArtifacts: vi.fn().mockResolvedValue({ data: { artifacts: [] } }),
          downloadArtifact: vi.fn(),
          cancelWorkflowRun: vi.fn().mockResolvedValue({ status: 202 }),
        },
        search: {
          code: vi.fn().mockResolvedValue({ data: { items: [] } }),
        },
        git: {
          getTree: vi.fn(),
          getBlob: vi.fn(),
          getRef: vi.fn().mockResolvedValue({ data: { object: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } } }),
          createRef: vi.fn().mockResolvedValue({ data: {} }),
          deleteRef: vi.fn().mockResolvedValue({ status: 204 }),
          getCommit: vi.fn().mockResolvedValue({
            data: { tree: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } },
          }),
          createTree: vi.fn().mockResolvedValue({ data: { sha: "cccccccccccccccccccccccccccccccccccccccc" } }),
          createCommit: vi.fn().mockResolvedValue({ data: { sha: "dddddddddddddddddddddddddddddddddddddddd" } }),
          updateRef: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
    };
    logger = new PinoLoggerService({ level: "silent" });
    provider = new OctokitGithubProvider(octokit as never, logger);
  });

  it("lists bug-labelled issues and filters out pull requests", async () => {
    octokit.rest.issues.listForRepo.mockResolvedValue({
      data: [makeIssue(), makeIssue({ id: 2, number: 43, pull_request: {} })],
    });
    const issues = await provider.listBugHuntIssues({ owner: "acme-internal", repo: "issues", label: "bug" });
    expect(issues).toHaveLength(1);
    expect(issues[0].githubNumber).toBe(42);
    expect(issues[0].labels).toContain("domain:web");
  });

  describe("listIssuesUpdatedSince", () => {
    it("issues the same query the migrated corpus-sync fetch() did", async () => {
      await provider.listIssuesUpdatedSince(
        "acme-internal",
        "issues",
        "2026-01-01T00:00:00Z",
        50,
        3,
      );

      expect(octokit.rest.issues.listForRepo).toHaveBeenCalledWith({
        owner: "acme-internal",
        repo: "issues",
        state: "all",
        since: "2026-01-01T00:00:00Z",
        direction: "asc",
        per_page: 50,
        page: 3,
      });
    });

    it("defaults to 100 per page, page 1", async () => {
      await provider.listIssuesUpdatedSince("acme-internal", "issues", "2026-01-01T00:00:00Z");
      expect(octokit.rest.issues.listForRepo).toHaveBeenCalledWith(
        expect.objectContaining({ per_page: 100, page: 1 }),
      );
    });

    it("returns the raw payload, keeping pull_request so the caller can skip PRs", async () => {
      octokit.rest.issues.listForRepo.mockResolvedValue({
        data: [makeIssue(), makeIssue({ id: 2, number: 43, pull_request: { url: "x" } })],
      });

      const items = await provider.listIssuesUpdatedSince("acme-internal", "issues", "2026-01-01T00:00:00Z");

      expect(items).toHaveLength(2);
      expect(items[0].updated_at).toBe("2026-01-02T00:00:00.000Z");
      expect(items[0].html_url).toContain("/issues/42");
      expect(items[1].pull_request).toEqual({ url: "x" });
    });

    it("propagates API errors so the sync caller still fails the run", async () => {
      octokit.rest.issues.listForRepo.mockRejectedValue(new Error("GitHub API 403"));
      await expect(
        provider.listIssuesUpdatedSince("acme-internal", "issues", "2026-01-01T00:00:00Z"),
      ).rejects.toThrow(/403/);
    });
  });

  describe("listReleases", () => {
    it("requests releases with the given page size and returns the raw payload", async () => {
      const releases = await provider.listReleases("acme-internal", "issues", 5);

      expect(octokit.rest.repos.listReleases).toHaveBeenCalledWith({
        owner: "acme-internal",
        repo: "issues",
        per_page: 5,
      });
      expect(releases[0].tag_name).toBe("v1.2.3");
      expect(releases[0].target_commitish).toBe("abc123");
    });

    it("defaults to 20 per page", async () => {
      await provider.listReleases("acme-internal", "issues");
      expect(octokit.rest.repos.listReleases).toHaveBeenCalledWith(
        expect.objectContaining({ per_page: 20 }),
      );
    });
  });

  it("sets labels idempotently via replace-all endpoint", async () => {
    const labels = await provider.setLabels("acme-internal", "issues", 42, ["bug", "bug", "priority:P1"]);
    expect(octokit.rest.issues.setLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["bug", "priority:P1"] }),
    );
    expect(labels).toEqual(["bug", "priority:P1"]);
  });

  it("computes assignee diff and only adds/removes what changed", async () => {
    octokit.rest.issues.get
      .mockResolvedValueOnce({ data: makeIssue({ assignees: [{ login: "alice" }] }) })
      .mockResolvedValueOnce({ data: makeIssue({ assignees: [{ login: "bob" }] }) });

    const result = await provider.assignUsers("acme-internal", "issues", 42, ["bob"]);

    expect(octokit.rest.issues.addAssignees).toHaveBeenCalledWith(
      expect.objectContaining({ assignees: ["bob"] }),
    );
    expect(octokit.rest.issues.removeAssignees).toHaveBeenCalledWith(
      expect.objectContaining({ assignees: ["alice"] }),
    );
    expect(result).toEqual(["bob"]);
  });

  it("treats a 404 on removeLabel as a no-op", async () => {
    octokit.rest.issues.removeLabel.mockRejectedValue({ status: 404 });
    await expect(provider.removeLabels("acme-internal", "issues", 42, ["missing"])).resolves.toBeUndefined();
  });

  it("closes an issue with a state reason", async () => {
    const issue = await provider.closeIssue("acme-internal", "issues", 42, "not_planned");
    expect(octokit.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ state: "closed", state_reason: "not_planned" }),
    );
    expect(issue.state).toBe("closed");
  });

  it("adds a comment and maps the response", async () => {
    const comment = await provider.addComment("acme-internal", "issues", 42, "hello");
    expect(comment.authorLogin).toBe("bot");
    expect(comment.body).toBe("hello");
  });

  it("adds a sub-issue by GitHub numeric id", async () => {
    await provider.addSubIssue("acme-internal", "mobile-app", 2098, 987654);
    expect(octokit.request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
      expect.objectContaining({
        owner: "acme-internal",
        repo: "mobile-app",
        issue_number: 2098,
        sub_issue_id: 987654,
      }),
    );
  });

  it("treats an already-linked sub-issue as success", async () => {
    octokit.request.mockRejectedValue({ status: 422, message: "Sub-issue is already present" });
    await expect(provider.addSubIssue("acme-internal", "mobile-app", 2098, 1)).resolves.toBeUndefined();
  });

  it("lists sub-issues of a checklist parent", async () => {
    octokit.request.mockResolvedValue({
      data: [
        {
          id: 1,
          number: 2100,
          title: "fix: login",
          body: "tap does nothing",
          html_url: "https://github.com/acme-internal/mobile-app/issues/2100",
          user: { login: "qa" },
          labels: [],
          state: "open",
          state_reason: null,
          assignees: [],
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-01T00:00:00Z",
        },
      ],
    });
    const listed = await provider.listSubIssues("acme-internal", "mobile-app", 2098);
    expect(octokit.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
      expect.objectContaining({
        owner: "acme-internal",
        repo: "mobile-app",
        issue_number: 2098,
      }),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.githubNumber).toBe(2100);
    expect(listed[0]?.title).toBe("fix: login");
  });

  it("carries the head AND base refs when GitHub sends them", async () => {
    // The pair a rebase-by-PR-number needs: which branch to replay, and what
    // to replay it onto. A PR opened against a release-integration branch is
    // behind THAT, not behind main, and the operation force-pushes.
    octokit.rest.pulls.get.mockResolvedValueOnce({
      data: {
        number: 2437,
        state: "open",
        merged: false,
        merged_at: null,
        html_url: "https://github.com/acme-internal/mobile-app/pull/2437",
        head: { ref: "judy/r8-score-round-2", sha: "3f2a1c9" },
        base: { ref: "release-integration-2026-09-08" },
      },
    });

    const pr = await provider.getPullRequest("acme-internal", "mobile-app", 2437);
    expect({ headRef: pr.headRef, baseRef: pr.baseRef }).toEqual({
      headRef: "judy/r8-score-round-2",
      baseRef: "release-integration-2026-09-08",
    });
  });

  it("fetches a pull request and maps merge status", async () => {
    const pr = await provider.getPullRequest("acme", "legacy-app", 99);
    expect(octokit.rest.pulls.get).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "legacy-app", pull_number: 99 }),
    );
    expect(pr).toEqual({
      number: 99,
      // Names the head branch reopen_pull_request would have to probe; null here
      // because this fixture's payload carries no `head`.
      headRef: null,
      // Same fixture, same reason: no `base` in the payload. Reported as null
      // rather than omitted, because a caller that rebases by PR number has to
      // be able to tell "the PR targets main" from "I could not read the base".
      baseRef: null,
      headSha: null,
      draft: false,
      state: "closed",
      merged: true,
      mergedAt: "2026-01-05T00:00:00.000Z",
      url: "https://github.com/acme/legacy-app/pull/99",
      // This fixture's payload carries no merge_commit_sha, so release tracing
      // has nothing to compare tags against — reported as null, never omitted.
      mergeCommitSha: null,
      // GitHub's mergeability verdict is tri-state; the fixture's
      // payload carries none, and "not computed" must read as null, never as
      // an answer the auto-merge gate could act on.
      mergeable: null,
    });
  });

  it("carries the merge commit sha of a merged pull request", async () => {
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        number: 1877,
        state: "closed",
        merged: true,
        merged_at: "2026-08-03T02:35:26Z",
        merge_commit_sha: "630048642ad31d0586782162a1675b7556b73c59",
        html_url: "https://github.com/acme-internal/mobile-app/pull/1877",
      },
    });

    const pr = await provider.getPullRequest("acme-internal", "mobile-app", 1877);
    expect(pr.mergeCommitSha).toBe("630048642ad31d0586782162a1675b7556b73c59");
  });

  it("drops the merge commit sha of an OPEN pull request", async () => {
    // GitHub populates `merge_commit_sha` on an open PR with a throwaway
    // test-merge commit that is in no branch's history. Carrying it forward
    // would let release tracing compare tags against a fix that has not landed.
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        number: 1882,
        state: "open",
        merged: false,
        merged_at: null,
        merge_commit_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        html_url: "https://github.com/acme-internal/mobile-app/pull/1882",
      },
    });

    const pr = await provider.getPullRequest("acme-internal", "mobile-app", 1882);
    expect(pr.merged).toBe(false);
    expect(pr.mergeCommitSha).toBeNull();
  });

  it("propagates an error when the pull request cannot be found", async () => {
    octokit.rest.pulls.get.mockRejectedValue({ status: 404, message: "Not Found" });
    await expect(provider.getPullRequest("acme", "legacy-app", 12345)).rejects.toMatchObject({ status: 404 });
  });

  describe("dispatchWorkflow", () => {
    it("dispatches with the given ref and inputs", async () => {
      await provider.dispatchWorkflow("acme", "web-app", "direct-fix.yml", "main", {
        bug_text: "checkout crashes on submit",
        reporter_slack_id: "U123",
      });

      expect(octokit.rest.actions.createWorkflowDispatch).toHaveBeenCalledWith({
        owner: "acme",
        repo: "web-app",
        workflow_id: "direct-fix.yml",
        ref: "main",
        inputs: {
          bug_text: "checkout crashes on submit",
          reporter_slack_id: "U123",
        },
      });
    });

    it("turns a 403 into a clear 'App not installed' error naming the repo and permission", async () => {
      octokit.rest.actions.createWorkflowDispatch.mockRejectedValue({ status: 403, message: "Forbidden" });

      await expect(
        provider.dispatchWorkflow("acme", "web-app", "direct-fix.yml", "main", {
          bug_text: "x",
          reporter_slack_id: "U123",
        }),
      ).rejects.toThrow(/acme\/web-app.*Actions:write/);
    });

    it("turns a 404 into the same clear error (App cannot see the repo at all)", async () => {
      octokit.rest.actions.createWorkflowDispatch.mockRejectedValue({ status: 404, message: "Not Found" });

      await expect(
        provider.dispatchWorkflow("acme-internal", "mobile-app", "direct-fix.yml", "main", {
          bug_text: "x",
          reporter_slack_id: "U123",
        }),
      ).rejects.toThrow(/acme-internal\/mobile-app.*Actions:write/);
    });

    it("propagates other errors unchanged", async () => {
      octokit.rest.actions.createWorkflowDispatch.mockRejectedValue({ status: 500, message: "Internal Server Error" });

      await expect(
        provider.dispatchWorkflow("acme", "web-app", "direct-fix.yml", "main", {
          bug_text: "x",
          reporter_slack_id: "U123",
        }),
      ).rejects.toMatchObject({ status: 500 });
    });
  });

  describe("findDispatchedRun", () => {
    it("returns null when no run has appeared yet", async () => {
      octokit.rest.actions.listWorkflowRuns.mockResolvedValue({ data: { workflow_runs: [] } });

      const result = await provider.findDispatchedRun(
        "acme",
        "web-app",
        "direct-fix.yml",
        new Date("2026-08-13T00:00:00.000Z"),
      );

      expect(result).toBeNull();
    });

    it("returns the earliest run at/after `since`, not the most recent", async () => {
      // Earliest-first is the point of the fix: a run this dispatch caused
      // should register within seconds of `since`, well before a later,
      // unrelated dispatch's run does. "Most recent" would systematically
      // prefer that later, different attempt's run instead.
      octokit.rest.actions.listWorkflowRuns.mockResolvedValue({
        data: {
          workflow_runs: [
            {
              id: 111,
              html_url: "https://github.com/acme/web-app/actions/runs/111",
              status: "completed",
              created_at: "2026-08-13T00:01:00.000Z",
            },
            {
              id: 222,
              html_url: "https://github.com/acme/web-app/actions/runs/222",
              status: "in_progress",
              created_at: "2026-08-13T00:05:00.000Z",
            },
          ],
        },
      });

      const result = await provider.findDispatchedRun(
        "acme",
        "web-app",
        "direct-fix.yml",
        new Date("2026-08-13T00:00:00.000Z"),
      );

      expect(octokit.rest.actions.listWorkflowRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "acme",
          repo: "web-app",
          workflow_id: "direct-fix.yml",
          event: "workflow_dispatch",
          created: ">=2026-08-13T00:00:00.000Z",
        }),
      );
      expect(result).toEqual({
        runId: 111,
        runUrl: "https://github.com/acme/web-app/actions/runs/111",
        status: "completed",
      });
    });

    it("excludes run IDs already claimed by another in-flight attempt on the same repo", async () => {
      // Same fixture as above, but 111 (the one this heuristic would
      // otherwise pick) is already claimed by a different attempt — the
      // caller must fall through to the next-earliest unclaimed run.
      octokit.rest.actions.listWorkflowRuns.mockResolvedValue({
        data: {
          workflow_runs: [
            {
              id: 111,
              html_url: "https://github.com/acme/web-app/actions/runs/111",
              status: "completed",
              created_at: "2026-08-13T00:01:00.000Z",
            },
            {
              id: 222,
              html_url: "https://github.com/acme/web-app/actions/runs/222",
              status: "in_progress",
              created_at: "2026-08-13T00:05:00.000Z",
            },
          ],
        },
      });

      const result = await provider.findDispatchedRun(
        "acme",
        "web-app",
        "direct-fix.yml",
        new Date("2026-08-13T00:00:00.000Z"),
        [111],
      );

      expect(result).toEqual({
        runId: 222,
        runUrl: "https://github.com/acme/web-app/actions/runs/222",
        status: "in_progress",
      });
    });

    it("matches nameContains against the run title instead of picking the earliest sibling", async () => {
      octokit.rest.actions.listWorkflowRuns.mockResolvedValue({
        data: {
          workflow_runs: [
            {
              id: 111,
              html_url: "https://github.com/acme-internal/mobile-app/actions/runs/111",
              status: "in_progress",
              created_at: "2026-08-21T07:30:00.000Z",
              name: "QA Mobile ISSUE-2148 · android · fix",
            },
            {
              id: 222,
              html_url: "https://github.com/acme-internal/mobile-app/actions/runs/222",
              status: "queued",
              created_at: "2026-08-21T07:30:02.000Z",
              name: "QA Mobile ISSUE-2170 · android · feature",
            },
          ],
        },
      });

      const result = await provider.findDispatchedRun(
        "acme-internal",
        "mobile-app",
        "qa-mobile.yml",
        new Date("2026-08-21T07:29:00.000Z"),
        [],
        "ISSUE-2170",
      );

      expect(result).toEqual({
        runId: 222,
        runUrl: "https://github.com/acme-internal/mobile-app/actions/runs/222",
        status: "queued",
      });
    });

    it("returns null (retry next tick) when every candidate run is already claimed", async () => {
      octokit.rest.actions.listWorkflowRuns.mockResolvedValue({
        data: {
          workflow_runs: [
            {
              id: 111,
              html_url: "https://github.com/acme/web-app/actions/runs/111",
              status: "completed",
              created_at: "2026-08-13T00:01:00.000Z",
            },
          ],
        },
      });

      const result = await provider.findDispatchedRun(
        "acme",
        "web-app",
        "direct-fix.yml",
        new Date("2026-08-13T00:00:00.000Z"),
        [111],
      );

      expect(result).toBeNull();
    });

    it("turns a 403/404 on the run-list call into a clear 'App not installed' error", async () => {
      octokit.rest.actions.listWorkflowRuns.mockRejectedValue({ status: 403 });

      await expect(
        provider.findDispatchedRun("acme", "web-app", "direct-fix.yml", new Date()),
      ).rejects.toThrow(/acme\/web-app.*Actions:read/);
    });
  });

  describe("getWorkflowRun", () => {
    it("returns status and parses qa-mobile verdict from job logs", async () => {
      octokit.rest.actions.getWorkflowRun.mockResolvedValue({
        data: {
          id: 77,
          html_url: "https://github.com/acme-internal/mobile-app/actions/runs/77",
          status: "completed",
          conclusion: "failure",
        },
      });
      octokit.rest.actions.listJobsForWorkflowRun.mockResolvedValue({ data: { jobs: [{ id: 1 }] } });
      octokit.rest.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({
        data: "2026-08-20T00:00:00.0000000Z verdict=INFRA maestro_outcome=failure\n",
      });

      const result = await provider.getWorkflowRun("acme-internal", "mobile-app", 77);
      expect(result?.runId).toBe(77);
      expect(result?.conclusion).toBe("failure");
      expect(result?.logVerdict).toBe("INFRA");
    });

    it("returns null when the run is not visible", async () => {
      octokit.rest.actions.getWorkflowRun.mockRejectedValue({ status: 404 });
      await expect(provider.getWorkflowRun("acme-internal", "mobile-app", 1)).resolves.toBeNull();
    });

    it("skips job-log verdict parsing when includeLogVerdict is false", async () => {
      octokit.rest.actions.getWorkflowRun.mockResolvedValue({
        data: {
          id: 77,
          html_url: "https://github.com/acme-internal/mobile-app/actions/runs/77",
          status: "completed",
          conclusion: "failure",
          name: "QA Mobile ISSUE-2093",
          display_title: "QA Mobile ISSUE-2093 · android",
          event: "workflow_dispatch",
          head_sha: "abc123",
          path: ".github/workflows/qa-mobile.yml", head_branch: "main", run_attempt: 2,
          repository: { full_name: "acme-internal/mobile-app" }, head_repository: { full_name: "acme-internal/mobile-app" },
          created_at: "2026-08-21T00:00:00Z",
          updated_at: "2026-08-21T00:10:00Z",
        },
      });

      const result = await provider.getWorkflowRun("acme-internal", "mobile-app", 77, {
        includeLogVerdict: false,
      });

      expect(result).toEqual({
        runId: 77,
        runUrl: "https://github.com/acme-internal/mobile-app/actions/runs/77",
        status: "completed",
        conclusion: "failure",
        logVerdict: null,
        name: "QA Mobile ISSUE-2093",
        displayTitle: "QA Mobile ISSUE-2093 · android",
        event: "workflow_dispatch",
        headSha: "abc123",
        workflowPath: ".github/workflows/qa-mobile.yml", headBranch: "main", runAttempt: 2,
        repositoryFullName: "acme-internal/mobile-app", headRepositoryFullName: "acme-internal/mobile-app",
        createdAt: "2026-08-21T00:00:00Z",
        updatedAt: "2026-08-21T00:10:00Z",
      });
      expect(octokit.rest.actions.listJobsForWorkflowRun).not.toHaveBeenCalled();
    });
  });

  describe("searchCode", () => {
    it("scopes the query to the repo and maps matches to path/url/snippets", async () => {
      octokit.rest.search.code.mockResolvedValue({
        data: {
          items: [
            {
              path: "src/screens/ConnectedApps.tsx",
              html_url: "https://github.com/acme/web-app/blob/main/src/screens/ConnectedApps.tsx",
              text_matches: [{ fragment: "otpMethod: 'email'" }, {}],
            },
          ],
        },
      });

      const results = await provider.searchCode("acme", "web-app", "otpMethod");

      expect(octokit.rest.search.code).toHaveBeenCalledWith(
        expect.objectContaining({ q: "otpMethod repo:acme/web-app" }),
      );
      expect(results).toEqual([
        {
          path: "src/screens/ConnectedApps.tsx",
          url: "https://github.com/acme/web-app/blob/main/src/screens/ConnectedApps.tsx",
          snippets: ["otpMethod: 'email'"],
        },
      ]);
    });

    it("returns an empty array on no matches rather than treating it as an error", async () => {
      octokit.rest.search.code.mockResolvedValue({ data: { items: [] } });
      const results = await provider.searchCode("acme", "web-app", "nonexistent-thing");
      expect(results).toEqual([]);
    });

    it("turns a 403/404 into a clear 'App not installed with Contents:read' error", async () => {
      octokit.rest.search.code.mockRejectedValue({ status: 403 });

      await expect(provider.searchCode("acme", "web-app", "otp")).rejects.toThrow(
        /acme\/web-app.*Contents:read/,
      );
    });
  });

  describe("getFileContents", () => {
    function fileResponse(text: string, overrides: Record<string, unknown> = {}) {
      return {
        data: {
          type: "file",
          encoding: "base64",
          content: Buffer.from(text, "utf8").toString("base64"),
          ...overrides,
        },
      };
    }

    it("decodes base64 content and passes ref through", async () => {
      octokit.rest.repos.getContent.mockResolvedValue(fileResponse("export const otpMethod = 'email';\n"));

      const result = await provider.getFileContents("acme", "web-app", "src/otp.ts", "release/1.2");

      expect(octokit.rest.repos.getContent).toHaveBeenCalledWith({
        owner: "acme",
        repo: "web-app",
        path: "src/otp.ts",
        ref: "release/1.2",
      });
      expect(result).toBe("export const otpMethod = 'email';\n");
    });

    it("omits ref when the caller does not supply one", async () => {
      octokit.rest.repos.getContent.mockResolvedValue(fileResponse("x"));

      await provider.getFileContents("acme", "web-app", "src/a.ts");

      expect(octokit.rest.repos.getContent).toHaveBeenCalledWith(
        expect.objectContaining({ ref: undefined }),
      );
    });

    it("preserves multi-byte characters through the base64 decode", async () => {
      octokit.rest.repos.getContent.mockResolvedValue(fileResponse('const label = "confirmación ✓";\n'));

      const result = await provider.getFileContents("acme", "web-app", "src/i18n.ts");

      expect(result).toBe('const label = "confirmación ✓";\n');
    });

    it("returns null on 404 rather than throwing — a missing path is a legitimate answer", async () => {
      octokit.rest.repos.getContent.mockRejectedValue({ status: 404 });

      await expect(provider.getFileContents("acme", "web-app", "src/nope.ts")).resolves.toBeNull();
    });

    it("returns null when the path is a directory, not a file", async () => {
      octokit.rest.repos.getContent.mockResolvedValue({ data: [{ type: "file", name: "a.ts" }] });

      await expect(provider.getFileContents("acme", "web-app", "src")).resolves.toBeNull();
    });

    it("returns null (not an empty string) for a file too large to inline", async () => {
      // GitHub's shape for an oversized file: encoding "none", content "".
      octokit.rest.repos.getContent.mockResolvedValue({
        data: { type: "file", encoding: "none", content: "" },
      });

      await expect(provider.getFileContents("acme", "web-app", "big.bin")).resolves.toBeNull();
    });

    it("returns null for a submodule entry", async () => {
      octokit.rest.repos.getContent.mockResolvedValue({ data: { type: "submodule" } });

      await expect(provider.getFileContents("acme", "web-app", "vendor/dep")).resolves.toBeNull();
    });

    it("still turns a 403 into a clear 'App not installed with Contents:read' error", async () => {
      octokit.rest.repos.getContent.mockRejectedValue({ status: 403 });

      await expect(provider.getFileContents("acme", "web-app", "src/a.ts")).rejects.toThrow(
        /acme\/web-app.*Contents:read/,
      );
    });

    it("rethrows a non-403/404 failure untouched", async () => {
      octokit.rest.repos.getContent.mockRejectedValue({ status: 500, message: "boom" });

      await expect(provider.getFileContents("acme", "web-app", "src/a.ts")).rejects.toMatchObject({
        status: 500,
      });
    });
  });

  describe("getTree", () => {
    it("lists a directory via getContent — metadata only, never file contents", async () => {
      octokit.rest.repos.getContent.mockResolvedValue({
        data: [
          { type: "file", path: "src/otp.ts", sha: "aaa", size: 40, content: "MUST-NOT-APPEAR" },
          { type: "dir", path: "src/screens", sha: "bbb" },
        ],
      });

      const result = await provider.getTree("acme", "web-app", "src", "release/1.2");

      expect(octokit.rest.repos.getContent).toHaveBeenCalledWith({
        owner: "acme",
        repo: "web-app",
        path: "src",
        ref: "release/1.2",
      });
      expect(octokit.rest.git.getTree).not.toHaveBeenCalled();
      expect(result).toEqual({
        entries: [
          { path: "src/otp.ts", type: "blob", size: 40, sha: "aaa" },
          { path: "src/screens", type: "tree", size: null, sha: "bbb" },
        ],
        truncated: false,
      });
      expect(JSON.stringify(result)).not.toContain("MUST-NOT-APPEAR");
    });

    it("lists the whole repo recursively when path is omitted", async () => {
      octokit.rest.git.getTree.mockResolvedValue({
        data: {
          truncated: false,
          tree: [
            { path: "src/otp.ts", type: "blob", size: 12, sha: "abc" },
            { path: "src", type: "tree", sha: "def" },
            { path: "vendor/dep", type: "commit", sha: "sub" },
          ],
        },
      });

      const result = await provider.getTree("acme", "web-app", undefined, "main");

      expect(octokit.rest.git.getTree).toHaveBeenCalledWith({
        owner: "acme",
        repo: "web-app",
        tree_sha: "main",
        recursive: "true",
      });
      expect(result.entries).toEqual([
        { path: "src/otp.ts", type: "blob", size: 12, sha: "abc" },
        { path: "src", type: "tree", size: null, sha: "def" },
      ]);
      expect(result.truncated).toBe(false);
    });

    it("resolves HEAD when no ref is supplied rather than guessing main", async () => {
      octokit.rest.repos.getCommit.mockResolvedValue({ data: { sha: "headsha" } });
      octokit.rest.git.getTree.mockResolvedValue({ data: { truncated: false, tree: [] } });

      await provider.getTree("acme", "web-app");

      expect(octokit.rest.repos.getCommit).toHaveBeenCalledWith({
        owner: "acme",
        repo: "web-app",
        ref: "HEAD",
      });
      expect(octokit.rest.git.getTree).toHaveBeenCalledWith(
        expect.objectContaining({ tree_sha: "headsha", recursive: "true" }),
      );
    });

    it("reports truncation when GitHub itself cut the tree", async () => {
      octokit.rest.git.getTree.mockResolvedValue({
        data: {
          truncated: true,
          tree: [{ path: "a.ts", type: "blob", size: 1, sha: "a" }],
        },
      });

      const result = await provider.getTree("acme", "web-app", undefined, "main");

      expect(result.truncated).toBe(true);
      expect(result.entries).toHaveLength(1);
    });

    it("caps the listing and sets truncated rather than silently dropping the rest", async () => {
      const tree = Array.from({ length: 10_001 }, (_, i) => ({
        path: `f${i}.ts`,
        type: "blob",
        size: 1,
        sha: `s${i}`,
      }));
      octokit.rest.git.getTree.mockResolvedValue({ data: { truncated: false, tree } });

      const result = await provider.getTree("acme", "web-app", undefined, "main");

      expect(result.entries).toHaveLength(10_000);
      expect(result.truncated).toBe(true);
      expect(result.entries[0].path).toBe("f0.ts");
      expect(result.entries[9_999].path).toBe("f9999.ts");
    });

    it("returns an empty listing on 404 rather than throwing — a missing path is a legitimate answer", async () => {
      octokit.rest.repos.getContent.mockRejectedValue({ status: 404 });

      await expect(provider.getTree("acme", "web-app", "nope")).resolves.toEqual({
        entries: [],
        truncated: false,
      });
    });

    it("still turns a 403 into a clear 'App not installed with Contents:read' error", async () => {
      octokit.rest.repos.getContent.mockRejectedValue({ status: 403 });

      await expect(provider.getTree("acme", "web-app", "src")).rejects.toThrow(
        /acme\/web-app.*Contents:read/,
      );
    });

    it("rethrows a non-403/404 failure untouched", async () => {
      octokit.rest.git.getTree.mockRejectedValue({ status: 500, message: "boom" });

      await expect(provider.getTree("acme", "web-app", undefined, "main")).rejects.toMatchObject({
        status: 500,
      });
    });
  });

  describe("getBlob", () => {
    function blobResponse(text: string) {
      return {
        data: {
          encoding: "base64",
          content: Buffer.from(text, "utf8").toString("base64"),
          size: Buffer.byteLength(text),
        },
      };
    }

    it("decodes a utf-8 blob", async () => {
      octokit.rest.git.getBlob.mockResolvedValue(blobResponse("export const otpMethod = 'email';\n"));

      const result = await provider.getBlob("acme", "web-app", "abc123");

      expect(octokit.rest.git.getBlob).toHaveBeenCalledWith({
        owner: "acme",
        repo: "web-app",
        file_sha: "abc123",
      });
      expect(result).toBe("export const otpMethod = 'email';\n");
    });

    it("returns null on 404 rather than throwing", async () => {
      octokit.rest.git.getBlob.mockRejectedValue({ status: 404 });

      await expect(provider.getBlob("acme", "web-app", "missing")).resolves.toBeNull();
    });

    it("still turns a 403 into a clear 'App not installed with Contents:read' error", async () => {
      octokit.rest.git.getBlob.mockRejectedValue({ status: 403 });

      await expect(provider.getBlob("acme", "web-app", "abc")).rejects.toThrow(
        /acme\/web-app.*Contents:read/,
      );
    });

    it("refuses a blob that contains a NUL byte — that is binary, not text", async () => {
      octokit.rest.git.getBlob.mockResolvedValue({
        data: {
          encoding: "base64",
          content: Buffer.from([0x68, 0x00, 0x69]).toString("base64"),
        },
      });

      await expect(provider.getBlob("acme", "web-app", "bin")).resolves.toBeNull();
    });

    it("refuses invalid utf-8 rather than replacing it with U+FFFD", async () => {
      // 0xFF is not a valid UTF-8 lead byte. Buffer.toString("utf8") would
      // silently replace it; fatal TextDecoder must refuse.
      octokit.rest.git.getBlob.mockResolvedValue({
        data: {
          encoding: "base64",
          content: Buffer.from([0xff, 0xfe]).toString("base64"),
        },
      });

      await expect(provider.getBlob("acme", "web-app", "bin")).resolves.toBeNull();
    });

    it("returns null rather than a truncated prefix when the blob exceeds the decode cap", async () => {
      const huge = Buffer.alloc(512 * 1024 + 1, 0x61);
      octokit.rest.git.getBlob.mockResolvedValue({
        data: { encoding: "base64", content: huge.toString("base64"), size: huge.length },
      });

      await expect(provider.getBlob("acme", "web-app", "huge")).resolves.toBeNull();
    });

    it("honours a caller-supplied cap above the default", async () => {
      const big = Buffer.alloc(512 * 1024 + 1, 0x61);
      octokit.rest.git.getBlob.mockResolvedValue({
        data: { encoding: "base64", content: big.toString("base64"), size: big.length },
      });

      await expect(
        provider.getBlob("acme", "web-app", "big", 1024 * 1024),
      ).resolves.toHaveLength(big.length);
    });

    it("still refuses a blob over a caller-supplied cap", async () => {
      const big = Buffer.alloc(2048, 0x61);
      octokit.rest.git.getBlob.mockResolvedValue({
        data: { encoding: "base64", content: big.toString("base64"), size: big.length },
      });

      await expect(provider.getBlob("acme", "web-app", "big", 1024)).resolves.toBeNull();
    });
  });

  describe("getLargeFileContents", () => {
    // The regression this exists for: getLargeFileContents is named for the
    // documents the 512 KiB default is meant to keep out, and it used to pass
    // that default straight through. Its only caller reads a 1.6 MB OpenAPI
    // document, so every read returned null and was reported as a missing
    // GitHub App installation. A "large file" reader must read a large file.
    it("reads a document far larger than the default blob cap", async () => {
      const document = "a".repeat(1_609_129);
      // Over the contents API's inline ceiling: content omitted, sha present.
      octokit.rest.repos.getContent.mockResolvedValue({
        data: { type: "file", sha: "blobsha", content: "", encoding: "none" },
      });
      octokit.rest.git.getBlob.mockResolvedValue({
        data: {
          encoding: "base64",
          content: Buffer.from(document, "utf8").toString("base64"),
          size: document.length,
        },
      });

      const result = await provider.getLargeFileContents(
        "acme-labs",
        "e2e-tests",
        "apidog/core_openapi.json",
        "master",
      );

      expect(result).toHaveLength(document.length);
    });
  });

  describe("listWorkflowRunArtifacts", () => {
    it("maps artifacts without fetching the archive URL", async () => {
      octokit.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({
        data: {
          artifacts: [
            {
              id: 9,
              name: "lexi-evidence",
              size_in_bytes: 128,
              expired: false,
              archive_download_url: "https://example.invalid/should-not-be-fetched",
            },
          ],
        },
      });

      const result = await provider.listWorkflowRunArtifacts("acme", "web-app", 55);

      expect(octokit.rest.actions.listWorkflowRunArtifacts).toHaveBeenCalledWith({
        owner: "acme",
        repo: "web-app",
        run_id: 55,
        per_page: 100,
      });
      expect(result).toEqual([
        {
          id: 9,
          name: "lexi-evidence",
          sizeInBytes: 128,
          expired: false,
          archiveDownloadUrl: "https://example.invalid/should-not-be-fetched",
        },
      ]);
    });

    it("returns an empty array on 404 rather than throwing", async () => {
      octokit.rest.actions.listWorkflowRunArtifacts.mockRejectedValue({ status: 404 });

      await expect(provider.listWorkflowRunArtifacts("acme", "web-app", 55)).resolves.toEqual([]);
    });

    it("turns a 403 into a clear 'App not installed with Actions:read' error", async () => {
      octokit.rest.actions.listWorkflowRunArtifacts.mockRejectedValue({ status: 403 });

      await expect(provider.listWorkflowRunArtifacts("acme", "web-app", 55)).rejects.toThrow(
        /acme\/web-app.*Actions:read/,
      );
    });
  });

  describe("listWorkflowRunJobs", () => {
    it("maps jobs without downloading logs", async () => {
      octokit.rest.actions.listJobsForWorkflowRun.mockResolvedValue({
        data: {
          jobs: [
            {
              id: 9,
              name: "test",
              status: "completed",
              conclusion: "failure",
              html_url: "https://github.com/acme/web-app/actions/runs/55/job/9",
              started_at: "2026-08-21T00:00:00Z",
              completed_at: "2026-08-21T00:01:00Z",
            },
          ],
        },
      });

      const result = await provider.listWorkflowRunJobs("acme", "web-app", 55);

      expect(octokit.rest.actions.listJobsForWorkflowRun).toHaveBeenCalledWith({
        owner: "acme",
        repo: "web-app",
        run_id: 55,
        per_page: 100,
      });
      expect(result).toEqual([
        {
          jobId: 9,
          name: "test",
          status: "completed",
          conclusion: "failure",
          htmlUrl: "https://github.com/acme/web-app/actions/runs/55/job/9",
          startedAt: "2026-08-21T00:00:00Z",
          completedAt: "2026-08-21T00:01:00Z",
        },
      ]);
    });

    it("maps each job's steps — names and status, never log content", async () => {
      octokit.rest.actions.listJobsForWorkflowRun.mockResolvedValue({
        data: {
          jobs: [
            {
              id: 9,
              name: "fix",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/acme/web-app/actions/runs/55/job/9",
              started_at: "2026-08-21T00:00:00Z",
              completed_at: null,
              steps: [
                { number: 1, name: "Set up job", status: "completed", conclusion: "success", started_at: "2026-08-21T00:00:00Z", completed_at: "2026-08-21T00:00:03Z" },
                { number: 2, name: "Run Claude", status: "in_progress", conclusion: null, started_at: "2026-08-21T00:00:03Z", completed_at: null },
              ],
            },
          ],
        },
      });
      const [job] = await provider.listWorkflowRunJobs("acme", "web-app", 55);
      expect(job.steps).toEqual([
        { number: 1, name: "Set up job", status: "completed", conclusion: "success", startedAt: "2026-08-21T00:00:00Z", completedAt: "2026-08-21T00:00:03Z" },
        { number: 2, name: "Run Claude", status: "in_progress", conclusion: null, startedAt: "2026-08-21T00:00:03Z", completedAt: null },
      ]);
    });

    it("returns an empty array on 404 rather than throwing", async () => {
      octokit.rest.actions.listJobsForWorkflowRun.mockRejectedValue({ status: 404 });
      await expect(provider.listWorkflowRunJobs("acme", "web-app", 55)).resolves.toEqual([]);
    });
  });

  describe("downloadWorkflowJobLogs", () => {
    it("strips GitHub timestamp prefixes", async () => {
      octokit.rest.actions.downloadJobLogsForWorkflowRun.mockResolvedValue({
        data: "2026-08-21T00:00:00.1234567Z hello\n2026-08-21T00:00:01.0000000Z world\n",
      });
      await expect(provider.downloadWorkflowJobLogs("acme", "web-app", 9)).resolves.toBe("hello\nworld\n");
    });

    it("throws a not-found error on 404", async () => {
      octokit.rest.actions.downloadJobLogsForWorkflowRun.mockRejectedValue({ status: 404 });
      await expect(provider.downloadWorkflowJobLogs("acme", "web-app", 9)).rejects.toThrow(/Job 9.*not found/);
    });
  });

  describe("cancelWorkflowRun", () => {
    it("posts cancel for the run id", async () => {
      octokit.rest.actions.cancelWorkflowRun.mockResolvedValue({ status: 202 });
      await expect(provider.cancelWorkflowRun("acme", "web-app", 55)).resolves.toBeUndefined();
      expect(octokit.rest.actions.cancelWorkflowRun).toHaveBeenCalledWith({
        owner: "acme",
        repo: "web-app",
        run_id: 55,
      });
    });

    it("explains a 409 as already completed", async () => {
      octokit.rest.actions.cancelWorkflowRun.mockRejectedValue({ status: 409 });
      await expect(provider.cancelWorkflowRun("acme", "web-app", 55)).rejects.toThrow(/cannot be cancelled/);
    });

    it("turns a 403 into an Actions:write permission error", async () => {
      octokit.rest.actions.cancelWorkflowRun.mockRejectedValue({ status: 403 });
      await expect(provider.cancelWorkflowRun("acme", "web-app", 55)).rejects.toThrow(
        /acme\/web-app.*Actions:write/,
      );
    });
  });

  describe("downloadWorkflowRunArtifact", () => {
    it("returns the zip bytes GitHub handed back", async () => {
      const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      octokit.rest.actions.downloadArtifact.mockResolvedValue({ data: zip });

      const result = await provider.downloadWorkflowRunArtifact("acme", "web-app", 9);

      expect(octokit.rest.actions.downloadArtifact).toHaveBeenCalledWith({
        owner: "acme",
        repo: "web-app",
        artifact_id: 9,
        archive_format: "zip",
      });
      expect(result.equals(zip)).toBe(true);
    });

    it("reports a 404 as 'artifact not found', not as a permissions problem", async () => {
      octokit.rest.actions.downloadArtifact.mockRejectedValue({ status: 404 });

      const call = provider.downloadWorkflowRunArtifact("acme", "web-app", 9);
      await expect(call).rejects.toThrow(/Artifact 9 on acme\/web-app was not found/);
      await expect(call).rejects.not.toThrow(/Actions:read/);
    });

    it("still turns a 403 into a clear 'App not installed with Actions:read' error", async () => {
      octokit.rest.actions.downloadArtifact.mockRejectedValue({ status: 403 });

      await expect(provider.downloadWorkflowRunArtifact("acme", "web-app", 9)).rejects.toThrow(
        /acme\/web-app.*Actions:read/,
      );
    });
  });

  describe("getPullRequestFiles", () => {
    it("maps changed files including the patch when GitHub supplies one", async () => {
      octokit.rest.pulls.listFiles.mockResolvedValue({
        data: [
          {
            filename: "src/otp.ts",
            status: "modified",
            additions: 4,
            deletions: 2,
            changes: 6,
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        ],
      });

      const files = await provider.getPullRequestFiles("acme", "web-app", 99);

      expect(octokit.rest.pulls.listFiles).toHaveBeenCalledWith({
        owner: "acme",
        repo: "web-app",
        pull_number: 99,
        per_page: 100,
      });
      expect(files).toEqual([
        {
          filename: "src/otp.ts",
          status: "modified",
          additions: 4,
          deletions: 2,
          changes: 6,
          patch: "@@ -1 +1 @@\n-old\n+new",
        },
      ]);
    });

    it("leaves patch absent (not an empty string) when GitHub omits it for a binary/oversized file", async () => {
      octokit.rest.pulls.listFiles.mockResolvedValue({
        data: [
          { filename: "assets/logo.png", status: "added", additions: 0, deletions: 0, changes: 0 },
        ],
      });

      const files = await provider.getPullRequestFiles("acme", "web-app", 99);

      expect(files[0].patch).toBeUndefined();
      expect("patch" in files[0]).toBe(false);
    });

    it("returns an empty array for a PR with no changed files", async () => {
      octokit.rest.pulls.listFiles.mockResolvedValue({ data: [] });

      await expect(provider.getPullRequestFiles("acme", "web-app", 99)).resolves.toEqual([]);
    });

    it("reports a 404 as 'pull request not found', not as a permissions problem", async () => {
      octokit.rest.pulls.listFiles.mockRejectedValue({ status: 404 });

      const call = provider.getPullRequestFiles("acme", "web-app", 99);
      await expect(call).rejects.toThrow(/acme\/web-app#99 was not found/);
      // The reader must not be sent off debugging an installation that is fine.
      await expect(call).rejects.not.toThrow(/Contents:read/);
    });

    it("still turns a 403 into a clear 'App not installed with Contents:read' error", async () => {
      octokit.rest.pulls.listFiles.mockRejectedValue({ status: 403 });

      await expect(provider.getPullRequestFiles("acme", "web-app", 99)).rejects.toThrow(
        /acme\/web-app.*Contents:read/,
      );
    });

    it("rethrows a non-403/404 failure untouched", async () => {
      octokit.rest.pulls.listFiles.mockRejectedValue({ status: 502, message: "bad gateway" });

      await expect(provider.getPullRequestFiles("acme", "web-app", 99)).rejects.toMatchObject({
        status: 502,
      });
    });
  });

  describe("createPullRequest", () => {
    it("calls pulls.create with the supplied options and maps the created PR", async () => {
      const result = await provider.createPullRequest("acme", "web-app", {
        title: "Fix OTP copy",
        head: "fix/otp-copy",
        base: "main",
        body: "Closes #42",
      });

      expect(octokit.rest.pulls.create).toHaveBeenCalledWith({
        owner: "acme",
        repo: "web-app",
        title: "Fix OTP copy",
        head: "fix/otp-copy",
        base: "main",
        body: "Closes #42",
        draft: undefined,
      });
      expect(result).toEqual({
        number: 654,
        state: "open",
        merged: false,
        mergedAt: null,
        url: "https://github.com/acme/web-app/pull/654",
        draft: false,
      });
    });

    it("forwards draft:true and reports draft from GitHub's response, not the request", async () => {
      octokit.rest.pulls.create.mockResolvedValue({
        data: {
          number: 655,
          state: "open",
          merged: false,
          merged_at: null,
          html_url: "https://github.com/acme/web-app/pull/655",
          // GitHub is the authority here: it says this opened as a draft.
          draft: true,
        },
      });

      const result = await provider.createPullRequest("acme", "web-app", {
        title: "WIP",
        head: "fix/wip",
        base: "main",
        draft: true,
      });

      expect(octokit.rest.pulls.create).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
      expect(result.draft).toBe(true);
    });

    it("turns a 403/404 into an actionable Contents/PullRequests write error", async () => {
      octokit.rest.pulls.create.mockRejectedValue({ status: 403 });

      await expect(
        provider.createPullRequest("acme", "web-app", { title: "t", head: "h", base: "main" }),
      ).rejects.toThrow(/acme\/web-app.*Contents:write and PullRequests:write/);
    });

    it("rethrows GitHub's own rejection when a PR already exists for the branch pair", async () => {
      // Not idempotent by design: GitHub 422s the second attempt, and the
      // caller — not this provider — decides what to do about it.
      octokit.rest.pulls.create.mockRejectedValue({ status: 422, message: "A pull request already exists" });

      await expect(
        provider.createPullRequest("acme", "web-app", { title: "t", head: "h", base: "main" }),
      ).rejects.toMatchObject({ status: 422 });
    });
  });

  describe("mergePullRequest", () => {
    it("calls pulls.merge with merge_method merge and the supplied sha", async () => {
      const result = await provider.mergePullRequest("acme", "web-app", 654, {
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        commitTitle: "merge: main PR #654 (Dave)",
      });

      expect(octokit.rest.pulls.merge).toHaveBeenCalledWith({
        owner: "acme",
        repo: "web-app",
        pull_number: 654,
        merge_method: "merge",
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        commit_title: "merge: main PR #654 (Dave)",
        commit_message: undefined,
      });
      expect(result).toEqual({
        merged: true,
        sha: "ffffffffffffffffffffffffffffffffffffffff",
        message: "Pull Request successfully merged",
      });
    });
  });

  describe("deleteBranch", () => {
    it("captures the tip sha BEFORE deleting, and returns it as the restore receipt", async () => {
      // First read = the tip being captured. Second read = the verification,
      // which must 404 for the branch to count as deleted.
      octokit.rest.git.getRef
        .mockResolvedValueOnce({ data: { object: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } } })
        .mockRejectedValueOnce({ status: 404 });

      const result = await provider.deleteBranch("acme-internal", "mobile-app", "judy/spike");

      expect(octokit.rest.git.getRef).toHaveBeenCalledWith({
        owner: "acme-internal",
        repo: "mobile-app",
        ref: "heads/judy/spike",
      });
      expect(octokit.rest.git.deleteRef).toHaveBeenCalledWith({
        owner: "acme-internal",
        repo: "mobile-app",
        ref: "heads/judy/spike",
      });
      // Without this sha the deletion cannot be walked back, so it is the
      // contract, not a convenience.
      expect(result).toEqual({ name: "judy/spike", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    });

    it("reads the branch back and FAILS when it is still there", async () => {
      // The refs API answers 204 whether or not it removed anything, so a
      // resolved delete call is not evidence. Here every getRef resolves —
      // i.e. the branch survived — and that must not be reported as success.
      await expect(
        provider.deleteBranch("acme-internal", "mobile-app", "judy/spike"),
      ).rejects.toThrow(BranchDeletionUnverifiedError);
      // The distinct type is what stops a caller reporting this as "nothing
      // was changed" — the delete may well have landed.
      await expect(
        provider.deleteBranch("acme-internal", "mobile-app", "judy/spike"),
      ).rejects.toMatchObject({ unverified: true });
    });

    it("refuses a branch that does not exist rather than reporting a silent success", async () => {
      octokit.rest.git.getRef.mockRejectedValue({ status: 404 });

      await expect(
        provider.deleteBranch("acme-internal", "mobile-app", "judy/gone"),
      ).rejects.toThrow(/does not exist/);
      expect(octokit.rest.git.deleteRef).not.toHaveBeenCalled();
    });

    it("reports a concurrent deletion as a race, NOT as a permission problem", async () => {
      // The read above succeeded, so the ref existed a moment ago. 404 here
      // means someone else removed it. isMissingActionsPermission treats 403
      // and 404 alike, so without an explicit check this reads as a broken
      // App installation and sends the reader after the wrong problem.
      octokit.rest.git.getRef.mockResolvedValueOnce({
        data: { object: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
      });
      octokit.rest.git.deleteRef.mockRejectedValue({ status: 404 });

      await expect(
        provider.deleteBranch("acme-internal", "mobile-app", "judy/spike"),
      ).rejects.toThrow(/deleted by someone else/);
    });

    it("reports a protected branch as a refusal rather than a permission problem", async () => {
      octokit.rest.git.getRef.mockResolvedValueOnce({
        data: { object: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
      });
      octokit.rest.git.deleteRef.mockRejectedValue({ status: 422 });

      await expect(
        provider.deleteBranch("acme-internal", "mobile-app", "release/v1"),
      ).rejects.toThrow(/protected branch/);
    });

    it("refuses to delete a ref whose sha it could not read, since it could not restore it", async () => {
      octokit.rest.git.getRef.mockResolvedValueOnce({ data: { object: {} } });

      await expect(
        provider.deleteBranch("acme-internal", "mobile-app", "judy/spike"),
      ).rejects.toThrow(/cannot restore/);
      expect(octokit.rest.git.deleteRef).not.toHaveBeenCalled();
    });

    it("rejects a branch name that could traverse refs, before any network call", async () => {
      await expect(
        provider.deleteBranch("acme-internal", "mobile-app", "../../refs/tags/v1"),
      ).rejects.toThrow(/not a legal/);
      expect(octokit.rest.git.deleteRef).not.toHaveBeenCalled();
    });
  });

  describe("createBranch", () => {
    it("reads the source tip and creates refs/heads/{name} at that sha", async () => {
      const result = await provider.createBranch("acme-internal", "mobile-app", {
        name: "release/integration-2026-08-19",
      });

      expect(octokit.rest.git.getRef).toHaveBeenCalledWith({
        owner: "acme-internal",
        repo: "mobile-app",
        ref: "heads/main",
      });
      expect(octokit.rest.git.createRef).toHaveBeenCalledWith({
        owner: "acme-internal",
        repo: "mobile-app",
        ref: "refs/heads/release/integration-2026-08-19",
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
      expect(result.name).toBe("release/integration-2026-08-19");
      expect(result.sha).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    });

    it("refuses a branch that already exists rather than force-updating it", async () => {
      octokit.rest.git.createRef.mockRejectedValue({ status: 422, message: "Reference already exists" });

      await expect(
        provider.createBranch("acme-internal", "mobile-app", { name: "release/x" }),
      ).rejects.toThrow(/already exists/);
    });

    it("rejects a branch name that could traverse refs", async () => {
      await expect(
        provider.createBranch("acme-internal", "mobile-app", { name: "foo/../main" }),
      ).rejects.toThrow(/not a legal git ref/);
      expect(octokit.rest.git.createRef).not.toHaveBeenCalled();
    });
  });

  describe("mergeIntoBranch", () => {
    it("merges a head sha into the named base", async () => {
      const result = await provider.mergeIntoBranch("acme-internal", "design_system", {
        base: "release/integration-2026-08-19",
        head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        commitMessage: "merge: quill PR #60 (Judy Z)",
      });

      expect(octokit.rest.repos.merge).toHaveBeenCalledWith({
        owner: "acme-internal",
        repo: "design_system",
        base: "release/integration-2026-08-19",
        head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        commit_message: "merge: quill PR #60 (Judy Z)",
      });
      expect(result).toEqual({
        merged: true,
        alreadyUpToDate: false,
        conflict: false,
        sha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        message: "merge: quill PR #60 (Judy Z)",
      });
    });

    it("returns conflict:true on GitHub 409 rather than throwing", async () => {
      octokit.rest.repos.merge.mockRejectedValue({ status: 409, message: "Merge conflict" });

      const result = await provider.mergeIntoBranch("acme-internal", "mobile-packages", {
        base: "release/x",
        head: "feature/y",
      });

      expect(result.merged).toBe(false);
      expect(result.conflict).toBe(true);
    });

    it("refuses a lexi/* base before calling repos.merge", async () => {
      await expect(
        provider.mergeIntoBranch("acme", "web-app", {
          base: "lexi/sync-login",
          head: "fix/login-crash",
        }),
      ).rejects.toThrow(/pull request/i);
      expect(octokit.rest.repos.merge).not.toHaveBeenCalled();
    });
  });

  describe("updateSubmodulePointer", () => {
    it("commits a gitlink on the named branch", async () => {
      const result = await provider.updateSubmodulePointer("acme-internal", "mobile-app", {
        branch: "release/integration-2026-08-19",
        path: "packages",
        sha: "dddddddddddddddddddddddddddddddddddddddd",
        commitMessage: "chore: bump packages to dddd (from Judy Z)",
      });

      expect(octokit.rest.git.createTree).toHaveBeenCalledWith({
        owner: "acme-internal",
        repo: "mobile-app",
        base_tree: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        tree: [
          {
            path: "packages",
            mode: "160000",
            type: "commit",
            sha: "dddddddddddddddddddddddddddddddddddddddd",
          },
        ],
      });
      expect(octokit.rest.git.updateRef).toHaveBeenCalledWith({
        owner: "acme-internal",
        repo: "mobile-app",
        ref: "heads/release/integration-2026-08-19",
        sha: "dddddddddddddddddddddddddddddddddddddddd",
      });
      expect(result.path).toBe("packages");
      expect(result.commitSha).toBe("dddddddddddddddddddddddddddddddddddddddd");
    });

    it("refuses a submodule path outside the nested-repo allowlist", async () => {
      await expect(
        provider.updateSubmodulePointer("acme-internal", "mobile-app", {
          branch: "release/x",
          path: "../secrets",
          sha: "dddddddddddddddddddddddddddddddddddddddd",
          commitMessage: "nope",
        }),
      ).rejects.toThrow(/not allowed/);
      expect(octokit.rest.git.createTree).not.toHaveBeenCalled();
    });
  });

  describe("closePullRequest", () => {
    it("calls pulls.update with state:closed and maps the response to a GithubPullRequestDto", async () => {
      const result = await provider.closePullRequest("acme", "web-app", 321);

      expect(octokit.rest.pulls.update).toHaveBeenCalledWith({
        owner: "acme",
        repo: "web-app",
        pull_number: 321,
        state: "closed",
      });
      expect(result).toEqual({
        number: 321,
        state: "closed",
        merged: false,
        mergedAt: null,
        url: "https://github.com/acme/web-app/pull/321",
      });
    });
  });

  describe("appendPullRequestClosingRef", () => {
    it("appends Fixes owner/repo#N when the PR body has no closing keyword", async () => {
      octokit.rest.pulls.get.mockResolvedValue({
        data: { number: 77, body: "What this change does.", state: "open", merged: false, html_url: "https://github.com/acme/web-app/pull/77" },
      });

      await provider.appendPullRequestClosingRef("acme", "web-app", 77, "acme/web-app#88");

      expect(octokit.rest.pulls.update).toHaveBeenCalledWith({
        owner: "acme",
        repo: "web-app",
        pull_number: 77,
        body: "What this change does.\n\nFixes acme/web-app#88\n",
      });
    });

    it("does not patch the body when Fixes is already present", async () => {
      octokit.rest.pulls.get.mockResolvedValue({
        data: { number: 77, body: "Fixes acme/web-app#88\n", state: "open", merged: false, html_url: "x" },
      });

      await provider.appendPullRequestClosingRef("acme", "web-app", 77, "acme/web-app#88");

      expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
    });
  });

  /**
   * `requestedReviewers` is what lets a consumer say "waiting on alice"
   * instead of guessing an expected reviewer from a config file. The
   * stale-PR nudge depends on it, so the mapping is pinned here.
   */
  /**
   * The three reads release tracing needs, pinned against one fixture issue
   * (`acme-internal/mobile-app#1878`) throughout.
   */
  describe("release tracing reads", () => {
    it("reads an issue's milestone and closed_at, which GithubIssueDto drops", async () => {
      octokit.rest.issues.get.mockResolvedValue({
        data: {
          number: 1878,
          title: "Onboarding: fix phone number validation for St. Lucia (NANP territories)",
          state: "closed",
          labels: [{ name: "bug" }, { name: "bug-confirmed" }, "Completed QA"],
          milestone: null,
          closed_at: "2026-08-11T02:43:50Z",
          html_url: "https://github.com/acme-internal/mobile-app/issues/1878",
        },
      });

      const issue = await provider.getIssueDetail("acme-internal", "mobile-app", 1878);

      expect(issue.labels).toEqual(["bug", "bug-confirmed", "Completed QA"]);
      expect(issue.closedAt).toBe("2026-08-11T02:43:50Z");
      // The load-bearing fact of the whole feature: this issue shipped in
      // v1.16.0 and carries no milestone at all.
      expect(issue.milestone).toBeNull();
    });

    it("flattens a milestone object to its title", async () => {
      octokit.rest.issues.get.mockResolvedValue({
        data: {
          number: 1,
          title: "t",
          state: "open",
          labels: [],
          milestone: { title: "Sprint 42" },
          closed_at: null,
          html_url: "u",
        },
      });

      const issue = await provider.getIssueDetail("o", "r", 1);
      expect(issue.milestone).toBe("Sprint 42");
    });

    it("lists tags in the order GitHub returns them, without inventing an ordering", async () => {
      octokit.rest.repos.listTags.mockResolvedValue({
        data: [
          { name: "v2.334.1", commit: { sha: "b3baf54" } },
          { name: "v1.17.0", commit: { sha: "08e7beb" } },
          { name: "v1.16.0", commit: { sha: "e957b8a" } },
        ],
      });

      const tags = await provider.listTags("acme-internal", "mobile-app");

      // v2.334.1 first is the real repo's order, and it does NOT contain the
      // fix. Any re-sorting here would hide that from the caller.
      expect(tags.map((t) => t.name)).toEqual(["v2.334.1", "v1.17.0", "v1.16.0"]);
      expect(tags[0].commitSha).toBe("b3baf54");
    });

    it("stops paginating tags at maxTags", async () => {
      octokit.rest.repos.listTags.mockResolvedValue({
        data: Array.from({ length: 100 }, (_, i) => ({ name: `v${i}`, commit: { sha: `s${i}` } })),
      });

      const tags = await provider.listTags("o", "r", 10);
      expect(tags).toHaveLength(10);
    });

    it("maps a comparison to status and ahead/behind counts", async () => {
      octokit.rest.repos.compareCommitsWithBasehead.mockResolvedValue({
        data: { status: "ahead", ahead_by: 73, behind_by: 0 },
      });

      const comparison = await provider.compareCommits(
        "acme-internal",
        "mobile-app",
        "630048642ad31d0586782162a1675b7556b73c59",
        "v1.16.0",
      );

      expect(octokit.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith(
        expect.objectContaining({ basehead: "630048642ad31d0586782162a1675b7556b73c59...v1.16.0" }),
      );
      expect(comparison).toEqual({ status: "ahead", aheadBy: 73, behindBy: 0 });
    });

    it("returns null for a tag that vanished between listing and comparing", async () => {
      octokit.rest.repos.compareCommitsWithBasehead.mockRejectedValue({ status: 404 });
      // One deleted tag must skip one comparison, not fail the release trace.
      await expect(provider.compareCommits("o", "r", "sha", "v9.9.9")).resolves.toBeNull();
    });

    it("propagates a non-404 comparison error rather than reporting 'no tag'", async () => {
      octokit.rest.repos.compareCommitsWithBasehead.mockRejectedValue({ status: 403, message: "rate limited" });
      await expect(provider.compareCommits("o", "r", "sha", "v1.0.0")).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("getReviewStatus", () => {
    function stubPr(overrides: Record<string, unknown> = {}) {
      octokit.rest.pulls.get.mockResolvedValue({
        data: {
          number: 42,
          html_url: "https://github.com/acme/web-app/pull/42",
          state: "open",
          draft: false,
          merged: false,
          mergeable: true,
          head: { sha: "abc" },
          ...overrides,
        },
      });
      octokit.rest.pulls.listReviews = vi.fn().mockResolvedValue({ data: [] });
      (octokit.rest as Record<string, unknown>).checks = {
        listForRef: vi.fn().mockResolvedValue({ data: { check_runs: [] } }),
      };
    }

    it("reports the head SHA and that checks were read", async () => {
      stubPr();

      const result = await provider.getReviewStatus("acme", "web-app", 42);

      expect(result.headSha).toBe("abc");
      expect(result.checksRead).toBe(true);
    });

    it("marks checks unread, not empty, when listing them fails", async () => {
      stubPr();
      (octokit.rest as unknown as { checks: { listForRef: ReturnType<typeof vi.fn> } }).checks.listForRef = vi
        .fn()
        .mockRejectedValue(new Error("403"));

      const result = await provider.getReviewStatus("acme", "web-app", 42);

      expect(result.checks).toEqual([]);
      expect(result.checksRead).toBe(false);
    });

    it("maps requested reviewers and teams off pulls.get", async () => {
      stubPr({
        requested_reviewers: [{ login: "alice" }, { login: "bob" }],
        requested_teams: [{ slug: "web-site" }],
      });

      const result = await provider.getReviewStatus("acme", "web-app", 42);

      expect(result.requestedReviewers).toEqual(["alice", "bob"]);
      expect(result.requestedTeams).toEqual(["web-site"]);
    });

    it("degrades to empty arrays when GitHub omits the fields entirely", async () => {
      stubPr();

      const result = await provider.getReviewStatus("acme", "web-app", 42);

      // Empty, never undefined: a caller must not have to tell "no reviewers
      // requested" apart from "the field was missing".
      expect(result.requestedReviewers).toEqual([]);
      expect(result.requestedTeams).toEqual([]);
    });

    it("drops reviewer entries with no resolvable login rather than inventing one", async () => {
      stubPr({ requested_reviewers: [{ login: "alice" }, { login: null }, {}] });

      const result = await provider.getReviewStatus("acme", "web-app", 42);

      expect(result.requestedReviewers).toEqual(["alice"]);
    });
  });
});

/**
 * A GitHub App installation token is strictly scoped to the org it was
 * minted for. `this.octokit` (the primary client) is bound to whichever
 * installation covers GITHUB_OWNER/GITHUB_REPO — using it to dispatch
 * against a *different* org always 403/404s, regardless of whether the App
 * is separately installed there. Confirmed live: dispatching to
 * acme-internal/mobile-app worked (same org as the primary repo);
 * acme/web-app failed with "not installed" even after the App was
 * confirmed installed there on GitHub's side.
 */
describe("OctokitGithubProvider cross-org dispatch (getClientForRepo)", () => {
  const appAuth = { appId: "123", privateKey: "test-key", baseUrl: "https://api.github.com" };
  let octokit: ReturnType<typeof makeCrossOrgPrimaryOctokit>;
  let logger: PinoLoggerService;
  let provider: OctokitGithubProvider;

  function makeCrossOrgPrimaryOctokit() {
    return { rest: makeCrossOrgRestSurface() };
  }

  beforeEach(() => {
    constructedClients.length = 0;
    mockResolveInstallationId.mockReset();
    mockResolveInstallationId.mockResolvedValue(999);
    octokit = makeCrossOrgPrimaryOctokit();
    logger = new PinoLoggerService({ level: "silent" });
    provider = new OctokitGithubProvider(octokit as never, logger, appAuth);
  });

  it("resolves a dedicated installation client for a repo other than the primary one, not the primary client", async () => {
    await provider.dispatchWorkflow("acme", "web-app", "direct-fix.yml", "main", {});

    expect(octokit.rest.actions.createWorkflowDispatch).not.toHaveBeenCalled();
    expect(mockResolveInstallationId).toHaveBeenCalledWith(expect.anything(), "acme", "web-app");
    // Two Octokit constructions: one app-level (JWT, no installationId) to
    // resolve which installation covers acme/web-app, one
    // installation-scoped (with the resolved id) to actually call it.
    expect(constructedClients).toHaveLength(2);
    expect(constructedClients[0].auth.installationId).toBeUndefined();
    expect(constructedClients[1].auth.installationId).toBe(999);
    expect(constructedClients[1].rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
  });

  it("caches the resolved client so a second call for the same repo does not re-resolve", async () => {
    await provider.dispatchWorkflow("acme", "web-app", "direct-fix.yml", "main", {});
    await provider.findDispatchedRun("acme", "web-app", "direct-fix.yml", new Date());

    expect(mockResolveInstallationId).toHaveBeenCalledTimes(1);
    // Still just 2: the app-level client and the one cached installation
    // client, reused for the second call rather than building a third.
    expect(constructedClients).toHaveLength(2);
  });

  it("resolves separate clients for two different target repos", async () => {
    mockResolveInstallationId.mockResolvedValueOnce(999).mockResolvedValueOnce(888);

    await provider.dispatchWorkflow("acme", "web-app", "direct-fix.yml", "main", {});
    await provider.dispatchWorkflow("acme-internal", "mobile-app", "direct-fix.yml", "main", {});

    expect(mockResolveInstallationId).toHaveBeenCalledTimes(2);
    // App-level client + one installation client per distinct target repo.
    expect(constructedClients).toHaveLength(3);
  });

  it("falls back to the primary client unchanged when no App credentials are configured (token-mode auth)", async () => {
    const tokenModeOctokit = makeCrossOrgPrimaryOctokit();
    const tokenModeProvider = new OctokitGithubProvider(tokenModeOctokit as never, logger);

    await tokenModeProvider.dispatchWorkflow("acme", "web-app", "direct-fix.yml", "main", {});

    expect(mockResolveInstallationId).not.toHaveBeenCalled();
    expect(constructedClients).toHaveLength(0);
    expect(tokenModeOctokit.rest.actions.createWorkflowDispatch).toHaveBeenCalledTimes(1);
  });

  it("reads a pull request on a non-primary org through the target installation, not the primary client", async () => {
    const pr = await provider.getPullRequest("acme", "web-app", 3099);

    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
    expect(mockResolveInstallationId).toHaveBeenCalledWith(expect.anything(), "acme", "web-app");
    expect(constructedClients[1].rest.pulls.get).toHaveBeenCalledWith({
      owner: "acme",
      repo: "web-app",
      pull_number: 3099,
    });
    expect(pr).toMatchObject({ number: 3099, state: "open", merged: false });
  });

  it("closes a pull request on a non-primary org through the target installation, not the primary client", async () => {
    await provider.closePullRequest("acme", "web-app", 3099);

    expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
    expect(constructedClients[1].rest.pulls.update).toHaveBeenCalledWith({
      owner: "acme",
      repo: "web-app",
      pull_number: 3099,
      state: "closed",
    });
  });

  it("comments on a pull request on a non-primary org through the target installation", async () => {
    await provider.addComment("acme", "web-app", 3099, "Closing without merging.");

    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(constructedClients[1].rest.issues.createComment).toHaveBeenCalledWith({
      owner: "acme",
      repo: "web-app",
      issue_number: 3099,
      body: "Closing without merging.",
    });
  });
  it("lists pull requests on a non-primary org through the target installation", async () => {
    const listed = await provider.listPullRequests("acme", "web-app");

    expect(octokit.rest.pulls.list).not.toHaveBeenCalled();
    expect(constructedClients[1].rest.pulls.list).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "web-app",
        state: "open",
        sort: "created",
        direction: "asc",
      }),
    );
    expect(listed[0]).toMatchObject({ number: 12, title: "oldest" });
  });

  it("creates a spec issue on a non-primary org through the target installation, not the primary client", async () => {
    const created = await provider.createIssue(
      "acme",
      "web-app",
      "Move FATCA and PEP",
      "spec body",
      ["type:spec", "spec:draft"],
    );

    expect(octokit.rest.issues.create).not.toHaveBeenCalled();
    expect(mockResolveInstallationId).toHaveBeenCalledWith(expect.anything(), "acme", "web-app");
    expect(constructedClients[1].rest.issues.create).toHaveBeenCalledWith({
      owner: "acme",
      repo: "web-app",
      title: "Move FATCA and PEP",
      body: "spec body",
      labels: ["type:spec", "spec:draft"],
    });
    expect(created).toMatchObject({ githubNumber: 88, repoOwner: "acme", repoName: "web-app" });
  });

  /**
   * The P2P QA handoff regression. `bm_request_p2p_qa` reads the `[TAG]`
   * tracking issue to check the requester marker before it posts, and that read
   * went through the primary client — so it answered `Not Found` for every
   * issue number in acme/p2p-web while `list_pull_requests` on the same
   * repo worked, because listing already went through `getClientForRepo`.
   * Twice in one Slack thread that surfaced as "QA has not been notified".
   */
  it("reads an issue on a non-primary org through the target installation, not the primary client", async () => {
    const issue = await provider.getIssue("acme", "p2p-web", 1504);

    expect(octokit.rest.issues.get).not.toHaveBeenCalled();
    expect(mockResolveInstallationId).toHaveBeenCalledWith(expect.anything(), "acme", "p2p-web");
    expect(constructedClients[1].rest.issues.get).toHaveBeenCalledWith({
      owner: "acme",
      repo: "p2p-web",
      issue_number: 1504,
    });
    expect(issue).toMatchObject({ githubNumber: 1504, repoOwner: "acme", repoName: "p2p-web" });
    expect(issue.body).toContain("lexi-p2p-release-requester");
  });

  /** Same root cause as `getIssue`: this is what `get_issue_fix_version` reads. */
  it("reads issue detail on a non-primary org through the target installation", async () => {
    await provider.getIssueDetail("acme", "p2p-web", 1452);

    expect(octokit.rest.issues.get).not.toHaveBeenCalled();
    expect(constructedClients[1].rest.issues.get).toHaveBeenCalledWith({
      owner: "acme",
      repo: "p2p-web",
      issue_number: 1452,
    });
  });

  it("lists issue comments on a non-primary org through the target installation", async () => {
    const comments = await provider.listComments("acme", "p2p-web", 1504);

    expect(octokit.rest.issues.listComments).not.toHaveBeenCalled();
    // objectContaining because the call now carries per_page/page. This test is
    // about which installation client is used, not the page size.
    expect(constructedClients[1].rest.issues.listComments).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "p2p-web",
        issue_number: 1504,
      }),
    );
    expect(comments[0]).toMatchObject({ id: 7, authorLogin: "olivia" });
  });

  it("lists issues on a non-primary org through the target installation", async () => {
    await provider.listIssues({ owner: "acme", repo: "p2p-web" });

    expect(octokit.rest.issues.listForRepo).not.toHaveBeenCalled();
    expect(constructedClients[1].rest.issues.listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "p2p-web" }),
    );
  });

  it("closes an issue on a non-primary org through the target installation", async () => {
    await provider.closeIssue("acme", "p2p-web", 1504);

    expect(octokit.rest.issues.update).not.toHaveBeenCalled();
    expect(constructedClients[1].rest.issues.update).toHaveBeenCalledWith({
      owner: "acme",
      repo: "p2p-web",
      issue_number: 1504,
      state: "closed",
      state_reason: "completed",
    });
  });

  /** Release tracing compares tags in the product repo, not the primary one. */
  it("lists tags on a non-primary org through the target installation", async () => {
    const tags = await provider.listTags("acme", "p2p-web", 100);

    expect(octokit.rest.repos.listTags).not.toHaveBeenCalled();
    expect(constructedClients[1].rest.repos.listTags).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "p2p-web" }),
    );
    expect(tags[0]).toEqual({ name: "production_v20260831_0", commitSha: "abc123" });
  });

  it("sets spec labels on a non-primary org through the target installation, not the primary client", async () => {
    const labels = await provider.setLabels("acme", "web-app", 88, ["type:spec", "spec:approved"]);

    expect(octokit.rest.issues.setLabels).not.toHaveBeenCalled();
    expect(constructedClients[1].rest.issues.setLabels).toHaveBeenCalledWith({
      owner: "acme",
      repo: "web-app",
      issue_number: 88,
      labels: ["type:spec", "spec:approved"],
    });
    expect(labels).toEqual(["type:spec", "spec:approved"]);
  });
});

describe("OctokitGithubProvider.getRepoAccessToken", () => {
  it("returns the installation token from octokit.auth", async () => {
    const octokit = { auth: vi.fn(async () => ({ token: "ghs_test" })) };
    const logger = new PinoLoggerService({ level: "silent" });
    const provider = new OctokitGithubProvider(octokit as never, logger);
    await expect(provider.getRepoAccessToken("acme-internal", "mobile-app")).resolves.toBe("ghs_test");
    expect(octokit.auth).toHaveBeenCalledWith({ type: "installation" });
  });

  it("falls back to auth() when type:installation is rejected (PAT mode)", async () => {
    const octokit = {
      auth: vi.fn(async (arg?: { type?: string }) => {
        if (arg?.type === "installation") throw new Error("not an app");
        return { token: "ghp_pat" };
      }),
    };
    const logger = new PinoLoggerService({ level: "silent" });
    const provider = new OctokitGithubProvider(octokit as never, logger);
    await expect(provider.getRepoAccessToken("acme-internal", "mobile-app")).resolves.toBe("ghp_pat");
  });
});

describe("OctokitGithubProvider.getIssueHtml", () => {
  it("uses body_html from issues.get with the full media type, not markdown body", async () => {
    const octokit = {
      rest: {
        issues: {
          get: vi.fn(async () => ({
            data: {
              body: "![x](https://github.com/user-attachments/assets/86dbf525-6d9a-4586-9442-e2b4782086dc)",
              body_html:
                '<video src="https://private-user-images.githubusercontent.com/1/2-86dbf525-6d9a-4586-9442-e2b4782086dc.MOV?jwt=a">',
            },
          })),
        },
      },
    };
    const logger = new PinoLoggerService({ level: "silent" });
    const provider = new OctokitGithubProvider(octokit as never, logger);
    const html = await provider.getIssueHtml("acme-internal", "mobile-app", 2052);
    expect(html).toContain("private-user-images");
    expect(html).not.toContain("user-attachments");
    expect(octokit.rest.issues.get).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme-internal",
        repo: "mobile-app",
        issue_number: 2052,
        mediaType: { format: "full" },
      }),
    );
  });

  it("falls back to GraphQL bodyHTML when REST omits body_html", async () => {
    const octokit = {
      rest: {
        issues: {
          get: vi.fn(async () => ({
            data: { body: "markdown only" },
          })),
        },
      },
      graphql: vi.fn(async () => ({
        repository: {
          issue: {
            bodyHTML:
              '<video src="https://private-user-images.githubusercontent.com/1/x.mp4?jwt=a">',
            comments: { nodes: [] },
          },
        },
      })),
    };
    const logger = new PinoLoggerService({ level: "silent" });
    const provider = new OctokitGithubProvider(octokit as never, logger);
    const html = await provider.getIssueHtml("acme-internal", "mobile-app", 2003);
    expect(html).toContain("private-user-images");
    expect(octokit.graphql).toHaveBeenCalled();
  });

  it("retries with the user-PAT client when the App HTML has no signed CDN", async () => {
    const appClient = {
      rest: {
        issues: {
          get: vi.fn(async () => ({ data: { body_html: "<p>no cdn</p>" } })),
        },
      },
    };
    const evidenceClient = {
      rest: {
        issues: {
          get: vi.fn(async () => ({
            data: {
              body_html:
                '<video src="https://private-user-images.githubusercontent.com/1/x.mp4?jwt=a">',
            },
          })),
        },
      },
    };
    const logger = new PinoLoggerService({ level: "silent" });
    const provider = new OctokitGithubProvider(
      appClient as never,
      logger,
      undefined,
      evidenceClient as never,
    );
    const html = await provider.getIssueHtml("acme-internal", "mobile-app", 2052);
    expect(html).toContain("private-user-images");
    expect(evidenceClient.rest.issues.get).toHaveBeenCalled();
  });
});

describe("OctokitGithubProvider.renderGfmHtml", () => {
  it("renders markdown in repo context", async () => {
    const octokit = {
      request: vi.fn(async () => ({
        data: '<img src="https://private-user-images.githubusercontent.com/1/x.png?jwt=a">',
      })),
    };
    const logger = new PinoLoggerService({ level: "silent" });
    const provider = new OctokitGithubProvider(octokit as never, logger);
    const html = await provider.renderGfmHtml(
      "acme-internal",
      "mobile-app",
      "![](https://github.com/user-attachments/assets/86dbf525-6d9a-4586-9442-e2b4782086dc)",
    );
    expect(html).toContain("private-user-images");
    expect(octokit.request).toHaveBeenCalledWith(
      "POST /markdown",
      expect.objectContaining({ mode: "gfm", context: "acme-internal/mobile-app" }),
    );
  });
});

describe("OctokitGithubProvider.resolveRef", () => {
  const logger = new PinoLoggerService({ level: "silent" });
  const notFound = Object.assign(new Error("Not Found"), { status: 404 });

  function makeOctokit(overrides: Record<string, unknown> = {}) {
    return {
      rest: {
        repos: {
          get: vi.fn(async () => ({ data: { default_branch: "main" } })),
          getContent: vi.fn(async () => {
            throw notFound;
          }),
          ...(overrides.repos as object),
        },
        git: {
          getRef: vi.fn(async () => {
            throw notFound;
          }),
          getCommit: vi.fn(async () => {
            throw notFound;
          }),
          ...(overrides.git as object),
        },
      },
    };
  }

  it("resolves a branch to its full sha via heads/", async () => {
    const octokit = makeOctokit({
      git: {
        getRef: vi.fn(async () => ({
          data: { object: { sha: "1111111111111111111111111111111111111111" } },
        })),
      },
    });
    const provider = new OctokitGithubProvider(octokit as never, logger);
    await expect(
      provider.resolveRef("acme-internal", "mobile-packages", { ref: "release-integration-x" }),
    ).resolves.toEqual({
      requested: "release-integration-x",
      sha: "1111111111111111111111111111111111111111",
      kind: "branch",
    });
    expect(octokit.rest.git.getRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "heads/release-integration-x" }),
    );
  });

  it("falls back to tags/ when the name is not a branch", async () => {
    const getRef = vi.fn(async ({ ref }: { ref: string }) => {
      if (ref.startsWith("heads/")) throw notFound;
      return { data: { object: { sha: "2222222222222222222222222222222222222222" } } };
    });
    const provider = new OctokitGithubProvider(makeOctokit({ git: { getRef } }) as never, logger);
    const result = await provider.resolveRef("acme-internal", "mobile-app", { ref: "v1.18.0" });
    expect(result).toEqual({
      requested: "v1.18.0",
      sha: "2222222222222222222222222222222222222222",
      kind: "tag",
    });
  });

  it("uses the repository default branch when no ref is given", async () => {
    const getRef = vi.fn(async () => ({
      data: { object: { sha: "3333333333333333333333333333333333333333" } },
    }));
    const octokit = makeOctokit({ git: { getRef } });
    const provider = new OctokitGithubProvider(octokit as never, logger);
    const result = await provider.resolveRef("acme-internal", "mobile-app");
    expect(result?.requested).toBe("main");
    expect(getRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "heads/main" }));
  });

  // The gap that stalled 1.18.0: the Contents API answers this directly.
  it("reads a submodule gitlink and reports kind:submodule", async () => {
    const getContent = vi.fn(async () => ({
      data: {
        type: "submodule",
        sha: "4444444444444444444444444444444444444444",
        submodule_git_url: "https://github.com/acme-internal/mobile-packages.git",
      },
    }));
    const provider = new OctokitGithubProvider(makeOctokit({ repos: { getContent } }) as never, logger);
    await expect(
      provider.resolveRef("acme-internal", "mobile-app", {
        submodulePath: "packages",
        ref: "release-integration-x",
      }),
    ).resolves.toEqual({
      requested: "packages",
      sha: "4444444444444444444444444444444444444444",
      kind: "submodule",
      submoduleUrl: "https://github.com/acme-internal/mobile-packages.git",
    });
    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: "packages", ref: "release-integration-x" }),
    );
  });

  // A blob sha looks exactly like a commit sha. Returning one would let a
  // caller commit a gitlink that points at nothing.
  it("returns null when the path exists but is a file, not a gitlink", async () => {
    const getContent = vi.fn(async () => ({
      data: { type: "file", sha: "5555555555555555555555555555555555555555" },
    }));
    const provider = new OctokitGithubProvider(makeOctokit({ repos: { getContent } }) as never, logger);
    await expect(
      provider.resolveRef("acme-internal", "mobile-app", { submodulePath: "README.md" }),
    ).resolves.toBeNull();
  });

  it("verifies a bare commit sha rather than echoing it back", async () => {
    const getCommit = vi.fn(async () => ({
      data: { sha: "6666666666666666666666666666666666666666" },
    }));
    const provider = new OctokitGithubProvider(makeOctokit({ git: { getCommit } }) as never, logger);
    const result = await provider.resolveRef("acme-internal", "design_system", {
      ref: "6666666666666666666666666666666666666666",
    });
    expect(result).toEqual({
      requested: "6666666666666666666666666666666666666666",
      sha: "6666666666666666666666666666666666666666",
      kind: "commit",
    });
    expect(getCommit).toHaveBeenCalled();
  });

  it("returns null — never the input — for a ref that does not exist", async () => {
    const provider = new OctokitGithubProvider(makeOctokit() as never, logger);
    await expect(
      provider.resolveRef("acme-internal", "mobile-app", { ref: "typo-branch" }),
    ).resolves.toBeNull();
  });

  it("treats 422 from getCommit (malformed object id) as not-found, not an error", async () => {
    const getCommit = vi.fn(async () => {
      throw Object.assign(new Error("Unprocessable"), { status: 422 });
    });
    const provider = new OctokitGithubProvider(makeOctokit({ git: { getCommit } }) as never, logger);
    await expect(
      provider.resolveRef("acme-internal", "mobile-app", { ref: "not a sha" }),
    ).resolves.toBeNull();
  });

  it("propagates a non-404 failure instead of reporting the ref as absent", async () => {
    const getRef = vi.fn(async () => {
      throw Object.assign(new Error("Bad credentials"), { status: 401 });
    });
    const provider = new OctokitGithubProvider(makeOctokit({ git: { getRef } }) as never, logger);
    await expect(
      provider.resolveRef("acme-internal", "mobile-app", { ref: "main" }),
    ).rejects.toThrow("Bad credentials");
  });
});

describe("listComments pagination", () => {
  const logger = new PinoLoggerService({ level: "silent" });

  function commentPage(from: number, count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: from + i,
      user: { login: "lexi-github-app[bot]" },
      body: `comment ${from + i}`,
      created_at: "2026-09-08T00:00:00.000Z",
    }));
  }

  function providerWithPages(pages: Array<ReturnType<typeof commentPage>>) {
    const listComments = vi.fn(async ({ page }: { page: number }) => ({
      data: pages[page - 1] ?? [],
    }));
    const octokit = { rest: { issues: { listComments } } };
    return { provider: new OctokitGithubProvider(octokit as never, logger), listComments };
  }

  it("returns every comment, not just GitHub's first default page", async () => {
    // The regression: checklist #2098 had 57 comments, callers scan for the
    // NEWEST marker comment, and an unpaginated read froze that search on the
    // issue's first 30 — handing back an 18-day-old QA board as current.
    const { provider } = providerWithPages([commentPage(1, 100), commentPage(101, 57)]);

    const comments = await provider.listComments("acme-internal", "mobile-app", 2098);

    expect(comments).toHaveLength(157);
    expect(comments.at(-1)?.id).toBe(157);
  });

  it("asks for 100 per page so a 57-comment issue is one request, not two", async () => {
    const { provider, listComments } = providerWithPages([commentPage(1, 57)]);

    await provider.listComments("acme-internal", "mobile-app", 2098);

    expect(listComments).toHaveBeenCalledTimes(1);
    expect(listComments).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 100, page: 1, issue_number: 2098 }),
    );
  });

  it("stops at the page cap and warns rather than truncating in silence", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { provider, listComments } = providerWithPages(
      Array.from({ length: 12 }, (_, p) => commentPage(p * 100 + 1, 100)),
    );

    const comments = await provider.listComments("acme-internal", "mobile-app", 2098);

    expect(listComments).toHaveBeenCalledTimes(10);
    expect(comments).toHaveLength(1000);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("hit the 10-page cap"),
      "OctokitGithubProvider",
    );
    warn.mockRestore();
  });
});
