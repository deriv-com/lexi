export interface GithubIssueDto {
  githubIssueId: number;
  githubNumber: number;
  repoOwner: string;
  repoName: string;
  title: string;
  body: string | null;
  url: string;
  authorLogin: string | null;
  labels: string[];
  state: "open" | "closed";
  /**
   * GitHub's `state_reason` for a closed issue: "completed" (resolved) vs
   * "not_planned" (won't fix / could not reproduce) vs "reopened". Required to
   * distinguish a genuine regression from a recurrence of something that was
   * never observed — see resolveClosedIssueAction.
   */
  stateReason: "completed" | "not_planned" | "reopened" | null;
  assignees: string[];
  githubCreatedAt: string;
  githubUpdatedAt: string;
}

export interface GithubCommentDto {
  id: number;
  authorLogin: string | null;
  body: string;
  createdAt: string;
}

export interface GithubTimelineEventDto {
  id: number;
  event: string;
  actorLogin: string | null;
  createdAt: string;
  raw: Record<string, unknown>;
}

export interface LinkedPullRequestDto {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  merged: boolean;
  title: string;
}

export interface GithubPullRequestDto {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  url: string;
  /**
   * GitHub's own mergeability verdict from `pulls.get`. Tri-state on purpose:
   * `true`/`false` are answers, `null`/`undefined` mean GitHub had not
   * computed it when asked. An auto-merge gate treats only an
   * explicit `false` as a refusal reason — an uncomputed verdict is re-read,
   * never assumed.
   */
  mergeable?: boolean | null;
  /**
   * The commit GitHub created when the PR merged — the only handle on "where
   * this fix landed in history", and so the base of every tag-containment
   * comparison. Optional because it is absent on an unmerged PR and because
   * older test doubles do not set it; `null`/`undefined` must be read as "no
   * commit to trace", never as "not released".
   */
  mergeCommitSha?: string | null;
  /**
   * The head branch this PR merges FROM, as GitHub recorded it.
   *
   * Present even after that branch is deleted — GitHub stores the ref name on
   * the pull request rather than resolving it against the repo — so this names
   * the branch to check and is NOT evidence the branch still exists. Pair it
   * with the gateway's `branchExists` probe, which is the thing that knows.
   *
   * Optional because older test doubles do not set it; `undefined` must be read
   * as "which branch is unknown", never as "no branch".
   */
  headRef?: string | null;
  /**
   * The base branch this PR merges INTO, as GitHub recorded it.
   *
   * The reason it is here and not only on the review-status shape: an operation
   * asked for by PR number has to replay onto the base that PR actually targets.
   * A PR opened against `qa` or another feature branch is behind THAT, not
   * behind `main`, and defaulting to `main` would rewrite the branch onto a base
   * nobody asked for — irreversibly, since the operation force-pushes.
   *
   * Optional because older test doubles do not set it; `undefined` must be read
   * as "which base is unknown", never as "the default branch".
   */
  baseRef?: string | null;
  /**
   * The current head commit. Used as the optimistic-concurrency `sha` on
   * `mergePullRequest` so a merge that races a new push is rejected rather
   * than landing the wrong tip. Optional on older doubles; `undefined` means
   * "do not send a sha" and is weaker than a real pin.
   */
  headSha?: string | null;
  /** GitHub's draft flag. A draft cannot be merged until a human marks it ready. */
  draft?: boolean;
}

/**
 * PR review-status read shapes.
 *
 * These mirror `PullRequestReviewPort` in `@lexi/notifications` structurally
 * rather than importing it: `packages/github` has no dependency on
 * `@lexi/notifications` and should not acquire one just to name a data shape.
 * `OctokitGithubProvider.getReviewStatus` therefore satisfies that port by
 * structural typing at the consumption site, with no new package edge.
 *
 * READ-ONLY BY CONSTRUCTION. The GitHub App's `PullRequests:write` grant is
 * used for comments only; merging and closing a PR are permanent non-goals
 *. Nothing here returns a handle that could end a pull request.
 */
export type GithubPullRequestReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING";

export interface GithubPullRequestReviewDto {
  commitId?: string;
  authorType?: string;
  authorAssociation?: string;
  reviewer: string;
  state: GithubPullRequestReviewState;
  submittedAt: Date;
}

export interface GithubPullRequestCheckDto {
  name: string;
  status: "queued" | "in_progress" | "completed";
  /** Null while the run is not yet completed. */
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | "skipped"
    | null;
}

