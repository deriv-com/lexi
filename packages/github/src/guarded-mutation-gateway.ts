/**
 * Guarded GitHub Mutation Gateway — Phase 1.1 enforcement boundary.
 *
 * Every destructive GitHub mutation passes through this gateway:
 *   1. Re-fetch current issue state (never trust stale data)
 *   2. Evaluate MutationGuard (never-touch + action class + authorization)
 *   3. Global write gate check
 *   4. Execute or block with full audit record
 *
 * Constructive actions (comments, label additions) use lighter policy
 * but still pass action classification and budgets.
 *
 * Fail-closed: if guard evaluation fails, mutation is blocked.
 */

import { PinoLoggerService } from "@lexi/logger";
import { GitHubProvider } from "./github-provider.interface";
import {
  MutationAuditEntry,
  MutationPolicy,
  MutationResult,
  WRITE_GATE_REASON,
  WriteGateBlockedError,
} from "./mutation-policy";
import {
  CodeSearchMatchDto,
  CreatedPullRequestDto,
  CreatePullRequestOptions,
  DispatchedWorkflowRun,
  ResolvedRefDto,
  GithubCommentDto,
  GithubIssueDto,
  GithubPullRequestDto,
  GithubRawIssue,
  GithubRawRelease,
  GithubTimelineEventDto,
  GithubTreeResult,
  GithubWorkflowArtifact,
  GithubWorkflowJobDto,
  GithubWorkflowRunDto,
  LinkedPullRequestDto,
  ListBugHuntIssuesOptions,
  ListIssuesOptions,
  PullRequestFileDto,
} from "./types";

// ---- Guard interfaces (decoupled from @lexi/governance to avoid circular deps) ----

export interface GuardIssueState {
  labels: string[];
  priority?: string;
  severity?: string;
  hasRecentHumanActivity: boolean;
  hasOpenLinkedPR: boolean;
  isExplicitlyAssigned: boolean;
  hasActiveEngineeringWork: boolean;
  state: "open" | "closed";
}

export interface GuardDecision {
  allowed: boolean;
  actionClass: string;
  matchedRules: string[];
  requiredApproval?: string;
  reason: string;
  policyVersion: string;
}

export interface MutationGuardEvaluator {
  evaluate(input: {
    action: string;
    actorId: string;
    actorIsHuman: boolean;
    currentIssueState: GuardIssueState;
    writesEnabled: boolean;
  }): GuardDecision;
}

export interface IssueStateResolver {
  /**
   * Resolve current issue state from local DB.
   * Used for constructive actions where DB-state is sufficient.
   */
  resolveCurrentState(owner: string, repo: string, issueNumber: number): Promise<GuardIssueState | null>;
  /**
   * Resolve current issue state by refreshing protection signals from GitHub.
   * Used for DESTRUCTIVE actions to catch changes made after last sync:
   * - newly added keep-open/security labels
   * - recent human comments or reactions
   * - newly linked/open PRs
   * - changed priority/severity/assignment
   *
   * Merges local DB state with live GitHub signals.
   * If GitHub refresh fails, returns null (caller must fail-closed).
   */
  resolveCurrentStateWithRefresh?(owner: string, repo: string, issueNumber: number): Promise<GuardIssueState | null>;
}

export interface GuardedMutationAuditEntry extends MutationAuditEntry {
  issueNumber?: number;
  guardDecision?: GuardDecision;
  currentState?: GuardIssueState;
  actorId?: string;
}

export interface GuardedGatewayOptions {
  /** Actor performing mutations (system/scheduler/agent user) */
  actorId: string;
  /** Whether the actor is a human (affects override permissions) */
  actorIsHuman: boolean;
}

/**
 * Production mutation gateway with MutationGuard enforcement.
 *
 * Every destructive mutation:
 *   1. Resolves current issue state (fresh from DB/GitHub)
 *   2. Evaluates the MutationGuard (never-touch, action class, policy)
 *   3. Checks the global write gate
 *   4. Executes or blocks
 *   5. Creates an audit record regardless of outcome
 *
 * If state resolution fails → mutation blocked (fail-closed).
 * If guard evaluation throws → mutation blocked (fail-closed).
 * Prohibited actions are NEVER overridable.
 */
export class GuardedMutationGateway implements GitHubProvider {
  readonly auditLog: GuardedMutationAuditEntry[] = [];

