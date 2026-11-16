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

export interface GitHubProvider {
  listBugHuntIssues(options: ListBugHuntIssuesOptions): Promise<GithubIssueDto[]>;
  listIssues(options: ListIssuesOptions): Promise<GithubIssueDto[]>;
  /**
   * Issues (and PRs — the caller filters them) updated at or after `since`, in
   * ascending update order. Returns the raw GitHub payload so the corpus
   * synchroniser keeps its verbatim indexing and watermark contract.
   */
  listIssuesUpdatedSince(
    owner: string,
    repo: string,
    since: string,
    perPage?: number,
    page?: number,
  ): Promise<GithubRawIssue[]>;
  /** Most recent releases, newest first. Raw payload — the caller maps it. */
  listReleases(owner: string, repo: string, perPage?: number): Promise<GithubRawRelease[]>;
  createIssue(
    owner: string,
    repo: string,
    title: string,
    body: string,
    labels?: string[],
  ): Promise<GithubIssueDto>;
  /**
   * Replaces an issue's title and body without changing its state. Optional so
   * focused test doubles do not pretend to support a write they never use.
   */
  updateIssue?(
    owner: string,
    repo: string,
    issueNumber: number,
    patch: { title: string; body: string },
  ): Promise<GithubIssueDto>;
  publishSpec?(owner: string, repo: string, input: {
    branch: string; base: string; path: string; body: string; title: string;
    expectedHead?: string;
  }): Promise<{ number: number; head: string; url: string }>;
  getIssue(owner: string, repo: string, issueNumber: number): Promise<GithubIssueDto>;
  getPullRequest(owner: string, repo: string, pullNumber: number): Promise<GithubPullRequestDto>;
  listComments(owner: string, repo: string, issueNumber: number): Promise<GithubCommentDto[]>;
  addComment(owner: string, repo: string, issueNumber: number, body: string): Promise<GithubCommentDto>;
  /**
   * Rewrites one comment in place. Lets a repeating sweep keep a single living
   * board comment instead of appending one per pass. Optional: providers and
   * test doubles that cannot edit omit it, and callers fall back to
   * `addComment`.
   */
  updateComment?(owner: string, repo: string, commentId: number, body: string): Promise<GithubCommentDto>;
  /**
   * Makes `childIssueId` (GitHub's numeric issue id, not the number) a
   * sub-issue of `parentIssueNumber`. Used to put a merged fix onto a
   * release-candidate checklist issue. Optional on the interface because
   * older test doubles only implement the methods they exercise; callers
   * that need this must refuse when it is absent rather than invent a
   * comment-only stand-in.
   *
   * Idempotent: a child that is already on the parent is success, not an
   * error.
   */
  addSubIssue?(
    owner: string,
    repo: string,
    parentIssueNumber: number,
    childIssueId: number,
  ): Promise<void>;
  /**
   * Records that `issueNumber` is blocked by the issue with `blockingIssueId`
   * — GitHub's issue-dependency relationship, the sibling of sub-issues in the
   * same Relationships panel.
   *
   * Only `blocked_by` is writable on GitHub's side; `blocking` is the inverse
   * view of it. So "A blocks B" is written as B blocked_by A, and a caller
   * holding the sentence the other way round must flip it.
   *
   * Takes the blocking issue's numeric **id**, not its number, matching
   * `addSubIssue`. Optional for the same reason: test doubles implement only
   * what they exercise. Idempotent — an existing dependency is success.
   */
  addIssueDependency?(
    owner: string,
    repo: string,
    issueNumber: number,
    blockingIssueId: number,
  ): Promise<void>;
  /**
   * Lists GitHub sub-issues of a parent (the mobile RC **tag** — a checklist
   * issue such as #2098, not a git tag). Optional because older test doubles
   * only implement the methods they exercise. Callers refuse
   * rather than inventing a body-parse stand-in when this is absent.
   *
   * Empty array means the parent has no children — not an error.
   */
  listSubIssues?(owner: string, repo: string, parentIssueNumber: number): Promise<GithubIssueDto[]>;
  listTimeline(owner: string, repo: string, issueNumber: number): Promise<GithubTimelineEventDto[]>;
  listLinkedPullRequests(owner: string, repo: string, issueNumber: number): Promise<LinkedPullRequestDto[]>;