export interface GithubPullRequestReviewStatusDto {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  reviews: GithubPullRequestReviewDto[];
  checks: GithubPullRequestCheckDto[];
  /**
   * Logins GitHub currently lists as *requested* reviewers.
   *
   * Note the tense: GitHub drops a login from this list the moment that
   * person submits a review, so this is "still waiting on", not "was ever
   * asked". An empty array therefore means "nobody is outstanding right
   * now" — which is NOT the same as "nobody was ever asked to review".
   * Consumers that need the latter must read `reviews` as well.
   *
   * Empty rather than absent when GitHub returns nothing, matching how
   * `checks` degrades: a caller should never have to distinguish "no
   * reviewers requested" from "the field was missing".
   */
  requestedReviewers: string[];
  /**
   * Team slugs requested as reviewers (e.g. "web-site"). Kept separate from
   * `requestedReviewers` because a team is not a person: it is evidence that
   * a review was requested, but it names nobody to nudge.
   */
  requestedTeams: string[];
  /**
   * Null while GitHub is still computing mergeability. Passed through
   * unchanged — null is "not yet known", NOT "has conflicts", and the
   * summariser depends on being able to tell those apart.
   */
  mergeable: boolean | null;
  /**
   * Snapshot fields for PR-health reads. Optional so older test doubles and
   * the stale-PR nudge (which never needed them) keep compiling; the live
   * provider always populates them from `pulls.get`.
   */
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  authorLogin?: string | null;
  headRef?: string | null;
  baseRef?: string | null;
  /**
   * Head commit SHA. `checks` are read for this commit only, so a consumer
   * comparing any other per-commit evidence (e.g. an advisory review comment
   * that names the SHA it reviewed) needs it to tell current from stale.
   */
  headSha?: string | null;
  /**
   * False when check runs could not be listed (the call threw, or the PR had
   * no head SHA), so `checks: []` means "unread", not "none exist". Optional
   * for older doubles; absent is treated as read.
   */
  checksRead?: boolean;
}

/** One row from `GET /repos/{owner}/{repo}/pulls`. */
export interface ListedPullRequestDto {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  draft: boolean;
  authorLogin: string | null;
  createdAt: string;
  updatedAt: string;
  headRef: string | null;
  baseRef: string | null;
  /** When the PR merged; null when it is open or was closed without merging. */
  mergedAt?: string | null;
}

export interface ListPullRequestsOptions {
  state?: "open" | "closed" | "all";
  /** GitHub's list sort. Default `created` so "oldest first" is `direction: "asc"`. */
  sort?: "created" | "updated";
  direction?: "asc" | "desc";
  perPage?: number;
  page?: number;
  /**
   * Filter to pull requests opened FROM this branch. GitHub wants `user:ref`
   * here; a bare branch name is qualified with the repo owner, because the
   * unqualified form silently matches nothing rather than erroring.
   */
  head?: string;
  /** Filter to pull requests targeting this branch — i.e. what a branch deletion would orphan. */
  base?: string;
}

/**
 * A branch that no longer exists, and the sha it pointed at when it stopped.
 *
 * The sha is the whole point: GitHub keeps the commits reachable by sha long
 * after the ref is gone, so recording it at deletion time is what makes the
 * deletion undoable. A delete that does not report where the branch was is a
 * delete nobody can walk back.
 */
export interface DeletedBranchDto {
  name: string;
  sha: string;
}

/** Result of `PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch`. */
export interface UpdatePullRequestBranchResult {
  updated: boolean;
  message: string;
}

export interface ListBugHuntIssuesOptions {
  owner: string;
  repo: string;
  label: string;
  state?: "open" | "closed" | "all";
  perPage?: number;
  page?: number;
}

export interface ListIssuesOptions {
  owner: string;
  repo: string;
  state?: "open" | "closed" | "all";
  perPage?: number;
  page?: number;
}

/**
 * Raw (snake_case) GitHub issue payload, as returned by the REST API.
 *
 * Deliberately NOT normalised into GithubIssueDto: the corpus synchroniser
 * indexes GitHub verbatim (including `pull_request`, which it uses to skip PRs,
 * and the raw `updated_at` string it stores as its watermark). Normalising here
 * would drop `pull_request` and change the watermark contract.
 */
export interface GithubRawIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user?: { login?: string | null } | null;
  labels: Array<string | { name?: string }>;
  state: string;
  assignees?: Array<{ login: string }> | null;
  created_at: string;
  updated_at: string;
  /** Present (and truthy) when the "issue" is actually a pull request. */
  pull_request?: unknown;
}

/**
 * An issue read for release-tracing, carrying the fields `GithubIssueDto`
 * deliberately does not.
 *
 * Separate from `GithubIssueDto` rather than an extension of it: that DTO is
 * the corpus synchroniser's shape, consumed by dedup, triage and reproduction,
 * and widening it would change what a dozen unrelated call sites store. This
 * carries `milestone` and `closedAt`, which only release-tracing reads.
 *
 * `milestone` is present so it can be REPORTED, never so it can be used as a
 * version. See `issue-fix-version.service.ts`: the issue this was built for has
 * `milestone: null` and shipped in v1.16.0, so a milestone-derived answer is a
 * false negative wearing the costume of a real one.
 */