  constructor(
    private readonly inner: GitHubProvider,
    private readonly policy: MutationPolicy,
    private readonly guard: MutationGuardEvaluator,
    private readonly stateResolver: IssueStateResolver,
    private readonly logger: PinoLoggerService,
    private readonly options: GuardedGatewayOptions = { actorId: "system", actorIsHuman: false },
  ) {}

  // ---- Read-through (no guard needed) ----

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
  async publishSpec(owner: string, repo: string, input: Parameters<NonNullable<GitHubProvider["publishSpec"]>>[2]) {
    const result = await this.runWrite("github.publishSpec", provider => {
      if (!provider.publishSpec) throw new Error("Spec publishing is not wired.");
      return provider.publishSpec(owner, repo, input);
    });
    if (!result.executed || !result.result) throw new WriteGateBlockedError("github.publishSpec", result.reason ?? WRITE_GATE_REASON);
    return result.result;
  }

  getIssue(owner: string, repo: string, issueNumber: number): Promise<GithubIssueDto> {
    return this.inner.getIssue(owner, repo, issueNumber);
  }
  getPullRequest(owner: string, repo: string, pullNumber: number): Promise<GithubPullRequestDto> {
    return this.inner.getPullRequest(owner, repo, pullNumber);
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
  async listSubIssues(owner: string, repo: string, parentIssueNumber: number): Promise<GithubIssueDto[]> {
    const inner = this.inner as Partial<{
      listSubIssues(o: string, r: string, parent: number): Promise<GithubIssueDto[]>;
    }>;
    if (typeof inner.listSubIssues !== "function") {
      throw new Error("listSubIssues is not available on this GitHub provider");
    }
    return inner.listSubIssues(owner, repo, parentIssueNumber);
  }
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
    if (typeof inner.getWorkflowRun !== "function") {
      return null;
    }
    return inner.getWorkflowRun(owner, repo, runId, options);
  }
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
  searchCode(owner: string, repo: string, query: string, perPage?: number): Promise<CodeSearchMatchDto[]> {
    return this.inner.searchCode(owner, repo, query, perPage);
  }
  getFileContents(owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
    return this.inner.getFileContents(owner, repo, path, ref);
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

  getTree(owner: string, repo: string, path?: string, ref?: string): Promise<GithubTreeResult> {
    return this.inner.getTree(owner, repo, path, ref);
  }
  getBlob(owner: string, repo: string, sha: string, maxBytes?: number): Promise<string | null> {
    return this.inner.getBlob(owner, repo, sha, maxBytes);
  }
  listWorkflowRunArtifacts(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<GithubWorkflowArtifact[]> {
    return this.inner.listWorkflowRunArtifacts(owner, repo, runId);
  }
  downloadWorkflowRunArtifact(owner: string, repo: string, artifactId: number): Promise<Buffer> {
    return this.inner.downloadWorkflowRunArtifact(owner, repo, artifactId);
  }
  listWorkflowRunJobs(owner: string, repo: string, runId: number): Promise<GithubWorkflowJobDto[]> {
    return this.inner.listWorkflowRunJobs(owner, repo, runId);
  }
  downloadWorkflowJobLogs(owner: string, repo: string, jobId: number): Promise<string> {
    return this.inner.downloadWorkflowJobLogs(owner, repo, jobId);
  }
  getPullRequestFiles(owner: string, repo: string, pullNumber: number): Promise<PullRequestFileDto[]> {
    return this.inner.getPullRequestFiles(owner, repo, pullNumber);
  }

  /**
   * Read-through, like `dispatchWorkflow` above: this gateway's guard
   * machinery (`executeGuarded`/`GuardIssueState`) is issue-centric — it
   * re-reads state via `getIssue` and evaluates issue "never-touch"/label
   * rules. A PR being closed by the stale-PR chase sweep isn't the same
   * entity as the GitHub *issue* that shares its number, so routing it
   * through that guard would apply issue semantics to a PR by coincidence
   * of numbering rather than by design. Authorization for auto-closing a
   * stale quick-fix PR belongs to the caller (the sweep's own age/cap
   * checks), not this issue-guard boundary.
   */
  closePullRequest(owner: string, repo: string, pullNumber: number): Promise<GithubPullRequestDto> {
    return this.inner.closePullRequest(owner, repo, pullNumber);
  }

  /**
   * Read-through for exactly the same reason as `closePullRequest` above: this
   * gateway's guard is issue-centric, and a pull request is not the issue that
   * happens to share its number. Applying issue never-touch/label rules to a PR
   * by coincidence of numbering would imply a protection that is not really
   * being applied.
   *
   * Authorization for reopening belongs to the caller — the governed
   * `reopen_pull_request` tool, which does its own fresh read and refuses on
   * merged, already-open, and deleted-head-branch before reaching here.
   */
  /**
   * Read-through for the same reason as `closePullRequest`: this gateway's
   * guard is issue-centric, and a pull request is not the issue that happens to
   * share its number. Authorization belongs to the governed
   * `update_pull_request` tool, which re-reads the PR and refuses on merged or
   * closed before reaching here.
   */
  updatePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    changes: { title?: string; body?: string },
  ): Promise<GithubPullRequestDto> {
    return this.inner.updatePullRequest(owner, repo, pullNumber, changes);
  }

  reopenPullRequest(owner: string, repo: string, pullNumber: number): Promise<GithubPullRequestDto> {
    return this.inner.reopenPullRequest(owner, repo, pullNumber);
  }

  /**
   * Same as `closePullRequest`: this gateway's guard is issue-centric, and a
   * PR body edit has no issue number that would make never-touch rules
   * meaningful. The write gate on `GitHubMutationGateway` still applies.
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
    return inner.appendPullRequestClosingRef(owner, repo, pullNumber, issueRef);
  }

  /**
   * Read-through for the same reason as `closePullRequest` above: this
   * gateway's guard is issue-centric (it re-reads issue state and evaluates
   * label/never-touch rules keyed on an issue number), and opening a PR has
   * no issue number to resolve — `CreatePullRequestOptions` carries branches,
   * not an issue. Routing it through `executeGuarded` with `issueNumber:
   * undefined` would run the guard against a synthetic empty issue state,
   * which decides nothing useful while implying a protection that isn't
   * really being applied.
   *
   * The write gate itself is not skipped: `GitHubMutationGateway` gates
   * `github.createPullRequest`, and eligibility for opening a PR (does this
   * thread warrant one, has a branch been pushed) belongs to the calling
   * workflow. Merge, create-branch, and submodule-pointer updates pass
   * through the inner write-gated gateway the same way, without the
   * issue-centric guard — none of them has an issue number to resolve.
   */
  createPullRequest(
    owner: string,
    repo: string,
    options: CreatePullRequestOptions,
  ): Promise<CreatedPullRequestDto> {
    return this.inner.createPullRequest(owner, repo, options);
  }

  mergePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    options?: { sha?: string; commitTitle?: string; commitMessage?: string },
  ): Promise<{ merged: boolean; sha: string | null; message: string }> {
    const inner = this.inner as Partial<{
      mergePullRequest(
        o: string,
        r: string,
        n: number,
        opts?: { sha?: string; commitTitle?: string; commitMessage?: string },
      ): Promise<{ merged: boolean; sha: string | null; message: string }>;
    }>;
    if (typeof inner.mergePullRequest !== "function") {
      return Promise.reject(new Error("mergePullRequest is not available on this GitHub provider"));
    }
    return inner.mergePullRequest(owner, repo, pullNumber, options);
  }

