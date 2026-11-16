import { describe, it, expect, vi, beforeEach } from "vitest";
import { PinoLoggerService } from "@lexi/logger";
import { GitHubMutationGateway } from "./github-mutation-gateway";
import type { GitHubProvider } from "./github-provider.interface";
import { WriteGateBlockedError } from "./mutation-policy";

function makeInner(): GitHubProvider {
  return {
    listBugHuntIssues: vi.fn(),
    listIssues: vi.fn(),
    listIssuesUpdatedSince: vi.fn().mockResolvedValue([]),
    listReleases: vi.fn().mockResolvedValue([]),
    createIssue: vi.fn(),
    getIssue: vi.fn(),
    getPullRequest: vi.fn(),
    listComments: vi.fn(),
    addComment: vi.fn().mockResolvedValue({ id: 1, authorLogin: "bot", body: "c", createdAt: "now" }),
    listTimeline: vi.fn(),
    listLinkedPullRequests: vi.fn(),
    setLabels: vi.fn().mockResolvedValue(["bug"]),
    addLabels: vi.fn().mockResolvedValue(["bug"]),
    removeLabels: vi.fn().mockResolvedValue(undefined),
    assignUsers: vi.fn().mockResolvedValue(["alice"]),
    closeIssue: vi.fn().mockResolvedValue({
      githubIssueId: 1,
      githubNumber: 42,
      repoOwner: "o",
      repoName: "r",
      title: "t",
      body: null,
      url: "u",
      authorLogin: null,
      labels: [],
      state: "closed",
      stateReason: "completed",
      assignees: [],
      githubCreatedAt: "now",
      githubUpdatedAt: "now",
    }),
    reopenIssue: vi.fn(),
    closePullRequest: vi.fn().mockResolvedValue({ number: 42, state: "closed", merged: false, mergedAt: null, url: "u" }),
    reopenPullRequest: vi.fn().mockResolvedValue({ number: 42, state: "open", merged: false, mergedAt: null, url: "u" }),
    updatePullRequest: vi.fn().mockResolvedValue({ number: 42, state: "open", merged: false, mergedAt: null, url: "u" }),
    dispatchWorkflow: vi.fn().mockResolvedValue(undefined),
    findDispatchedRun: vi.fn().mockResolvedValue(null),
    searchCode: vi.fn().mockResolvedValue([]),
    getFileContents: vi.fn().mockResolvedValue("file contents"),
    getTree: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
    getBlob: vi.fn().mockResolvedValue("blob text"),
    listWorkflowRunArtifacts: vi.fn().mockResolvedValue([]),
    downloadWorkflowRunArtifact: vi.fn().mockResolvedValue(Buffer.from("PK")),
    listWorkflowRunJobs: vi.fn().mockResolvedValue([]),
    downloadWorkflowJobLogs: vi.fn().mockResolvedValue(""),
    cancelWorkflowRun: vi.fn().mockResolvedValue(undefined),
    getPullRequestFiles: vi.fn().mockResolvedValue([]),
    createPullRequest: vi.fn().mockResolvedValue({
      number: 7,
      state: "open",
      merged: false,
      mergedAt: null,
      url: "https://github.com/o/r/pull/7",
      draft: false,
    }),
  };
}