  /** Ensures exactly the given labels are present, adding/removing as needed. */
  setLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<string[]>;
  addLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<string[]>;
  removeLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void>;

  /** Ensures exactly the given assignees are set (idempotent replace). */
  assignUsers(owner: string, repo: string, issueNumber: number, assignees: string[]): Promise<string[]>;

  closeIssue(owner: string, repo: string, issueNumber: number, reason?: "completed" | "not_planned"): Promise<GithubIssueDto>;
  reopenIssue(owner: string, repo: string, issueNumber: number): Promise<GithubIssueDto>;

  /**
   * Appends `Fixes owner/repo#N` to a PR body when that closing keyword is
   * missing. Optional on the interface because some test doubles and older
   * wrappers only implement the read/write methods they exercise; the
   * confirmed-bug ship path no-ops when this is absent.
   */
  appendPullRequestClosingRef?(
    owner: string,
    repo: string,
    pullNumber: number,
    issueRef: string,
  ): Promise<void>;

  /**
   * Closes a pull request without merging it (`state: "closed"`). Used by
   * the stale-PR chase sweep to auto-close an unreviewed quick-fix PR — the
   * underlying issue/thread this PR was meant to resolve is left untouched;
   * only the PR itself moves to `closed`. Does not merge, does not touch
   * labels or comments; the caller is responsible for posting its own notice
   * of why the PR was closed.
   */
  closePullRequest(owner: string, repo: string, pullNumber: number): Promise<GithubPullRequestDto>;

  /**
   * Reopens a closed pull request (`state: "open"`). The recovery counterpart
   * to `closePullRequest`, and the reason closing is no longer a one-way door:
   * a close that can be undone is a different kind of action from one that
   * cannot.
   *
   * Two things GitHub will refuse, which a caller must check rather than
   * discover: a MERGED pull request cannot be reopened at all (its state is
   * "closed", so `merged` is the only field that distinguishes it), and a PR
   * whose head branch has been deleted is rejected on reopen — a common
   * situation immediately after a close, since deleting the branch is the
   * usual next step. Neither is inferable from `state`.
   *
   * Does not merge, does not restore a deleted branch, and does not touch
   * labels or comments; as with `closePullRequest`, the caller is responsible
   * for posting its own notice of why the PR was reopened.
   */
  reopenPullRequest(owner: string, repo: string, pullNumber: number): Promise<GithubPullRequestDto>;