  createBranch(
    owner: string,
    repo: string,
    options: { name: string; from?: string },
  ): Promise<{ name: string; sha: string; url: string }> {
    const inner = this.inner as Partial<{
      createBranch(o: string, r: string, opts: { name: string; from?: string }): Promise<{ name: string; sha: string; url: string }>;
    }>;
    if (typeof inner.createBranch !== "function") {
      return Promise.reject(new Error("createBranch is not available on this GitHub provider"));
    }
    return inner.createBranch(owner, repo, options);
  }

  mergeIntoBranch(
    owner: string,
    repo: string,
    options: { base: string; head: string; commitMessage?: string },
  ): Promise<{ merged: boolean; alreadyUpToDate: boolean; conflict: boolean; sha: string | null; message: string }> {
    const inner = this.inner as Partial<{
      mergeIntoBranch(
        o: string,
        r: string,
        opts: { base: string; head: string; commitMessage?: string },
      ): Promise<{ merged: boolean; alreadyUpToDate: boolean; conflict: boolean; sha: string | null; message: string }>;
    }>;
    if (typeof inner.mergeIntoBranch !== "function") {
      return Promise.reject(new Error("mergeIntoBranch is not available on this GitHub provider"));
    }
    return inner.mergeIntoBranch(owner, repo, options);
  }

