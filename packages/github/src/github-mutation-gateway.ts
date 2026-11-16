import { PinoLoggerService } from "@lexi/logger";
import { GitHubProvider } from "./github-provider.interface";
import { describeProtectedWorkflowRefusal, isProtectedWorkflow } from "./protected-workflows";
import {
  MutationAuditEntry,
  MutationPolicy,
  MutationResult,
  WRITE_GATE_REASON,
  WriteGateBlockedError,
} from "./mutation-policy";
import {
  DeletedBranchDto,
  CodeSearchMatchDto,
  CreatedPullRequestDto,
  CreatePullRequestOptions,
  DispatchedWorkflowRun,
  ResolvedRefDto,
  GithubCommentDto,
  GithubCommitComparisonDto,
  GithubIssueDetailDto,
  GithubIssueDto,
  GithubPullRequestDto,
  GithubPullRequestReviewStatusDto,
  GithubRawIssue,
  GithubRawRelease,
  GithubTagDto,
  GithubTimelineEventDto,
  GithubTreeResult,
  GithubWorkflowArtifact,
  GithubWorkflowJobDto,
  GithubWorkflowRunDto,
  LinkedPullRequestDto,
  ListedPullRequestDto,
  ListBugHuntIssuesOptions,
  ListIssuesOptions,
  ListPullRequestsOptions,
  PullRequestFileDto,
  UpdatePullRequestBranchResult,
  MergedPullRequestDto,
  MergeIntoBranchOptions,
  MergeIntoBranchResult,
  MergePullRequestOptions,
  CreatedBranchDto,
  CreateBranchOptions,
  UpdateSubmodulePointerOptions,
  UpdatedSubmodulePointerDto,
} from "./types";

/**
 * Central gate for every GitHub mutation. Read paths delegate unchanged; writes
 * are refused when `writesEnabled` is false or `dryRun` is true.
 */
export class GitHubMutationGateway implements GitHubProvider {
  readonly dryRunAudit: MutationAuditEntry[] = [];

  constructor(
    private readonly inner: GitHubProvider,
    private readonly policy: MutationPolicy,
    private readonly logger: PinoLoggerService,
  ) {}

  async gateMutation<T>(action: string, operation: () => Promise<T>): Promise<MutationResult<T>> {
    if (!this.policy.writesEnabled || this.policy.dryRun) {
      const reason = this.policy.dryRun ? "GOVERNED_DRY_RUN=true" : WRITE_GATE_REASON;
      this.auditWouldDo(action, reason);
      return {
        executed: false,
        wouldExecute: true,
        action,
        reason,
      };
    }
    const result = await operation();
    return {
      executed: true,
      wouldExecute: false,
      action,
      result,
    };
  }

  private auditWouldDo(action: string, reason: string): void {
    const entry: MutationAuditEntry = {
      action,
      timestamp: new Date().toISOString(),
      reason,
      wouldExecute: true,
    };
    this.dryRunAudit.push(entry);
    this.logger.warn(`Would execute GitHub mutation: ${action} — ${reason}`, "GitHubMutationGateway");
  }

  private async mutateOrThrow<T>(action: string, operation: () => Promise<T>): Promise<T> {
    const gated = await this.gateMutation(action, operation);
    if (!gated.executed) {
      throw new WriteGateBlockedError(action, gated.reason ?? WRITE_GATE_REASON);
    }
    return gated.result as T;
  }

  listBugHuntIssues(options: ListBugHuntIssuesOptions): Promise<GithubIssueDto[]> {
    return this.inner.listBugHuntIssues(options);
  }

  listIssues(options: ListIssuesOptions): Promise<GithubIssueDto[]> {
    return this.inner.listIssues(options);
  }

  listIssuesUpdatedSince(
    owner: string,
    repo: string,
    since: string,
    perPage?: number,
    page?: number,
  ): Promise<GithubRawIssue[]> {
    return this.inner.listIssuesUpdatedSince(owner, repo, since, perPage, page);
  }

  listReleases(owner: string, repo: string, perPage?: number): Promise<GithubRawRelease[]> {
    return this.inner.listReleases(owner, repo, perPage);
  }