  /**
   * Rewrites an existing pull request's title and/or body.
   *
   * Added because there was no way to correct one. `create_pull_request` opens
   * a PR with whatever body it was given, and `check-description` on
   * mobile-app is a literal match on the heading `## Description` — so
   * a body that misses it fails, and the only remedy was a human pasting the
   * corrected text by hand.
   *
   * Deliberately narrow: title and body only. State changes are
   * `closePullRequest` / `reopenPullRequest`, and base/head are not editable
   * here because retargeting a PR silently changes what it would merge.
   */
  updatePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    changes: { title?: string; body?: string },
  ): Promise<GithubPullRequestDto>;

  /**
   * Triggers a `workflow_dispatch` run of `workflowFile` (e.g. "direct-fix.yml")
   * on `ref`, passing `inputs` as the workflow's dispatch inputs. The GitHub
   * API returns 204 with no run id on success — call `findDispatchedRun`
   * afterwards to correlate the resulting run. `ref` is intentionally a
   * required parameter rather than a hardcoded "main": the caller owns
   * knowing (or looking up) the target repo's default branch.
   */
  dispatchWorkflow(
    owner: string,
    repo: string,
    workflowFile: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<void>;

  /**
   * Finds the `workflow_dispatch` run of `workflowFile` that (best-effort)
   * corresponds to a dispatch made at `since`. A polling primitive, not a
   * wait-loop: returns `null` (never rejects for "not found yet") when no
   * matching run exists so the caller can retry on its own schedule.
   *
   * `excludeRunIds` — pass the run IDs already correlated to *other*
   * in-flight attempts against this same repo/workflow, so two dispatches
   * close together in time cannot both resolve to the same run. See
   * `DispatchedWorkflowRun`'s docstring for why this exists and what it
   * does and doesn't guarantee.
   *
   * `nameContains` — when set, only runs whose GitHub `name` /
   * `display_title` includes that token (e.g. a QA run's `bill_id` `ISSUE-N`)
   * are candidates. Timing-only matching swaps ids when two qa-mobile.yml
   * dispatches land seconds apart; the workflow names each run after the bill.
   */
  findDispatchedRun(
    owner: string,
    repo: string,
    workflowFile: string,
    since: Date,
    excludeRunIds?: readonly number[],
    nameContains?: string,
  ): Promise<DispatchedWorkflowRun | null>;

  /**
   * Reads one Actions run by id, including conclusion. Optional: the QA caller
   * degrades to PENDING when this is absent rather than treating a missing
   * method as a product FAIL. `logVerdict` is parsed from job logs when the
   * workflow prints `verdict=PASS|FAIL|INFRA|NEEDS_REVIEW`.
   *
   * Returns null — never throws — when the run is not visible (404).
   */
  getWorkflowRun?(
    owner: string,
    repo: string,
    runId: number,
    options?: { includeLogVerdict?: boolean },
  ): Promise<GithubWorkflowRunDto | null>;

  /**
   * Installation (or PAT) token scoped to `owner/repo`. The QA caller uses this to
   * GET private `github.com/user-attachments/assets/…` URLs — unauthenticated
   * GETs 404, which is not an expired signed URL. Callers must not log the
   * value. Returns null when no credential is available.
   */
  getRepoAccessToken?(owner: string, repo: string): Promise<string | null>;

  /**
   * Renders GFM in `owner/repo` context so private issue images become
   * signed `private-user-images.githubusercontent.com` URLs. `github.com/user-attachments`
   * is cookie-gated and ignores API tokens.
   */
  renderGfmHtml?(owner: string, repo: string, markdown: string): Promise<string | null>;

  /**
   * Issue body HTML (`mediaType: full` / GraphQL `bodyHTML`). Markdown `body`
   * is not enough — it still has cookie-gated user-attachments URLs.
   */
  getIssueHtml?(owner: string, repo: string, issueNumber: number): Promise<string | null>;

  /**
   * Issue read that mints a per-repo installation client. `getIssue`
   * now does the same, so this exists for callers that must fail loudly when a
   * provider cannot read across installations at all: it is optional, so test
   * doubles and older providers stay valid, and callers must treat "not
   * implemented" as unreadable, never as empty.
   */
  getIssueForRepo?(owner: string, repo: string, issueNumber: number): Promise<GithubIssueDto>;

  /**
   * Searches file contents within a single repository (GitHub's code search,
   * scoped with `repo:owner/name`). Read-only, backed by the same
   * Contents:Read permission every installation already has — this lets a
   * caller check what the code actually does today (e.g. "does this screen
   * already support X") instead of asking a human to describe it. Returns an
   * empty array on no matches; never throws for "nothing found".
   */
  searchCode(owner: string, repo: string, query: string, perPage?: number): Promise<CodeSearchMatchDto[]>;

  /**
   * Reads one file's decoded text content at `path`, optionally at `ref` (a
   * branch, tag, or commit SHA; defaults to the repo's default branch).
   * Read-only — no commit, no branch, nothing written.
   *
   * The natural companion to `searchCode`: search says *which* file matched,
   * this says what that file actually contains, so a caller can verify a
   * claim about the code instead of inferring it from a snippet.
   *
   * Returns `null` — never throws — when there is nothing to read. That
   * covers a genuinely absent path, a `path` that resolves to a directory
   * rather than a file, and a file GitHub refuses to inline (over its size
   * ceiling, or binary). "Not found" is an ordinary answer here, exactly as
   * an empty array is for `searchCode`; a caller asking "does this file
   * exist" should not have to catch an exception to find out. Note the
   * consequence: GitHub also answers 404 for a repo the calling App cannot
   * see, so a `null` means "no readable file at that path, as far as this
   * installation is concerned" and not strictly "the file does not exist".
   */
  getFileContents(owner: string, repo: string, path: string, ref?: string): Promise<string | null>;

  /**
   * File read that survives GitHub's ~1MB inline ceiling by falling back to
   * the git blob (an OpenAPI contract document can run well past 1MB).
   * Optional so test doubles stay valid; callers treat "not implemented" as
   * unreadable, never as empty.
   */
  getLargeFileContents?(owner: string, repo: string, path: string, ref?: string): Promise<string | null>;

  /** Blob SHA of a file at `ref` — change detection for large-file snapshots. Optional, 404 → null. */
  getFileSha?(owner: string, repo: string, path: string, ref?: string): Promise<string | null>;

  /**
   * Resolves a ref to the full 40-character commit SHA it points at — or, when
   * `submodulePath` is given, the SHA that path's gitlink records at that ref.
   *
   * Exists because `update_submodule_pointer` takes a 40-character SHA and
   * nothing could produce one. In the 1.18.0 release thread that gap stopped
   * the train twice in a row: the only way forward was a person reading a SHA
   * off the GitHub UI and pasting it into Slack, for a value two API calls
   * away.
   *
   * A submodule read is a Contents call whose entry has `type: "submodule"`;
   * despite appearances that response DOES carry the gitlink SHA. Same
   * "not visible" semantics as `getFileContents`: `null` means no readable ref
   * or path as far as this installation is concerned, not that it is absent.
   */
  resolveRef?(
    owner: string,
    repo: string,
    options?: { ref?: string; submodulePath?: string },
  ): Promise<ResolvedRefDto | null>;

  /**
   * Enumerates paths under `path` (or the whole repo when `path` is omitted),
   * optionally at `ref`. Read-only — metadata only, never file contents.
   *
   * The companion to `getFileContents` for anything that file read cannot
   * answer: a directory, or a tree too large to walk by fetching one path at
   * a time (an App Health scan of thousands of files). `getFileContents`
   * returns null for a directory; this lists it.
   *
   * Returns an empty result — never throws — when there is nothing visible
   * to list. That covers a genuinely absent path, a `ref` that does not
   * exist, and a repo the calling App cannot see (GitHub answers 404 for
   * both). Same "not visible" semantics as `getFileContents`: a caller asking
   * "what is under this path" should not have to catch an exception to find
   * out the answer is "nothing this installation can see". A 403 is reported
   * separately as a Contents:read permission problem.
   *
   * The list is capped. When the cap (or GitHub's own tree truncation) is
   * hit, `truncated` is true — the provider will not silently drop entries
   * and pretend the listing is complete.
   */
  getTree(owner: string, repo: string, path?: string, ref?: string): Promise<GithubTreeResult>;

  /**
   * Fetches one git blob by SHA and returns its decoded UTF-8 text. Read-only.
   *
   * The fallback for a file `getFileContents` cannot inline (past GitHub's
   * contents-API size ceiling). Callers get the SHA from `getTree`; they
   * should not invent one.
   *
   * Returns `null` — never throws — when there is nothing readable: a SHA
   * that does not exist, a blob that is not valid UTF-8, a blob that
   * contains a NUL byte (binary), or a blob larger than the decode cap.
   * Oversize returns null rather than a truncated prefix — a half-file is a
   * lie about what the blob contains. Same 404 caveat as `getFileContents`:
   * GitHub also answers 404 for a repo the App cannot see, so null means
   * "no readable blob at that SHA, as far as this installation is
   * concerned". A 403 is reported separately as a Contents:read permission
   * problem.
   */
  getBlob(owner: string, repo: string, sha: string, maxBytes?: number): Promise<string | null>;

  /**
   * Lists Actions artifacts attached to one workflow run. Read-only.
   *
   * Returns an empty array — never throws — when the run is not visible
   * (404), matching `getFileContents`' "not visible" answer: a missing run
   * and a run this App cannot see are the same 404 from GitHub. A 403 is
   * reported separately as an Actions:read permission problem.
   */
  listWorkflowRunArtifacts(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<GithubWorkflowArtifact[]>;

  /**
   * Downloads one Actions artifact as the zip (or raw bytes) GitHub returns.
   * Read-only. Does not unpack, inspect, or execute anything inside.
   *
   * Unlike `listWorkflowRunArtifacts`, a missing artifact throws rather than
   * returning empty bytes: an unknown id is a caller mistake, and an empty
   * Buffer would be indistinguishable from a real zero-byte zip. A 403 is
   * reported separately as an Actions:read permission problem. Same 404
   * caveat as `getPullRequestFiles`: "not found" means "not visible to this
   * installation".
   */
  downloadWorkflowRunArtifact(owner: string, repo: string, artifactId: number): Promise<Buffer>;

  /**
   * Lists jobs on one Actions run. Read-only. Empty array when the run is not
   * visible (404). A 403 is reported as an Actions:read permission problem.
   */
  listWorkflowRunJobs(owner: string, repo: string, runId: number): Promise<GithubWorkflowJobDto[]>;

  /**
   * Downloads one job's logs as plain text (GitHub timestamp prefixes stripped).
   * Read-only. A missing job throws rather than returning empty text.
   */
  downloadWorkflowJobLogs(owner: string, repo: string, jobId: number): Promise<string>;

  /**
   * Cancels an in-progress Actions run. Write — same gate as `dispatchWorkflow`.
   * GitHub 409s when the run is already completed; that is reported as a
   * caller mistake, not a permission problem.
   */
  cancelWorkflowRun(owner: string, repo: string, runId: number): Promise<void>;

  /**
   * Lists the files a pull request changes, with per-file line counts and the
   * unified diff where GitHub provides one. Read-only — this inspects a PR,
   * it does not review, approve, or merge it.
   *
   * `patch` is absent, not empty, for files GitHub will not diff (binary or
   * too large) — see `PullRequestFileDto`.
   *
   * Unlike `getFileContents`, a missing PR throws rather than returning an
   * empty result: an unknown pull number is a caller mistake, not an ordinary
   * answer, and an empty array would be indistinguishable from a real PR that
   * changes nothing. The error says the PR was not found rather than blaming
   * permissions — though note GitHub also answers 404 for a repo the calling
   * App cannot see, so "not found" means "not visible to this installation"
   * and is not proof the PR does not exist. A 403 is reported separately as a
   * permission problem.
   */
  getPullRequestFiles(owner: string, repo: string, pullNumber: number): Promise<PullRequestFileDto[]>;

  /**
   * Opens a pull request from `head` into `base`. A write with a visible
   * external side effect — it creates a real PR that notifies reviewers and
   * code owners — so it belongs to the same gated class as `createIssue` and
   * `dispatchWorkflow`, not to the read-through methods above.
   *
   * This method only *opens* the PR. It does not push the branch (`head` must
   * already exist on the remote, or GitHub rejects the request). Merging is a
   * separate write (`mergePullRequest` / `mergeIntoBranch` on the concrete
   * provider), gated by `pr.merge` / `branch.merge`.
   *
   * Not idempotent, unlike most mutations on this interface: calling it twice
   * with the same `head`/`base` does not converge — GitHub rejects the second
   * call because a PR for that branch pair is already open. Callers that may
   * retry must handle that rejection rather than assume a no-op.
   */
  createPullRequest(
    owner: string,
    repo: string,
    options: CreatePullRequestOptions,
  ): Promise<CreatedPullRequestDto>;
}

export const GITHUB_PROVIDER_TOKEN = Symbol("GITHUB_PROVIDER_TOKEN");