  updateSubmodulePointer(
    owner: string,
    repo: string,
    options: { branch: string; path: string; sha: string; commitMessage: string },
  ): Promise<{ path: string; sha: string; commitSha: string; branch: string }> {
    const inner = this.inner as Partial<{
      updateSubmodulePointer(
        o: string,
        r: string,
        opts: { branch: string; path: string; sha: string; commitMessage: string },
      ): Promise<{ path: string; sha: string; commitSha: string; branch: string }>;
    }>;
    if (typeof inner.updateSubmodulePointer !== "function") {
      return Promise.reject(new Error("updateSubmodulePointer is not available on this GitHub provider"));
    }
    return inner.updateSubmodulePointer(owner, repo, options);
  }

  // ---- External workflow dispatch (no issue-state guard applies — this
  //      targets an Actions workflow in another repo, not a local issue.
  //      Authorization/eligibility for triggering it is enforced upstream by
  //      the governed tool, not this issue-centric gateway) ----

  dispatchWorkflow(
    owner: string,
    repo: string,
    workflowFile: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<void> {
    return this.inner.dispatchWorkflow(owner, repo, workflowFile, ref, inputs);
  }

  cancelWorkflowRun(owner: string, repo: string, runId: number): Promise<void> {
    return this.inner.cancelWorkflowRun(owner, repo, runId);
  }

  // ---- Constructive mutations (lighter guard — classification + budget only) ----

  async createIssue(owner: string, repo: string, title: string, body: string, labels?: string[]): Promise<GithubIssueDto> {
    return this.executeGuarded("issue.create", owner, repo, undefined, () =>
      this.inner.createIssue(owner, repo, title, body, labels),
    );
  }

  async updateIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    patch: { title: string; body: string },
  ): Promise<GithubIssueDto> {
    if (typeof this.inner.updateIssue !== "function") {
      throw new Error("updateIssue is not available on this GitHub provider");
    }
    return this.executeGuarded("issue.update", owner, repo, issueNumber, () =>
      this.inner.updateIssue!(owner, repo, issueNumber, patch),
    );
  }

  async addComment(owner: string, repo: string, issueNumber: number, body: string): Promise<GithubCommentDto> {
    return this.executeGuarded("comment.add", owner, repo, issueNumber, () =>
      this.inner.addComment(owner, repo, issueNumber, body),
    );
  }

  /**
   * Guarded as `comment.add` on purpose, following `addSubIssue` above: editing
   * a comment we already wrote is the same trust class as writing it, and a
   * brand-new verb here would be one the guard has never been taught, which is
   * how a capability ends up advertised but unrouted.
   *
   * `issueNumber` is undefined because a comment id does not carry one; the
   * guard's issue-state checks are skipped, which is correct — the target is our
   * own comment, not the issue's lifecycle.
   */
  async updateComment(owner: string, repo: string, commentId: number, body: string): Promise<GithubCommentDto> {
    if (typeof this.inner.updateComment !== "function") {
      throw new Error("updateComment is not available on this GitHub provider");
    }
    return this.executeGuarded("comment.add", owner, repo, undefined, () =>
      this.inner.updateComment!(owner, repo, commentId, body),
    );
  }

  async addSubIssue(
    owner: string,
    repo: string,
    parentIssueNumber: number,
    childIssueId: number,
  ): Promise<void> {
    const inner = this.inner as Partial<{
      addSubIssue(o: string, r: string, parent: number, childId: number): Promise<void>;
    }>;
    if (typeof inner.addSubIssue !== "function") {
      throw new Error("addSubIssue is not available on this GitHub provider");
    }
    return this.executeGuarded("comment.add", owner, repo, parentIssueNumber, () =>
      inner.addSubIssue!(owner, repo, parentIssueNumber, childIssueId),
    );
  }