describe("GitHubMutationGateway", () => {
  let inner: GitHubProvider;
  let logger: PinoLoggerService;

  beforeEach(() => {
    inner = makeInner();
    logger = new PinoLoggerService({ level: "silent" });
  });

  it("blocks closeIssue when writes are disabled", async () => {
    const gateway = new GitHubMutationGateway(inner, { writesEnabled: false, dryRun: false }, logger);
    const result = await gateway.gateMutation("github.closeIssue", () =>
      inner.closeIssue("o", "r", 42),
    );
    expect(result.executed).toBe(false);
    expect(result.wouldExecute).toBe(true);
    expect(inner.closeIssue).not.toHaveBeenCalled();
    expect(gateway.dryRunAudit).toHaveLength(1);
  });

  it("executes closeIssue when writes are enabled", async () => {
    const gateway = new GitHubMutationGateway(inner, { writesEnabled: true, dryRun: false }, logger);
    const result = await gateway.runWrite("github.closeIssue", (g) => g.closeIssue("o", "r", 42, "not_planned"));
    expect(result.executed).toBe(true);
    expect(inner.closeIssue).toHaveBeenCalled();
  });

  it("throws WriteGateBlockedError from GitHubProvider.closeIssue when blocked", async () => {
    const gateway = new GitHubMutationGateway(inner, { writesEnabled: false, dryRun: false }, logger);
    await expect(gateway.closeIssue("o", "r", 42)).rejects.toBeInstanceOf(WriteGateBlockedError);
  });

  it("blocks comments, labels, and assignments when writes disabled", async () => {
    const gateway = new GitHubMutationGateway(inner, { writesEnabled: false, dryRun: false }, logger);
    const comment = await gateway.gateMutation("github.addComment", () =>
      inner.addComment("o", "r", 1, "hi"),
    );
    const labels = await gateway.gateMutation("github.setLabels", () =>
      inner.setLabels("o", "r", 1, ["bug"]),
    );
    const assign = await gateway.gateMutation("github.assignUsers", () =>
      inner.assignUsers("o", "r", 1, ["alice"]),
    );
    expect(comment.executed).toBe(false);
    expect(labels.executed).toBe(false);
    expect(assign.executed).toBe(false);
    expect(gateway.dryRunAudit).toHaveLength(3);
  });

  it("blocks createPullRequest when writes are disabled", async () => {
    const gateway = new GitHubMutationGateway(inner, { writesEnabled: false, dryRun: false }, logger);
    await expect(
      gateway.createPullRequest("o", "r", { title: "t", head: "fix/x", base: "main" }),
    ).rejects.toBeInstanceOf(WriteGateBlockedError);
    expect(inner.createPullRequest).not.toHaveBeenCalled();
    expect(gateway.dryRunAudit).toEqual([expect.objectContaining({ action: "github.createPullRequest" })]);
  });

  it("blocks cancelWorkflowRun when writes are disabled", async () => {
    const gateway = new GitHubMutationGateway(inner, { writesEnabled: false, dryRun: false }, logger);
    await expect(gateway.cancelWorkflowRun("o", "r", 55)).rejects.toBeInstanceOf(WriteGateBlockedError);
    expect(inner.cancelWorkflowRun).not.toHaveBeenCalled();
  });

  it("forwards cancelWorkflowRun when writes are enabled", async () => {
    const gateway = new GitHubMutationGateway(inner, { writesEnabled: true, dryRun: false }, logger);
    await expect(gateway.cancelWorkflowRun("o", "r", 55)).resolves.toBeUndefined();
    expect(inner.cancelWorkflowRun).toHaveBeenCalledWith("o", "r", 55);
  });

  it("blocks createPullRequest in dry-run mode even when writes are enabled", async () => {
    const gateway = new GitHubMutationGateway(inner, { writesEnabled: true, dryRun: true }, logger);
    await expect(
      gateway.createPullRequest("o", "r", { title: "t", head: "fix/x", base: "main" }),
    ).rejects.toBeInstanceOf(WriteGateBlockedError);
    expect(inner.createPullRequest).not.toHaveBeenCalled();
  });

  it("blocks addSubIssue when writes are disabled", async () => {
    const withSub = Object.assign(inner, { addSubIssue: vi.fn().mockResolvedValue(undefined) });
    const gateway = new GitHubMutationGateway(withSub, { writesEnabled: false, dryRun: false }, logger);
    await expect(gateway.addSubIssue("o", "r", 2098, 1)).rejects.toBeInstanceOf(WriteGateBlockedError);
    expect(withSub.addSubIssue).not.toHaveBeenCalled();
  });

  it("executes createPullRequest when writes are enabled, passing options through unchanged", async () => {
    const gateway = new GitHubMutationGateway(inner, { writesEnabled: true, dryRun: false }, logger);
    const options = { title: "t", head: "fix/x", base: "main", body: "b", draft: true };

    const result = await gateway.createPullRequest("o", "r", options);

    expect(inner.createPullRequest).toHaveBeenCalledWith("o", "r", options);
    expect(result.number).toBe(7);
  });

  it("passes the read-only file/PR-diff methods straight through, even with writes disabled", async () => {
    const gateway = new GitHubMutationGateway(inner, { writesEnabled: false, dryRun: true }, logger);

    await expect(gateway.getFileContents("o", "r", "src/a.ts", "main")).resolves.toBe("file contents");
    await expect(gateway.getTree("o", "r", "src", "main")).resolves.toEqual({ entries: [], truncated: false });
    await expect(gateway.getBlob("o", "r", "abc")).resolves.toBe("blob text");
    await expect(gateway.listWorkflowRunArtifacts("o", "r", 55)).resolves.toEqual([]);
    await expect(gateway.downloadWorkflowRunArtifact("o", "r", 9)).resolves.toEqual(Buffer.from("PK"));
    await expect(gateway.listWorkflowRunJobs("o", "r", 55)).resolves.toEqual([]);
    await expect(gateway.downloadWorkflowJobLogs("o", "r", 9)).resolves.toBe("");
    await expect(gateway.getPullRequestFiles("o", "r", 7)).resolves.toEqual([]);

    expect(inner.getFileContents).toHaveBeenCalledWith("o", "r", "src/a.ts", "main");
    expect(inner.getTree).toHaveBeenCalledWith("o", "r", "src", "main");
    // The 4th argument is the optional per-call decode cap, forwarded as
    // given: the gateway must not silently drop it, or a caller asking for a
    // large document would get the conservative default back.
    expect(inner.getBlob).toHaveBeenCalledWith("o", "r", "abc", undefined);
    expect(inner.listWorkflowRunArtifacts).toHaveBeenCalledWith("o", "r", 55);
    expect(inner.downloadWorkflowRunArtifact).toHaveBeenCalledWith("o", "r", 9);
    expect(inner.listWorkflowRunJobs).toHaveBeenCalledWith("o", "r", 55);
    expect(inner.downloadWorkflowJobLogs).toHaveBeenCalledWith("o", "r", 9);
    expect(inner.getPullRequestFiles).toHaveBeenCalledWith("o", "r", 7);
    // Reads must never be audited as would-be mutations.
    expect(gateway.dryRunAudit).toHaveLength(0);
  });

  it("blocks mergePullRequest when writes are disabled", async () => {
    const merge = vi.fn();
    const withMerge = Object.assign(makeInner(), { mergePullRequest: merge });
    const gateway = new GitHubMutationGateway(withMerge, { writesEnabled: false, dryRun: false }, logger);
    await expect(gateway.mergePullRequest("o", "r", 7, { sha: "abc" })).rejects.toThrow(/GOVERNED_(WRITES_ENABLED|DRY_RUN)/);
    expect(merge).not.toHaveBeenCalled();
  });

  it("forwards mergePullRequest when writes are enabled", async () => {
    const merge = vi.fn().mockResolvedValue({ merged: true, sha: "abc", message: "ok" });
    const withMerge = Object.assign(makeInner(), { mergePullRequest: merge });
    const gateway = new GitHubMutationGateway(withMerge, { writesEnabled: true, dryRun: false }, logger);
    await expect(gateway.mergePullRequest("o", "r", 7, { sha: "abc" })).resolves.toEqual({
      merged: true,
      sha: "abc",
      message: "ok",
    });
    expect(merge).toHaveBeenCalledWith("o", "r", 7, { sha: "abc" });
  });

  it("blocks createBranch when writes are disabled", async () => {
    const create = vi.fn();
    const withCreate = Object.assign(makeInner(), { createBranch: create });
    const gateway = new GitHubMutationGateway(withCreate, { writesEnabled: false, dryRun: true }, logger);
    await expect(gateway.createBranch("o", "r", { name: "release/x" })).rejects.toThrow(/GOVERNED_(WRITES_ENABLED|DRY_RUN)/);
    expect(create).not.toHaveBeenCalled();
  });

  it("blocks deleteBranch when writes are disabled", async () => {
    const del = vi.fn();
    const withDelete = Object.assign(makeInner(), { deleteBranch: del });
    const gateway = new GitHubMutationGateway(withDelete, { writesEnabled: false, dryRun: true }, logger);
    await expect(gateway.deleteBranch("o", "r", "judy/spike")).rejects.toThrow(/GOVERNED_(WRITES_ENABLED|DRY_RUN)/);
    expect(del).not.toHaveBeenCalled();
  });

  /**
   * The passthrough itself, for the reason the getReviewStatus block below
   * gives: this gateway is what the governed tools actually hold, so a method
   * missing here makes the capability unreachable in production no matter how
   * well the provider implements it. `delete_branch` checks
   * `typeof provider.deleteBranch === "function"` and refuses when it is not,
   * so without this passthrough the tool would have shipped permanently
   * answering "the provider cannot delete a branch in this deployment".
   */
  it("passes deleteBranch through to the provider when writes are enabled", async () => {
    const del = vi.fn().mockResolvedValue({ name: "judy/spike", sha: "a".repeat(40) });
    const withDelete = Object.assign(makeInner(), { deleteBranch: del });
    const gateway = new GitHubMutationGateway(withDelete, { writesEnabled: true, dryRun: false }, logger);

    await expect(gateway.deleteBranch("o", "r", "judy/spike")).resolves.toEqual({
      name: "judy/spike",
      sha: "a".repeat(40),
    });
    expect(del).toHaveBeenCalledWith("o", "r", "judy/spike");
  });

  /**
   * This gateway wraps the concrete provider before anything downstream sees
   * it. Without a passthrough the review-status capability is unreachable in
   * production however well the provider implements it — which is how the
   * stale-PR nudge ended up guessing at "unreviewed" for so long.
   */
  describe("getReviewStatus passthrough", () => {
    const status = {
      number: 7,
      url: "https://github.com/o/r/pull/7",
      state: "open" as const,
      draft: false,
      reviews: [],
      checks: [],
      mergeable: true,
      requestedReviewers: ["alice"],
      requestedTeams: [],
    };

    it("forwards to the wrapped provider even with writes disabled", async () => {
      const withReviews = Object.assign(makeInner(), {
        getReviewStatus: vi.fn().mockResolvedValue(status),
      });
      const gateway = new GitHubMutationGateway(withReviews, { writesEnabled: false, dryRun: true }, logger);

      await expect(gateway.getReviewStatus("o", "r", 7)).resolves.toEqual(status);
      expect(withReviews.getReviewStatus).toHaveBeenCalledWith("o", "r", 7);
      // A read is not a would-be mutation.
      expect(gateway.dryRunAudit).toHaveLength(0);
    });

    it("returns null instead of throwing when the provider cannot do it", async () => {
      const gateway = new GitHubMutationGateway(inner, { writesEnabled: true, dryRun: false }, logger);
      await expect(gateway.getReviewStatus("o", "r", 7)).resolves.toBeNull();
    });
  });

  describe("listPullRequests passthrough", () => {
    it("forwards even with writes disabled", async () => {
      const listed = [{ number: 1, title: "oldest", url: "u", state: "open" as const, draft: false, authorLogin: "a", createdAt: "t", updatedAt: "t", headRef: "h", baseRef: "main" }];
      const withList = Object.assign(makeInner(), {
        listPullRequests: vi.fn().mockResolvedValue(listed),
      });
      const gateway = new GitHubMutationGateway(withList, { writesEnabled: false, dryRun: true }, logger);

      await expect(gateway.listPullRequests("o", "r", { direction: "asc" })).resolves.toEqual(listed);
      expect(gateway.dryRunAudit).toHaveLength(0);
    });

    it("returns null when the provider cannot list", async () => {
      const gateway = new GitHubMutationGateway(inner, { writesEnabled: true, dryRun: false }, logger);
      await expect(gateway.listPullRequests("o", "r")).resolves.toBeNull();
    });
  });

  describe("updatePullRequestBranch write gate", () => {
    it("refuses when writes are disabled", async () => {
      const update = vi.fn();
      const withUpdate = Object.assign(makeInner(), { updatePullRequestBranch: update });
      const gateway = new GitHubMutationGateway(withUpdate, { writesEnabled: false, dryRun: true }, logger);

      await expect(gateway.updatePullRequestBranch("o", "r", 7)).rejects.toThrow(/GOVERNED_(WRITES_ENABLED|DRY_RUN)/);
      expect(update).not.toHaveBeenCalled();
    });

    it("forwards when writes are enabled", async () => {
      const update = vi.fn().mockResolvedValue({ updated: true, message: "ok" });
      const withUpdate = Object.assign(makeInner(), { updatePullRequestBranch: update });
      const gateway = new GitHubMutationGateway(withUpdate, { writesEnabled: true, dryRun: false }, logger);

      await expect(gateway.updatePullRequestBranch("o", "r", 7)).resolves.toEqual({ updated: true, message: "ok" });
      expect(update).toHaveBeenCalledWith("o", "r", 7);
    });
  });

  /**
   * The spec-conformance exit gate reads a PR's diff through this chokepoint to build the
   * artefact the spec verifier judges. Same precedent as `getReviewStatus`
   * directly above, for the same reason and with one addition that matters
   * more here than there.
   *
   * `getPullRequestFiles` is on `GitHubProvider`, so it already has a
   * passthrough — but its contract is "an array, or throw". The verifier needs
   * a third answer: UNAVAILABLE. An empty array from a provider that cannot
   * read diffs is indistinguishable from a PR that genuinely changed no files,
   * and a verifier that reads the first as the second concludes "nothing
   * changed" over code it never saw. So the null-returning sibling exists to
   * keep those two apart at the chokepoint, before any caller can conflate
   * them.
   */
  describe("getPullRequestFilesOrNull passthrough", () => {
    const files = [
      { filename: "src/withdrawal/amount.tsx", status: "modified", additions: 12, deletions: 3, changes: 15, patch: "@@ -1 +1 @@" },
    ];

    it("forwards to the wrapped provider even with writes disabled and dry-run on", async () => {
      // A dry-run deployment must still be able to verify what shipped. This
      // is a read: no write gate, no audit entry, no writesEnabled requirement.
      const withFiles = Object.assign(makeInner(), {
        getPullRequestFiles: vi.fn().mockResolvedValue(files),
      });
      const gateway = new GitHubMutationGateway(withFiles, { writesEnabled: false, dryRun: true }, logger);

      await expect(gateway.getPullRequestFilesOrNull("o", "r", 7)).resolves.toEqual(files);
      expect(withFiles.getPullRequestFiles).toHaveBeenCalledWith("o", "r", 7);
      expect(gateway.dryRunAudit).toHaveLength(0);
    });

    it("returns null instead of throwing when the provider cannot do it", async () => {
      const withoutFiles = makeInner() as unknown as Record<string, unknown>;
      delete withoutFiles.getPullRequestFiles;
      const gateway = new GitHubMutationGateway(
        withoutFiles as unknown as GitHubProvider,
        { writesEnabled: true, dryRun: false },
        logger,
      );

      await expect(gateway.getPullRequestFilesOrNull("o", "r", 7)).resolves.toBeNull();
    });

    it("distinguishes a provider that cannot read diffs from a PR that changed nothing", async () => {
      // The whole reason this method returns `| null`. Both of these would be
      // `[]` through the interface-typed method, and the verifier must not read
      // "I could not look" as "I looked and found nothing".
      const empty = Object.assign(makeInner(), { getPullRequestFiles: vi.fn().mockResolvedValue([]) });
      const missing = makeInner() as unknown as Record<string, unknown>;
      delete missing.getPullRequestFiles;

      const emptyGateway = new GitHubMutationGateway(empty, { writesEnabled: true, dryRun: false }, logger);
      const missingGateway = new GitHubMutationGateway(
        missing as unknown as GitHubProvider,
        { writesEnabled: true, dryRun: false },
        logger,
      );

      await expect(emptyGateway.getPullRequestFilesOrNull("o", "r", 7)).resolves.toEqual([]);
      await expect(missingGateway.getPullRequestFilesOrNull("o", "r", 7)).resolves.toBeNull();
    });
  });

  /**
   * The three reads `get_issue_fix_version` needs, all following the
   * `getReviewStatus` precedent directly above: not on `GitHubProvider` (so no
   * test double has to grow an implementation), passed through here (so the
   * capability is reachable in production at all), never write-gated (they are
   * reads), and `null` rather than a throw when the wrapped provider cannot do
   * it.
   *
   * The null contract carries weight here specifically. An empty tag list from
   * a provider that cannot list tags is indistinguishable from a repository
   * with no releases, and a resolver that read the first as the second would
   * report a shipped fix as unreleased.
   */
  describe("issue fix-version read passthroughs", () => {
    const issueDetail = {
      number: 1878,
      title: "Onboarding: fix phone number validation for St. Lucia (NANP territories)",
      state: "closed" as const,
      labels: ["bug", "bug-confirmed"],
      milestone: null,
      closedAt: "2026-08-11T02:43:50Z",
      url: "https://github.com/acme-internal/mobile-app/issues/1878",
    };
    const tags = [{ name: "v1.16.0", commitSha: "e957b8a14a7ee730306caf72beba9703f7d08eee" }];
    const comparison = { status: "ahead", aheadBy: 73, behindBy: 0 };

    it("forwards getIssueDetail even with writes disabled and dry-run on", async () => {
      const withDetail = Object.assign(makeInner(), {
        getIssueDetail: vi.fn().mockResolvedValue(issueDetail),
      });
      const gateway = new GitHubMutationGateway(withDetail, { writesEnabled: false, dryRun: true }, logger);

      await expect(gateway.getIssueDetail("acme-internal", "mobile-app", 1878)).resolves.toEqual(
        issueDetail,
      );
      expect(withDetail.getIssueDetail).toHaveBeenCalledWith("acme-internal", "mobile-app", 1878);
      expect(gateway.dryRunAudit).toHaveLength(0);
    });

    it("forwards listTags and compareCommits, unwritten and ungated", async () => {
      const withTags = Object.assign(makeInner(), {
        listTags: vi.fn().mockResolvedValue(tags),
        compareCommits: vi.fn().mockResolvedValue(comparison),
      });
      const gateway = new GitHubMutationGateway(withTags, { writesEnabled: false, dryRun: true }, logger);

      await expect(gateway.listTags("o", "r")).resolves.toEqual(tags);
      await expect(gateway.compareCommits("o", "r", "sha", "v1.16.0")).resolves.toEqual(comparison);
      expect(withTags.compareCommits).toHaveBeenCalledWith("o", "r", "sha", "v1.16.0");
      expect(gateway.dryRunAudit).toHaveLength(0);
    });

    it("returns null rather than throwing when the provider implements none of them", async () => {
      const gateway = new GitHubMutationGateway(inner, { writesEnabled: true, dryRun: false }, logger);

      await expect(gateway.getIssueDetail("o", "r", 1)).resolves.toBeNull();
      await expect(gateway.listTags("o", "r")).resolves.toBeNull();
      await expect(gateway.compareCommits("o", "r", "a", "b")).resolves.toBeNull();
    });

    it("keeps 'no tags' apart from 'cannot list tags'", async () => {
      // Both would be `[]` if the passthrough coerced. A repository with no
      // tags means a merged fix is genuinely unreleased; a provider that
      // cannot list tags means nothing at all is known about the release.
      const noTags = Object.assign(makeInner(), { listTags: vi.fn().mockResolvedValue([]) });
      const cannot = new GitHubMutationGateway(inner, { writesEnabled: true, dryRun: false }, logger);
      const empty = new GitHubMutationGateway(noTags, { writesEnabled: true, dryRun: false }, logger);

      await expect(empty.listTags("o", "r")).resolves.toEqual([]);
      await expect(cannot.listTags("o", "r")).resolves.toBeNull();
    });
  });
});