  publishSpec(owner: string, repo: string, input: Parameters<NonNullable<GitHubProvider["publishSpec"]>>[2]) {
    return this.mutateOrThrow("github.publishSpec", () => {
      if (!this.inner.publishSpec) throw new Error("Spec publishing is not wired.");
      return this.inner.publishSpec(owner, repo, input);
    });
  }

  getIssue(owner: string, repo: string, issueNumber: number): Promise<GithubIssueDto> {
    return this.inner.getIssue(owner, repo, issueNumber);
  }

  getPullRequest(owner: string, repo: string, pullNumber: number): Promise<GithubPullRequestDto> {
    return this.inner.getPullRequest(owner, repo, pullNumber);
  }

  /**
   * Read-only passthrough for PR review status.
   *
   * Not part of `GitHubProvider` — that is deliberate, and explained on
   * `OctokitGithubProvider.getReviewStatus`: only a couple of callers need it,
   * and putting it on the interface would force every test double to grow an
   * implementation. But this gateway wraps the concrete provider before
   * anything downstream sees it, so without a passthrough here the capability
   * is unreachable in production no matter that the provider implements it —
   * which is exactly how the stale-PR nudge ended up approximating
   * "unreviewed" as "still open".
   *
   * Returns `null`, never throws, when the wrapped provider does not implement
   * it. Callers must treat `null` as "review data unavailable" and degrade,
   * rather than assuming the PR is unreviewed.
   *
   * No write gate is consulted because there is no write: this reads reviews,
   * checks and mergeability, and the gateway has no way to act on them.
   */
  getReviewStatus(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<GithubPullRequestReviewStatusDto | null> {
    const inner = this.inner as Partial<{
      getReviewStatus(o: string, r: string, n: number): Promise<GithubPullRequestReviewStatusDto>;
    }>;
    if (typeof inner.getReviewStatus !== "function") return Promise.resolve(null);
    return inner.getReviewStatus(owner, repo, pullNumber);
  }

  /**
   * Read-only passthrough for listing pull requests. Same precedent as
   * `getReviewStatus`: not on `GitHubProvider`, null when the inner provider
   * cannot do it. No write gate — a dry-run deployment must still be able to
   * list PRs for triage.
   */
  listPullRequests(
    owner: string,
    repo: string,
    options?: ListPullRequestsOptions,
  ): Promise<ListedPullRequestDto[] | null> {
    const inner = this.inner as Partial<{
      listPullRequests(o: string, r: string, opts?: ListPullRequestsOptions): Promise<ListedPullRequestDto[]>;
    }>;
    if (typeof inner.listPullRequests !== "function") return Promise.resolve(null);
    return inner.listPullRequests(owner, repo, options);
  }

  /**
   * Read-only passthroughs for release tracing: "which tag did this issue's fix
   * ship in?" (for repositories with the `issues` role).
   *
   * All three follow the `getReviewStatus` precedent directly above, for the
   * same chokepoint reason: they are not on `GitHubProvider` — requiring them
   * there would force every test double to grow three implementations for a
   * capability one tool consumes — and this gateway wraps the concrete provider
   * before anything downstream sees it, so a provider method with no passthrough
   * here is unreachable in production however well it is implemented. That has
   * bitten this codebase more than once.
   *
   * Each returns `null`, never throws, when the wrapped provider does not
   * implement it. `null` means "could not look" and must never be coerced to an
   * empty result: an empty tag list from a provider that cannot list tags is
   * indistinguishable from a repository with no releases, and reading the first
   * as the second reports a shipped fix as unreleased.
   *
   * No write gate is consulted because there is no write — and that matters
   * beyond tidiness: a dry-run deployment (`GOVERNED_DRY_RUN=true`) must still be
   * able to answer where a fix shipped.
   */
  getIssueDetail(owner: string, repo: string, issueNumber: number): Promise<GithubIssueDetailDto | null> {
    const inner = this.inner as Partial<{
      getIssueDetail(o: string, r: string, n: number): Promise<GithubIssueDetailDto>;
    }>;
    if (typeof inner.getIssueDetail !== "function") return Promise.resolve(null);
    return inner.getIssueDetail(owner, repo, issueNumber);
  }

  listTags(owner: string, repo: string, maxTags?: number): Promise<GithubTagDto[] | null> {
    const inner = this.inner as Partial<{
      listTags(o: string, r: string, maxTags?: number): Promise<GithubTagDto[]>;
    }>;
    if (typeof inner.listTags !== "function") return Promise.resolve(null);
    return inner.listTags(owner, repo, maxTags);
  }

  compareCommits(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<GithubCommitComparisonDto | null> {
    const inner = this.inner as Partial<{
      compareCommits(o: string, r: string, b: string, h: string): Promise<GithubCommitComparisonDto | null>;
    }>;
    if (typeof inner.compareCommits !== "function") return Promise.resolve(null);
    return inner.compareCommits(owner, repo, base, head);
  }

  listComments(owner: string, repo: string, issueNumber: number): Promise<GithubCommentDto[]> {
    return this.inner.listComments(owner, repo, issueNumber);
  }

  listTimeline(owner: string, repo: string, issueNumber: number): Promise<GithubTimelineEventDto[]> {
    return this.inner.listTimeline(owner, repo, issueNumber);
  }

  listLinkedPullRequests(owner: string, repo: string, issueNumber: number): Promise<LinkedPullRequestDto[]> {
    return this.inner.listLinkedPullRequests(owner, repo, issueNumber);
  }

  createIssue(
    owner: string,
    repo: string,
    title: string,
    body: string,
    labels?: string[],
  ): Promise<GithubIssueDto> {
    return this.mutateOrThrow("github.createIssue", () => this.inner.createIssue(owner, repo, title, body, labels));
  }

  updateIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    patch: { title: string; body: string },
  ): Promise<GithubIssueDto> {
    if (typeof this.inner.updateIssue !== "function") {
      return Promise.reject(new Error("updateIssue is not available on this GitHub provider"));
    }
    return this.mutateOrThrow("github.updateIssue", () => this.inner.updateIssue!(owner, repo, issueNumber, patch));
  }

  addComment(owner: string, repo: string, issueNumber: number, body: string): Promise<GithubCommentDto> {
    return this.mutateOrThrow("github.addComment", () => this.inner.addComment(owner, repo, issueNumber, body));
  }

  updateComment(owner: string, repo: string, commentId: number, body: string): Promise<GithubCommentDto> {
    if (typeof this.inner.updateComment !== "function") {
      throw new Error("updateComment is not available on this GitHub provider");
    }
    return this.mutateOrThrow("github.updateComment", () =>
      this.inner.updateComment!(owner, repo, commentId, body),
    );
  }

  addSubIssue(
    owner: string,
    repo: string,
    parentIssueNumber: number,
    childIssueId: number,
  ): Promise<void> {
    const inner = this.inner as Partial<{
      addSubIssue(o: string, r: string, parent: number, childId: number): Promise<void>;
    }>;
    if (typeof inner.addSubIssue !== "function") {
      return Promise.reject(new Error("addSubIssue is not available on this GitHub provider"));
    }
    return this.mutateOrThrow("github.addSubIssue", () =>
      inner.addSubIssue!(owner, repo, parentIssueNumber, childIssueId),
    );
  }

  addIssueDependency(
    owner: string,
    repo: string,
    issueNumber: number,
    blockingIssueId: number,
  ): Promise<void> {
    const inner = this.inner as Partial<{
      addIssueDependency(o: string, r: string, n: number, blockingId: number): Promise<void>;
    }>;
    if (typeof inner.addIssueDependency !== "function") {
      return Promise.reject(new Error("addIssueDependency is not available on this GitHub provider"));
    }
    return this.mutateOrThrow("github.addIssueDependency", () =>
      inner.addIssueDependency!(owner, repo, issueNumber, blockingIssueId),
    );
  }

  async listSubIssues(owner: string, repo: string, parentIssueNumber: number): Promise<GithubIssueDto[]> {
    const inner = this.inner as Partial<{
      listSubIssues(o: string, r: string, parent: number): Promise<GithubIssueDto[]>;
    }>;
    if (typeof inner.listSubIssues !== "function") {
      return Promise.reject(new Error("listSubIssues is not available on this GitHub provider"));
    }
    return inner.listSubIssues(owner, repo, parentIssueNumber);
  }

  /**
   * Comments on a PULL REQUEST, for the close/reopen tools' notices.
   *
   * Not a second write path — it delegates to `addComment` directly above, so
   * there is still exactly one gated call to the provider and one audit action
   * name (`github.addComment`). GitHub itself makes no distinction: PR comments
   * are issue comments on the same number.
   *
   * It exists as a distinctly named method for a boundary reason. The rule
   * that the Slack layer never mutates GitHub directly is enforced textually
   * by `slack-boundary.spec.ts`, which forbids a raw
   * `.addComment(` anywhere under the Slack layer — the proxy for "the Slack
   * layer must not mutate GitHub directly". The governed close tool must post
   * its reason before closing, and it must do so through this gateway. Calling
   * it through a PR-specific name keeps that fence intact and literal for every
   * other file (including the tool's own, where a future raw `.addComment(`
   * should still fail) instead of carving out an exception that would blind the
   * whole file.
   */
  addPullRequestComment(
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
  ): Promise<GithubCommentDto> {
    return this.addComment(owner, repo, pullNumber, body);
  }

  setLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<string[]> {
    return this.mutateOrThrow("github.setLabels", () => this.inner.setLabels(owner, repo, issueNumber, labels));
  }

  addLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<string[]> {
    return this.mutateOrThrow("github.addLabels", () => this.inner.addLabels(owner, repo, issueNumber, labels));
  }

  removeLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void> {
    return this.mutateOrThrow("github.removeLabels", () => this.inner.removeLabels(owner, repo, issueNumber, labels));
  }

  assignUsers(owner: string, repo: string, issueNumber: number, assignees: string[]): Promise<string[]> {
    return this.mutateOrThrow("github.assignUsers", () => this.inner.assignUsers(owner, repo, issueNumber, assignees));
  }

  closeIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    reason?: "completed" | "not_planned",
  ): Promise<GithubIssueDto> {
    return this.mutateOrThrow("github.closeIssue", () => this.inner.closeIssue(owner, repo, issueNumber, reason));
  }