  /**
   * Guarded as `comment.add`, following `addSubIssue` directly above and for
   * the reason given on `updateComment`: a brand-new verb here would be one the
   * guard has never been taught, which is how a capability ends up advertised
   * but unrouted. A dependency is the same trust class as a sub-issue link —
   * it annotates the relationship graph, changes no issue's state, and GitHub
   * exposes a DELETE for it.
   */
  async addIssueDependency(
    owner: string,
    repo: string,
    issueNumber: number,
    blockingIssueId: number,
  ): Promise<void> {
    const inner = this.inner as Partial<{
      addIssueDependency(o: string, r: string, n: number, blockingId: number): Promise<void>;
    }>;
    if (typeof inner.addIssueDependency !== "function") {
      throw new Error("addIssueDependency is not available on this GitHub provider");
    }
    return this.executeGuarded("comment.add", owner, repo, issueNumber, () =>
      inner.addIssueDependency!(owner, repo, issueNumber, blockingIssueId),
    );
  }

  async addLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<string[]> {
    return this.executeGuarded("label.add", owner, repo, issueNumber, () =>
      this.inner.addLabels(owner, repo, issueNumber, labels),
    );
  }

  // ---- Destructive mutations (full guard: state re-read + never-touch + policy) ----

  async setLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<string[]> {
    return this.executeGuarded("label.set", owner, repo, issueNumber, () =>
      this.inner.setLabels(owner, repo, issueNumber, labels),
    );
  }

  async removeLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void> {
    return this.executeGuarded("label.remove", owner, repo, issueNumber, () =>
      this.inner.removeLabels(owner, repo, issueNumber, labels),
    );
  }

  async assignUsers(owner: string, repo: string, issueNumber: number, assignees: string[]): Promise<string[]> {
    return this.executeGuarded("assign", owner, repo, issueNumber, () =>
      this.inner.assignUsers(owner, repo, issueNumber, assignees),
    );
  }

  async closeIssue(owner: string, repo: string, issueNumber: number, reason?: "completed" | "not_planned"): Promise<GithubIssueDto> {
    const action = reason === "not_planned" ? "close.not_observed" : "close.fixed";
    return this.executeGuarded(action, owner, repo, issueNumber, () =>
      this.inner.closeIssue(owner, repo, issueNumber, reason),
    );
  }

  async reopenIssue(owner: string, repo: string, issueNumber: number): Promise<GithubIssueDto> {
    return this.executeGuarded("reopen", owner, repo, issueNumber, () =>
      this.inner.reopenIssue(owner, repo, issueNumber),
    );
  }

  // ---- Orchestrator helper (backward-compatible with GitHubMutationGateway.runWrite) ----