describe("GitHubMutationGateway.resolveRef", () => {
  const logger = new PinoLoggerService({ level: "silent" });

  it("passes a read straight through, with writes disabled", async () => {
    const inner = makeInner();
    inner.resolveRef = vi.fn().mockResolvedValue({
      requested: "main",
      sha: "1111111111111111111111111111111111111111",
      kind: "branch",
    });
    const gateway = new GitHubMutationGateway(inner, { writesEnabled: false, dryRun: false }, logger);

    await expect(gateway.resolveRef("acme-internal", "mobile-app", { ref: "main" })).resolves.toMatchObject({
      sha: "1111111111111111111111111111111111111111",
      kind: "branch",
    });
    expect(inner.resolveRef).toHaveBeenCalledWith("acme-internal", "mobile-app", { ref: "main" });
  });

  it("forwards a genuine not-found as null", async () => {
    const inner = makeInner();
    inner.resolveRef = vi.fn().mockResolvedValue(null);
    const gateway = new GitHubMutationGateway(inner, { writesEnabled: true, dryRun: false }, logger);

    await expect(gateway.resolveRef("acme-internal", "mobile-app", { ref: "nope" })).resolves.toBeNull();
  });

  // null already means "no such ref". A provider that cannot resolve refs at
  // all is a different fact, and returning null for it would have the caller
  // report a branch as absent when nothing ever looked.
  it("rejects rather than reporting not-found when the inner provider cannot resolve refs", async () => {
    const inner = makeInner();
    delete (inner as { resolveRef?: unknown }).resolveRef;
    const gateway = new GitHubMutationGateway(inner, { writesEnabled: true, dryRun: false }, logger);

    await expect(gateway.resolveRef("acme-internal", "mobile-app", { ref: "main" })).rejects.toThrow(
      /cannot resolve refs/i,
    );
  });
});