  reopenIssue(owner: string, repo: string, issueNumber: number): Promise<GithubIssueDto> {
    return this.mutateOrThrow("github.reopenIssue", () => this.inner.reopenIssue(owner, repo, issueNumber));
  }

  /**
   * Closing a PR is a write with a real external side effect (same
   * reasoning as `dispatchWorkflow` above), so — unlike the read-through
   * `searchCode` method below — it goes through the same
   * write gate as every other mutation in this file.
   */
  closePullRequest(owner: string, repo: string, pullNumber: number): Promise<GithubPullRequestDto> {
    return this.mutateOrThrow("github.closePullRequest", () => this.inner.closePullRequest(owner, repo, pullNumber));
  }

  /**
   * Reopening is a write with a real external side effect too — it makes a PR
   * live again and re-notifies its reviewers — so it passes the same write gate
   * as `closePullRequest` above. Note it is gated but NOT harder to reach: a
   * deployment that can close a PR can always undo it, because the alternative
   * (closing reachable, reopening not) is the asymmetry that made closing
   * dangerous in the first place.
   */
  /**
   * Editing a PR's title or body is a write with an external side effect — it
   * changes what reviewers read and re-runs the `pull_request: edited` checks —
   * so it passes the same write gate as close/reopen.
   */
  updatePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    changes: { title?: string; body?: string },
  ): Promise<GithubPullRequestDto> {
    return this.mutateOrThrow("github.updatePullRequest", () =>
      this.inner.updatePullRequest(owner, repo, pullNumber, changes),
    );
  }

  reopenPullRequest(owner: string, repo: string, pullNumber: number): Promise<GithubPullRequestDto> {
    return this.mutateOrThrow("github.reopenPullRequest", () => this.inner.reopenPullRequest(owner, repo, pullNumber));
  }

  /**
   * Updates a PR head with its base. A write with a visible side effect
   * (new commits on the head branch, CI re-runs) so it goes through the same
   * write gate as `closePullRequest`. Does not merge the PR.
   */
  updatePullRequestBranch(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<UpdatePullRequestBranchResult> {
    const inner = this.inner as Partial<{
      updatePullRequestBranch(o: string, r: string, n: number): Promise<UpdatePullRequestBranchResult>;
    }>;
    if (typeof inner.updatePullRequestBranch !== "function") {
      return Promise.reject(
        new Error(
          `The GitHub provider does not implement updatePullRequestBranch — cannot update ${owner}/${repo}#${pullNumber}.`,
        ),
      );
    }
    return this.mutateOrThrow("github.updatePullRequestBranch", () =>
      inner.updatePullRequestBranch!(owner, repo, pullNumber),
    );
  }

  /**
   * Appends a same-org `Fixes owner/repo#N` line to a PR body. Extra method,
   * not on `GitHubProvider`: only the shipped-fix tracker consumes it, and
   * requiring it on the interface would force every test double to grow an
   * implementation. No-ops when the wrapped provider does not implement it.
   */
  appendPullRequestClosingRef(
    owner: string,
    repo: string,
    pullNumber: number,
    issueRef: string,
  ): Promise<void> {
    const inner = this.inner as Partial<{
      appendPullRequestClosingRef(o: string, r: string, n: number, ref: string): Promise<void>;
    }>;
    if (typeof inner.appendPullRequestClosingRef !== "function") return Promise.resolve();
    return this.mutateOrThrow("github.appendPullRequestClosingRef", () =>
      inner.appendPullRequestClosingRef!(owner, repo, pullNumber, issueRef),
    );
  }

  /**
   * Whether `branch` currently exists on the remote. Read-only passthrough
   * following the `getReviewStatus` precedent directly above, for the same
   * chokepoint reason and with the same three-valued contract:
   *
   *   - `true`  — looked, the ref is there
   *   - `false` — looked, the ref is gone
   *   - `null`  — COULD NOT LOOK (the wrapped provider does not implement it)
   *
   * The three must not be collapsed. `reopen_pull_request` refuses when a PR's
   * head branch is deleted, and reading "could not look" as "deleted" would
   * make every recovery impossible on a provider that simply lacks the probe —
   * blocking the repair rather than the damage.
   *
   * Not on `GitHubProvider` deliberately: one tool consumes it, and requiring
   * it there would force every test double in the repo to grow an
   * implementation. No write gate is consulted because there is no write, which
   * matters beyond tidiness — a dry-run deployment must still be able to answer
   * whether a branch is still there.
   */
  branchExists(owner: string, repo: string, branch: string): Promise<boolean | null> {
    const inner = this.inner as Partial<{
      branchExists(o: string, r: string, b: string): Promise<boolean>;
    }>;
    if (typeof inner.branchExists !== "function") return Promise.resolve(null);
    return inner.branchExists(owner, repo, branch);
  }

  /**
   * Dispatch is a write with an external side effect (it triggers a GitHub
   * Actions run in another repo), so it goes through the same write gate as
   * every other mutation here.
   */
  dispatchWorkflow(
    owner: string,
    repo: string,
    workflowFile: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<void> {
    // Release and production pipelines ship code to users. Lexi opens branches
    // and pull requests; running one of these is a human act.
    //
    // Checked HERE rather than in each caller because this method is the single
    // choke point every dispatch passes through — the Slack tools, the
    // background services and the schedulers all arrive here. A
    // per-caller check is a list that goes stale the next time someone adds a
    // caller.
    //
    // Ahead of the write gate on purpose: a blocked workflow must be refused
    // even in a dry-run deployment, so the refusal is about the workflow rather
    // than about whether writes happen to be on.
    if (isProtectedWorkflow(workflowFile)) {
      return Promise.reject(new Error(describeProtectedWorkflowRefusal(workflowFile, owner, repo)));
    }
    return this.mutateOrThrow("github.dispatchWorkflow", () =>
      this.inner.dispatchWorkflow(owner, repo, workflowFile, ref, inputs),
    );
  }

  /** Read-through: correlating/inspecting a run has no side effects. */
  findDispatchedRun(
    owner: string,
    repo: string,
    workflowFile: string,
    since: Date,
    excludeRunIds?: readonly number[],
    nameContains?: string,
  ): Promise<DispatchedWorkflowRun | null> {
    return this.inner.findDispatchedRun(owner, repo, workflowFile, since, excludeRunIds, nameContains);
  }

  /** Read-through: listing a workflow's runs has no side effects. Null when the inner provider cannot. */
  async listWorkflowRuns(
    owner: string,
    repo: string,
    workflowFile: string,
    options?: { perPage?: number },
  ): Promise<GithubWorkflowRunDto[] | null> {
    const inner = this.inner as Partial<{
      listWorkflowRuns(o: string, r: string, w: string, opts?: { perPage?: number }): Promise<GithubWorkflowRunDto[]>;
    }>;
    if (typeof inner.listWorkflowRuns !== "function") return null;
    return inner.listWorkflowRuns(owner, repo, workflowFile, options);
  }

  /** Read-through: the repository's default branch. Null when unknown or unsupported. */
  async getDefaultBranch(owner: string, repo: string): Promise<string | null> {
    const inner = this.inner as Partial<{ getDefaultBranch(o: string, r: string): Promise<string | null> }>;
    if (typeof inner.getDefaultBranch !== "function") return null;
    return inner.getDefaultBranch(owner, repo);
  }

  /** Read-through: inspecting a run has no side effects. */
  async getWorkflowRun(
    owner: string,
    repo: string,
    runId: number,
    options?: { includeLogVerdict?: boolean },
  ): Promise<GithubWorkflowRunDto | null> {
    const inner = this.inner as Partial<{
      getWorkflowRun(
        o: string,
        r: string,
        id: number,
        opts?: { includeLogVerdict?: boolean },
      ): Promise<GithubWorkflowRunDto | null>;
    }>;
    if (typeof inner.getWorkflowRun !== "function") return null;
    return inner.getWorkflowRun(owner, repo, runId, options);
  }

  /** Read-through: minting a short-lived installation token has no GitHub side effects. */
  async getRepoAccessToken(owner: string, repo: string): Promise<string | null> {
    const inner = this.inner as Partial<{
      getRepoAccessToken(o: string, r: string): Promise<string | null>;
    }>;
    if (typeof inner.getRepoAccessToken !== "function") return null;
    return inner.getRepoAccessToken(owner, repo);
  }

  async renderGfmHtml(owner: string, repo: string, markdown: string): Promise<string | null> {
    const inner = this.inner as Partial<{
      renderGfmHtml(o: string, r: string, md: string): Promise<string | null>;
    }>;
    if (typeof inner.renderGfmHtml !== "function") return null;
    return inner.renderGfmHtml(owner, repo, markdown);
  }

  async getIssueHtml(owner: string, repo: string, issueNumber: number): Promise<string | null> {
    const inner = this.inner as Partial<{
      getIssueHtml(o: string, r: string, n: number): Promise<string | null>;
    }>;
    if (typeof inner.getIssueHtml !== "function") return null;
    return inner.getIssueHtml(owner, repo, issueNumber);
  }

  /** Read-through: a cross-installation issue read has no side effects. */
  async getIssueForRepo(owner: string, repo: string, issueNumber: number): Promise<GithubIssueDto> {
    const inner = this.inner as Partial<{
      getIssueForRepo(o: string, r: string, n: number): Promise<GithubIssueDto>;
    }>;
    if (typeof inner.getIssueForRepo !== "function") {
      throw new Error(
        `The GitHub provider does not implement getIssueForRepo — cannot read ${owner}/${repo}#${issueNumber} across installations.`,
      );
    }
    return inner.getIssueForRepo(owner, repo, issueNumber);
  }

  /** Read-through: searching code has no side effects. */
  searchCode(owner: string, repo: string, query: string, perPage?: number): Promise<CodeSearchMatchDto[]> {
    return this.inner.searchCode(owner, repo, query, perPage);
  }

  /** Read-through: reading a file's contents has no side effects. */
  getFileContents(owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
    return this.inner.getFileContents(owner, repo, path, ref);
  }

  /** Read-through: a large-file read has no side effects. */
  async getLargeFileContents(owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
    const inner = this.inner as Partial<{
      getLargeFileContents(o: string, r: string, p: string, ref?: string): Promise<string | null>;
    }>;
    if (typeof inner.getLargeFileContents !== "function") return null;
    return inner.getLargeFileContents(owner, repo, path, ref);
  }

  /** Read-through: reading a file's blob SHA has no side effects. */
  async getFileSha(owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
    const inner = this.inner as Partial<{
      getFileSha(o: string, r: string, p: string, ref?: string): Promise<string | null>;
    }>;
    if (typeof inner.getFileSha !== "function") return null;
    return inner.getFileSha(owner, repo, path, ref);
  }

  /**
   * Read-only, so it passes straight through the write gates.
   *
   * Rejects — rather than returning null — when the wrapped provider cannot
   * resolve refs at all. null already means "no such ref on this repo", and a
   * gateway that cannot look is a different fact entirely; collapsing the two
   * would have a caller report a branch as absent when nothing ever checked.
   */
  resolveRef(
    owner: string,
    repo: string,
    options?: { ref?: string; submodulePath?: string },
  ): Promise<ResolvedRefDto | null> {
    if (!this.inner.resolveRef) {
      return Promise.reject(new Error("The wrapped GitHub provider cannot resolve refs."));
    }
    return this.inner.resolveRef(owner, repo, options);
  }

  /** Read-through: enumerating a tree has no side effects. */
  getTree(owner: string, repo: string, path?: string, ref?: string): Promise<GithubTreeResult> {
    return this.inner.getTree(owner, repo, path, ref);
  }

  /** Read-through: reading a blob has no side effects. */
  getBlob(owner: string, repo: string, sha: string, maxBytes?: number): Promise<string | null> {
    return this.inner.getBlob(owner, repo, sha, maxBytes);
  }

  /** Read-through: listing run artifacts has no side effects. */
  listWorkflowRunArtifacts(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<GithubWorkflowArtifact[]> {
    return this.inner.listWorkflowRunArtifacts(owner, repo, runId);
  }

  /** Read-through: downloading an artifact zip has no side effects. */
  downloadWorkflowRunArtifact(owner: string, repo: string, artifactId: number): Promise<Buffer> {
    return this.inner.downloadWorkflowRunArtifact(owner, repo, artifactId);
  }

  /** Read-through: listing jobs has no side effects. */
  listWorkflowRunJobs(owner: string, repo: string, runId: number): Promise<GithubWorkflowJobDto[]> {
    return this.inner.listWorkflowRunJobs(owner, repo, runId);
  }

  /** Read-through: downloading job logs has no side effects. */
  downloadWorkflowJobLogs(owner: string, repo: string, jobId: number): Promise<string> {
    return this.inner.downloadWorkflowJobLogs(owner, repo, jobId);
  }

  /**
   * Cancel is a write with an external side effect (it stops a GitHub Actions
   * run), so it goes through the same write gate as `dispatchWorkflow`.
   */
  cancelWorkflowRun(owner: string, repo: string, runId: number): Promise<void> {
    return this.mutateOrThrow("github.cancelWorkflowRun", () =>
      this.inner.cancelWorkflowRun(owner, repo, runId),
    );
  }

  /** Read-through: reading a PR's changed files has no side effects. */
  getPullRequestFiles(owner: string, repo: string, pullNumber: number): Promise<PullRequestFileDto[]> {
    return this.inner.getPullRequestFiles(owner, repo, pullNumber);
  }

  /**
   * Read-only passthrough for a PR's changed files that can answer
   * UNAVAILABLE — same precedent as `getReviewStatus` above, for the same
   * chokepoint reason, plus one that matters more here.
   *
   * `getPullRequestFiles` is on `GitHubProvider`, so it already passes
   * through; its contract is "an array, or throw". The spec conformance
   * verifier needs a third answer. An empty array from a provider that cannot
   * read diffs is indistinguishable from a PR that genuinely changed no files,
   * and a verifier that reads the first as the second draws a conclusion over
   * code it never saw. So this keeps "I could not look" and "I looked and
   * found nothing" apart at the gateway, before any caller can conflate them:
   * `null` is the former, `[]` the latter.
   *
   * Returns `null`, never throws, when the wrapped provider does not implement
   * the read at all. Callers must treat `null` as "diff unavailable" and
   * degrade — never as evidence about the pull request.
   *
   * No write gate is consulted because there is no write. That is deliberate
   * and load-bearing: a dry-run deployment (`GOVERNED_DRY_RUN=true`) must still
   * be able to verify what shipped, and gating a read behind writes-enabled
   * would make conformance silently unverifiable exactly where it is safest
   * to run.
   */
  getPullRequestFilesOrNull(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<PullRequestFileDto[] | null> {
    const inner = this.inner as Partial<{
      getPullRequestFiles(o: string, r: string, n: number): Promise<PullRequestFileDto[]>;
    }>;
    if (typeof inner.getPullRequestFiles !== "function") return Promise.resolve(null);
    return inner.getPullRequestFiles(owner, repo, pullNumber);
  }

  /**
   * Opening a PR is a write with a real external side effect — same reasoning
   * as `closePullRequest` and `dispatchWorkflow` above — so it goes through
   * the same write gate as every other mutation in this file. Merge,
   * create-branch, and submodule-pointer updates are sibling writes below.
   */
  createPullRequest(
    owner: string,
    repo: string,
    options: CreatePullRequestOptions,
  ): Promise<CreatedPullRequestDto> {
    return this.mutateOrThrow("github.createPullRequest", () =>
      this.inner.createPullRequest(owner, repo, options),
    );
  }

  mergePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    options: MergePullRequestOptions = {},
  ): Promise<MergedPullRequestDto> {
    const inner = this.inner as Partial<{
      mergePullRequest(
        o: string,
        r: string,
        n: number,
        opts?: MergePullRequestOptions,
      ): Promise<MergedPullRequestDto>;
    }>;
    if (typeof inner.mergePullRequest !== "function") {
      return Promise.reject(
        new Error(`The GitHub provider does not implement mergePullRequest — cannot merge ${owner}/${repo}#${pullNumber}.`),
      );
    }
    return this.mutateOrThrow("github.mergePullRequest", () =>
      inner.mergePullRequest!(owner, repo, pullNumber, options),
    );
  }

  createBranch(owner: string, repo: string, options: CreateBranchOptions): Promise<CreatedBranchDto> {
    const inner = this.inner as Partial<{
      createBranch(o: string, r: string, opts: CreateBranchOptions): Promise<CreatedBranchDto>;
    }>;
    if (typeof inner.createBranch !== "function") {
      return Promise.reject(
        new Error(`The GitHub provider does not implement createBranch — cannot create ${owner}/${repo}:${options.name}.`),
      );
    }
    return this.mutateOrThrow("github.createBranch", () => inner.createBranch!(owner, repo, options));
  }

  deleteBranch(owner: string, repo: string, branch: string): Promise<DeletedBranchDto> {
    const inner = this.inner as Partial<{
      deleteBranch(o: string, r: string, b: string): Promise<DeletedBranchDto>;
    }>;
    if (typeof inner.deleteBranch !== "function") {
      return Promise.reject(
        new Error(`The GitHub provider does not implement deleteBranch — cannot delete ${owner}/${repo}:${branch}.`),
      );
    }
    return this.mutateOrThrow("github.deleteBranch", () => inner.deleteBranch!(owner, repo, branch));
  }

  mergeIntoBranch(owner: string, repo: string, options: MergeIntoBranchOptions): Promise<MergeIntoBranchResult> {
    const inner = this.inner as Partial<{
      mergeIntoBranch(o: string, r: string, opts: MergeIntoBranchOptions): Promise<MergeIntoBranchResult>;
    }>;
    if (typeof inner.mergeIntoBranch !== "function") {
      return Promise.reject(
        new Error(
          `The GitHub provider does not implement mergeIntoBranch — cannot merge into ${owner}/${repo}:${options.base}.`,
        ),
      );
    }
    return this.mutateOrThrow("github.mergeIntoBranch", () => inner.mergeIntoBranch!(owner, repo, options));
  }

  updateSubmodulePointer(
    owner: string,
    repo: string,
    options: UpdateSubmodulePointerOptions,
  ): Promise<UpdatedSubmodulePointerDto> {
    const inner = this.inner as Partial<{
      updateSubmodulePointer(
        o: string,
        r: string,
        opts: UpdateSubmodulePointerOptions,
      ): Promise<UpdatedSubmodulePointerDto>;
    }>;
    if (typeof inner.updateSubmodulePointer !== "function") {
      return Promise.reject(
        new Error(
          `The GitHub provider does not implement updateSubmodulePointer — cannot update ${options.path} on ${owner}/${repo}.`,
        ),
      );
    }
    return this.mutateOrThrow("github.updateSubmodulePointer", () =>
      inner.updateSubmodulePointer!(owner, repo, options),
    );
  }

  /** Orchestrator helper — gated write with access to the inner provider. */
  runWrite<T>(action: string, operation: (provider: GitHubProvider) => Promise<T>): Promise<MutationResult<T>> {
    return this.gateMutation(action, () => operation(this.inner));
  }
}