  async runWrite<T>(action: string, operation: (provider: GitHubProvider) => Promise<T>, issueNumber?: number, owner?: string, repo?: string): Promise<MutationResult<T>> {
    try {
      // For runWrite, we need to guard if we have issue context
      if (issueNumber && owner && repo) {
        const result = await this.executeGuardedResult(action, owner, repo, issueNumber, () => operation(this.inner));
        return result;
      }

      // No issue context — fall back to write-gate only
      if (!this.policy.writesEnabled || this.policy.dryRun) {
        const reason = this.policy.dryRun ? "GOVERNED_DRY_RUN=true" : WRITE_GATE_REASON;
        this.recordAudit(action, undefined, reason, false, undefined, undefined);
        return { executed: false, wouldExecute: true, action, reason };
      }

      const result = await operation(this.inner);
      this.recordAudit(action, undefined, "executed", true, undefined, undefined);
      return { executed: true, wouldExecute: false, action, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.recordAudit(action, undefined, `error: ${msg}`, false, undefined, undefined);
      throw err;
    }
  }

  // ---- Core enforcement logic ----

  private async executeGuarded<T>(
    action: string,
    owner: string,
    repo: string,
    issueNumber: number | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = await this.executeGuardedResult(action, owner, repo, issueNumber, operation);
    if (!result.executed) {
      throw new WriteGateBlockedError(action, result.reason ?? "Mutation guard blocked");
    }
    return result.result as T;
  }

  private async executeGuardedResult<T>(
    action: string,
    owner: string,
    repo: string,
    issueNumber: number | undefined,
    operation: () => Promise<T>,
  ): Promise<MutationResult<T>> {
    // Step 1: Resolve current issue state (fail-closed on failure)
    let currentState: GuardIssueState | null = null;
    if (issueNumber) {
      try {
        // For destructive actions, refresh from GitHub to catch post-sync changes
        if (this.isDestructiveAction(action) && this.stateResolver.resolveCurrentStateWithRefresh) {
          currentState = await this.stateResolver.resolveCurrentStateWithRefresh(owner, repo, issueNumber);
        } else {
          currentState = await this.stateResolver.resolveCurrentState(owner, repo, issueNumber);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        const reason = `Failed to resolve current issue state for #${issueNumber}: ${msg}. Blocking mutation (fail-closed).`;
        this.recordAudit(action, issueNumber, reason, false, undefined, undefined);
        return { executed: false, wouldExecute: false, action, reason };
      }

      if (!currentState) {
        const reason = `Issue #${issueNumber} not found. Cannot verify current state — blocking mutation (fail-closed).`;
        this.recordAudit(action, issueNumber, reason, false, undefined, undefined);
        return { executed: false, wouldExecute: false, action, reason };
      }
    }

    // Step 2: Evaluate MutationGuard
    let guardDecision: GuardDecision;
    try {
      guardDecision = this.guard.evaluate({
        action,
        actorId: this.options.actorId,
        actorIsHuman: this.options.actorIsHuman,
        currentIssueState: currentState ?? {
          labels: [], state: "open",
          hasRecentHumanActivity: false, hasOpenLinkedPR: false,
          isExplicitlyAssigned: false, hasActiveEngineeringWork: false,
        },
        writesEnabled: this.policy.writesEnabled,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      const reason = `MutationGuard evaluation failed: ${msg}. Blocking mutation (fail-closed).`;
      this.recordAudit(action, issueNumber, reason, false, undefined, currentState ?? undefined);
      return { executed: false, wouldExecute: false, action, reason };
    }

    // Step 3: Enforce guard decision
    if (!guardDecision.allowed) {
      this.recordAudit(action, issueNumber, guardDecision.reason, false, guardDecision, currentState ?? undefined);
      return {
        executed: false,
        wouldExecute: guardDecision.reason.includes("write gate") || guardDecision.reason.includes("WRITES_ENABLED"),
        action,
        reason: guardDecision.reason,
      };
    }

    // Step 4: Final write gate check (defense in depth — guard already checks this, but belt + suspenders)
    if (!this.policy.writesEnabled || this.policy.dryRun) {
      const reason = this.policy.dryRun ? "GOVERNED_DRY_RUN=true" : WRITE_GATE_REASON;
      this.recordAudit(action, issueNumber, reason, false, guardDecision, currentState ?? undefined);
      return { executed: false, wouldExecute: true, action, reason };
    }

    // Step 5: Execute
    try {
      const result = await operation();
      this.recordAudit(action, issueNumber, "executed", true, guardDecision, currentState ?? undefined);
      return { executed: true, wouldExecute: false, action, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.recordAudit(action, issueNumber, `execution_error: ${msg}`, false, guardDecision, currentState ?? undefined);
      throw err;
    }
  }

  private recordAudit(
    action: string,
    issueNumber: number | undefined,
    reason: string,
    executed: boolean,
    guardDecision: GuardDecision | undefined,
    currentState: GuardIssueState | undefined,
  ): void {
    const entry: GuardedMutationAuditEntry = {
      action,
      timestamp: new Date().toISOString(),
      reason,
      wouldExecute: !executed && (reason.includes("WRITES_ENABLED") || reason.includes("DRY_RUN")),
      issueNumber,
      guardDecision,
      currentState,
      actorId: this.options.actorId,
    };
    this.auditLog.push(entry);

    if (executed) {
      this.logger.log(`Mutation executed: ${action} #${issueNumber ?? "?"}`, "GuardedMutationGateway");
    } else {
      this.logger.warn(`Mutation blocked: ${action} #${issueNumber ?? "?"} — ${reason}`, "GuardedMutationGateway");
    }
  }

  /**
   * Destructive actions require fresh GitHub state refresh.
   * Constructive actions (comments, label additions) use local DB state only.
   */
  private isDestructiveAction(action: string): boolean {
    const destructive = [
      "close.", "reopen", "label.remove", "label.set",
      "assign", "priority.lower", "severity.lower",
      "ownership.remove", "bulk_close", "security.mutate",
      "close.direct_ai", "merge",
    ];
    return destructive.some((prefix) => action.startsWith(prefix) || action === prefix);
  }
}