export interface GithubIssueDetailDto {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  /** Milestone title, or null. Not a release, not a tag, not a version. */
  milestone: string | null;
  closedAt: string | null;
  url: string;
}

/** A git tag as GitHub's list-tags endpoint returns it: name and commit, no date. */
export interface GithubTagDto {
  name: string;
  commitSha: string;
}

/**
 * `GET /repos/{owner}/{repo}/compare/{base}...{head}`, reduced to what
 * containment needs.
 *
 * GitHub offers no `git tag --contains`, so this comparison is the only
 * server-side way to ask "does this tag's history include this commit". A
 * `status` of `ahead` or `identical` means yes; `behind` and `diverged` mean
 * no. `aheadBy` — commits in the tag that are not in the merge commit — is how
 * "earliest containing tag" is measured without sorting version strings.
 */
export interface GithubCommitComparisonDto {
  status: "ahead" | "behind" | "identical" | "diverged" | string;
  aheadBy: number;
  behindBy: number;
}

/** Raw (snake_case) GitHub release payload, as returned by the REST API. */
export interface GithubRawRelease {
  tag_name: string;
  name: string | null;
  body?: string | null;
  target_commitish: string;
  published_at: string | null;
  author?: { login?: string | null } | null;
  prerelease: boolean;
  html_url: string;
}

/**
 * A ref resolved to a commit, or a submodule gitlink read at a ref.
 *
 * `sha` is always the full 40 characters, because that is what the callers
 * needing it require — `update_submodule_pointer` rejects a short sha, so
 * abbreviating here would only move the failure downstream.
 */
export interface ResolvedRefDto {
  /** What was asked for: a branch/tag/sha, or the submodule path. */
  requested: string;
  /** Full 40-character commit SHA. */
  sha: string;
  /** How it resolved — useful when a name is both a branch and a tag. */
  kind: "branch" | "tag" | "commit" | "submodule";
  /** For a submodule, the upstream repository the gitlink points into. */
  submoduleUrl?: string;
}

/**
 * A `workflow_dispatch` run correlated by `findDispatchedRun` after the fact —
 * the dispatch endpoint itself returns 204 with no run id, so this is a
 * best-effort match on timing.
 *
 * The target workflow's own `concurrency.group` (keyed on the dispatching
 * thread) guarantees at most one live run *for that thread*, but says
 * nothing about two different threads dispatching the same repo/workflow
 * close together — GitHub's list-runs API does not expose the original
 * `workflow_dispatch` inputs, so `findDispatchedRun` cannot tell those runs
 * apart by thread unless the caller passes `nameContains` (the QA caller matches
 * `ISSUE-N` in qa-mobile.yml's run title). Otherwise it narrows the field
 * two other ways: preferring the *earliest* run created after `since`, and
 * excluding any run ID the caller already knows belongs to a different
 * in-flight attempt on the same repo (see `excludeRunIds`).
 */
export interface DispatchedWorkflowRun {
  runId: number;
  runUrl: string;
  /** Raw GitHub Actions run status ("queued" | "in_progress" | "completed" | ...). */
  status: string;
}

/**
 * A workflow run read by id (`GET .../actions/runs/{run_id}`). Optional
 * `logVerdict` is parsed from job logs (`verdict=PASS`) when the workflow
 * prints one — used for QA workflows such as qa-mobile.yml, which print a
 * verdict rather than a fix result.
 */
export type QaLogVerdict = "PASS" | "FAIL" | "INFRA" | "NEEDS_REVIEW";

export interface GithubWorkflowRunDto {
  workflowPath?: string;
  headBranch?: string;
  runAttempt?: number;
  repositoryFullName?: string;
  headRepositoryFullName?: string;
  runId: number;
  runUrl: string;
  status: string;
  conclusion: string | null;
  logVerdict?: QaLogVerdict | null;
  name?: string | null;
  displayTitle?: string | null;
  event?: string | null;
  headSha?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** One hit from `searchCode` — a file whose content matched, not a diff or full read. */
export interface CodeSearchMatchDto {
  path: string;
  url: string;
  /** Short fragments around the match, when GitHub's API returns them. May be empty. */
  snippets: string[];
}

/**
 * One changed file in a pull request, as returned by `getPullRequestFiles`.
 *
 * `patch` is optional rather than `string | null` because GitHub genuinely
 * omits the key for files it will not diff — binary blobs, and text files
 * whose diff exceeds its size ceiling. A caller that reasons about the diff
 * must be able to tell "GitHub gave us no diff for this file" apart from
 * "the diff was empty", so this is modelled as absent rather than coerced to
 * `""`. The additions/deletions/changes counts are still populated in that
 * case, so a file with a large `changes` count and no `patch` is normal, not
 * a bug.
 */
export interface PullRequestFileDto {
  filename: string;
  /**
   * Raw GitHub file status ("added" | "removed" | "modified" | "renamed" |
   * "copied" | "changed" | "unchanged"). Passed through rather than narrowed
   * to a union: unlike `GithubIssueDto.stateReason`, nothing branches on this
   * value in a way an unrecognised entry could make unsafe, so dropping an
   * unfamiliar-but-real status would lose more than it protects.
   */
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  /** The unified diff for this file. Absent when GitHub does not supply one — see above. */
  patch?: string;
}

/** Inputs for `createPullRequest`. `head`/`base` are branch names, not refs. */
export interface CreatePullRequestOptions {
  title: string;
  /** Branch the changes live on. Same-repo only ("branch"); cross-fork ("owner:branch") is untested here. */
  head: string;
  /** Branch to merge into (e.g. "main"). Required — the caller owns knowing the target repo's default branch. */
  base: string;
  body?: string;
  /** Opens the PR as a draft. Repos on plans without draft PRs reject this outright. */
  draft?: boolean;
}

/**
 * The pull request `createPullRequest` just opened.
 *
 * Extends `GithubPullRequestDto` (so it stays usable anywhere a PR is
 * accepted) and adds `draft`, which is read back from GitHub's response
 * rather than echoed from the request: whether the PR actually opened as a
 * draft is GitHub's answer, not the caller's, and reflecting the requested
 * flag back would be a guess dressed up as a fact.
 */
export interface CreatedPullRequestDto extends GithubPullRequestDto {
  draft: boolean;
}

/** Result of merging an open PR into its current base (`PUT .../merge`). */
export interface MergedPullRequestDto {
  merged: boolean;
  sha: string | null;
  message: string;
}

/** A branch ref that was just created (`POST .../git/refs`). */
export interface CreatedBranchDto {
  name: string;
  sha: string;
  url: string;
}

/**
 * Result of merging a head (branch or SHA) into a named base without going
 * through a pull request (`POST .../merges`). `conflict: true` is an ordinary
 * answer — GitHub could not merge cleanly — not an installation fault.
 */
export interface MergeIntoBranchResult {
  merged: boolean;
  alreadyUpToDate: boolean;
  conflict: boolean;
  sha: string | null;
  message: string;
}

/** A gitlink commit that moved a nested submodule pointer. */
export interface UpdatedSubmodulePointerDto {
  path: string;
  sha: string;
  commitSha: string;
  branch: string;
}

export interface MergePullRequestOptions {
  /** Head SHA the merge must still match — GitHub 409s if the PR moved. */
  sha?: string;
  commitTitle?: string;
  commitMessage?: string;
}

export interface MergeIntoBranchOptions {
  /** Branch to merge INTO (the integration branch). */
  base: string;
  /** Branch name or commit SHA to merge FROM. */
  head: string;
  commitMessage?: string;
}

export interface CreateBranchOptions {
  name: string;
  /** Existing branch to point the new ref at. Defaults to `main`. */
  from?: string;
}

export interface UpdateSubmodulePointerOptions {
  branch: string;
  path: string;
  sha: string;
  commitMessage: string;
}

/**
 * One entry from `getTree`. Metadata only — never file contents.
 *
 * `size` is null for a `tree` (GitHub does not report directory size on either
 * the git-trees or contents listing). A blob's size is the byte length GitHub
 * recorded, which is not a promise the blob will fit in `getBlob`'s decode cap.
 */
export interface GithubTreeEntry {
  path: string;
  type: "blob" | "tree";
  size: number | null;
  sha: string;
}

/**
 * A path listing. `truncated` is true when either GitHub itself truncated the
 * tree or this provider hit its own entry cap — the caller must not treat a
 * short list as the whole repo.
 */
export interface GithubTreeResult {
  entries: GithubTreeEntry[];
  truncated: boolean;
}

/**
 * One Actions artifact on a workflow run. `archiveDownloadUrl` is recorded
 * for diagnostics only: callers must download through
 * `downloadWorkflowRunArtifact`, never by fetching this URL themselves.
 */
export interface GithubWorkflowArtifact {
  id: number;
  name: string;
  sizeInBytes: number;
  expired: boolean;
  archiveDownloadUrl?: string;
}

/** One job on an Actions workflow run (`GET .../actions/runs/{id}/jobs`). */
export interface GithubWorkflowJobDto {
  jobId: number;
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  startedAt: string | null;
  completedAt: string | null;
  /**
   * The job's steps as GitHub reports them — names from the workflow YAML and
   * their status, never log content. Absent when GitHub sent none.
   */
  steps?: GithubWorkflowStepDto[];
}

export interface GithubWorkflowStepDto {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}
