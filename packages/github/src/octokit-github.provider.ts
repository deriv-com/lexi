import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { PinoLoggerService } from "@lexi/logger";
import { GitHubProvider } from "./github-provider.interface";
import { resolveInstallationId } from "./octokit.factory";
import { workflowRunDisplayName, workflowRunNameIncludes } from "./workflow-run-name";
import {
  CodeSearchMatchDto,
  CreatedPullRequestDto,
  CreatePullRequestOptions,
  DispatchedWorkflowRun,
  ResolvedRefDto,
  GithubCommentDto,
  GithubCommitComparisonDto,
  GithubIssueDetailDto,
  GithubIssueDto,
  GithubPullRequestCheckDto,
  GithubPullRequestDto,
  GithubPullRequestReviewDto,
  GithubPullRequestReviewState,
  GithubPullRequestReviewStatusDto,
  GithubRawIssue,
  GithubRawRelease,
  GithubTagDto,
  GithubTimelineEventDto,
  GithubTreeEntry,
  GithubTreeResult,
  GithubWorkflowArtifact,
  GithubWorkflowJobDto,
  GithubWorkflowRunDto,
  LinkedPullRequestDto,
  ListBugHuntIssuesOptions,
  ListIssuesOptions,
  ListedPullRequestDto,
  DeletedBranchDto,
  ListPullRequestsOptions,
  MergedPullRequestDto,
  MergeIntoBranchOptions,
  MergeIntoBranchResult,
  MergePullRequestOptions,
  PullRequestFileDto,
  UpdatePullRequestBranchResult,
  UpdatedSubmodulePointerDto,
  CreatedBranchDto,
  CreateBranchOptions,
  UpdateSubmodulePointerOptions,
} from "./types";
import { assertFullSha, assertSafeBranchName, assertSubmodulePath } from "./git-ref";

/** Walk a 4,629-file tree; stop before an unbounded listing becomes the answer. */
const TREE_ENTRY_CAP = 10_000;
/** 1,000 comments at 100/page. Past this `listComments` warns instead of truncating in silence. */
const LIST_COMMENTS_MAX_PAGES = 10;
/** Decode cap for `getBlob`. Over this, return null — a truncated prefix is a lie. */
const BLOB_DECODE_CAP_BYTES = 512 * 1024;
/**
 * Decode cap for `getLargeFileContents`, whose whole purpose is the documents
 * the 512 KiB default is meant to keep out.
 *
 * The default existed to stop an incidental source-file read pulling a huge
 * blob into memory. It was also applied to the one method named for reading
 * large files, which made it useless for its only caller: a 1.6 MB OpenAPI
 * contract document, so every read returned null and the
 * caller reported it as a missing GitHub App installation.
 *
 * 8 MiB is ~5x the current document, well under the GitHub blob API's own
 * 100 MB ceiling, and bounded enough that a single read cannot exhaust the
 * pod. Over it, the same rule as before: null, never a prefix.
 */
const LARGE_FILE_DECODE_CAP_BYTES = 8 * 1024 * 1024;

interface OctokitIssueLike {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  user?: { login?: string | null } | null;
  labels: Array<string | { name?: string }>;
  state: string;
  state_reason?: string | null;
  assignees?: Array<{ login: string }> | null;
  created_at: string;
  updated_at: string;
}

function toLabelNames(labels: Array<string | { name?: string }>): string[] {
  return labels
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((name): name is string => Boolean(name));
}

/**
 * GitHub may return values outside the documented set, so anything unrecognised
 * becomes null rather than being passed through. A wrong closure reason changes
 * whether a recurrence is treated as a regression, so guessing is not safe.
 */
function normaliseStateReason(value: unknown): "completed" | "not_planned" | "reopened" | null {
  if (value === "completed" || value === "not_planned" || value === "reopened") {
    return value;
  }
  return null;
}

function toIssueDto(owner: string, repo: string, issue: OctokitIssueLike): GithubIssueDto {
  return {
    githubIssueId: issue.id,
    githubNumber: issue.number,
    repoOwner: owner,
    repoName: repo,
    title: issue.title,
    body: issue.body ?? null,
    url: issue.html_url,
    authorLogin: issue.user?.login ?? null,
    labels: toLabelNames(issue.labels),
    state: issue.state === "closed" ? "closed" : "open",
    stateReason: normaliseStateReason(issue.state_reason),
    assignees: (issue.assignees ?? []).map((a) => a.login),
    githubCreatedAt: issue.created_at,
    githubUpdatedAt: issue.updated_at,
  };
}

const QA_LOG_VERDICT_PATTERN = /\bverdict=(PASS|FAIL|INFRA|NEEDS_REVIEW)\b/;

/**
 * `GET .../actions/jobs/{job_id}/logs` does not return raw stdout — GitHub
 * prefixes every line with an RFC3339 timestamp (`2026-08-13T22:10:00.1234567Z `).
 * Strip it before matching so both the match and any text relayed onward
 * are clean.
 */
function stripLogTimestamps(log: string): string {
  return log.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /gm, "");
}

/** Drops the file extension for a friendlier name in error/log messages. */
function workflowLabel(workflowFile: string): string {
  return workflowFile.replace(/\.ya?ml$/i, "");
}

/** Closing keywords only count in a PR title/body, and only for same-org issues. */
function bodyAlreadyCloses(body: string, issueRef: string): boolean {
  const escaped = issueRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\\s+${escaped}\\b`, "i").test(body);
}

/**
 * The delete call was accepted but the branch still reads as present.
 *
 * Its own type because the two failure shapes need different reporting: every
 * other error from `deleteBranch` happens BEFORE the ref is touched, so the
 * caller may honestly say nothing changed. This one may have deleted the
 * branch, and a caller that reports it as a no-op is stating something it does
 * not know.
 */
export class BranchDeletionUnverifiedError extends Error {
  readonly unverified = true as const;
  constructor(message: string) {
    super(message);
    this.name = "BranchDeletionUnverifiedError";
  }
}

function isMissingActionsPermission(error: unknown): boolean {
  const status = (error as { status?: number } | null | undefined)?.status;
  return status === 403 || status === 404;
}

function errorStatus(error: unknown): number | undefined {
  return (error as { status?: number } | null | undefined)?.status;
}

/**
 * Octokit types `downloadArtifact` as several shapes depending on whether it
 * followed the 302. Accept the byte-carrying ones; refuse a URL string so we
 * never fetch an arbitrary location from inside the orchestrator (T4).
 */
function artifactBytesToBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (data instanceof Uint8Array) return Buffer.from(data);
  throw new Error("Artifact download did not return bytes — refusing to fetch a URL from the payload");
}

/**
 * Turns a 403/404 from an Actions, code-search, contents, or pulls endpoint
 * into an actionable message instead of an opaque Octokit stack trace. Mirrors
 * the degrade-with-a-clear-message contract `resolveInstallationId` already
 * uses in octokit.factory.ts for the same class of failure (App not installed
 * / not visible on this repo) — a 403/404 here almost always means the calling
 * GitHub App is not installed on `repo` with the named permission, not a
 * transient fault.
 */
function toActionsPermissionError(
  owner: string,
  repo: string,
  permission:
    | "Actions:write"
    | "Actions:read"
    | "Contents:read"
    // Deleting a ref needs Contents:write and nothing else — naming the pair
    // here would send a repo admin looking for a PullRequests grant the call
    // never used.
    | "Contents:write"
    | "Contents:write and PullRequests:write"
    | "Issues:write"
    | "PullRequests:write",
  action: string,
): Error {
  return new Error(
    `Cannot ${action} on ${owner}/${repo}: the calling GitHub App does not appear to be installed there ` +
      `with ${permission}. Ask a repo admin to install it, or confirm GITHUB_APP_INSTALLATION_ID covers this org.`,
  );
}

/**
 * Production GitHubProvider implementation backed by Octokit's REST client.
 * All mutating operations are written to be idempotent: re-invoking them
 * with the same target state converges to that state without side effects
 * (no duplicate labels, no duplicate comments beyond what's requested, no
 * duplicate assignees).
 */
export class OctokitGithubProvider implements GitHubProvider {
  /** Cache of installation-scoped clients built for a *non-primary* target repo, keyed "owner/repo". */
  private readonly crossRepoClientCache = new Map<string, Octokit>();
  /** App-level (JWT) client, built lazily — can look up which installation covers an arbitrary repo, but cannot call repo-content endpoints itself. */
  private appLevelOctokit: Octokit | undefined;

  constructor(
    private readonly octokit: Octokit,
    private readonly logger: PinoLoggerService,
    /**
     * Present only in App-auth mode. `this.octokit` is a single client bound
     * to whichever installation covers the primary configured
     * GITHUB_OWNER/GITHUB_REPO — a GitHub App installation token is strictly
     * scoped to the org it was minted for, so it cannot authenticate a
     * request against a *different* org's repo, even if the same App is
     * separately installed there (confirmed live: dispatching to
     * acme-internal/mobile-app worked because it shares the
     * primary repo's org; acme/web-app failed with a 403/404
     * "not installed" error that had nothing to do with actual installation
     * state on GitHub's side). Without this, cross-repo dispatch methods
     * fall back to `this.octokit` unchanged (token-mode auth has no
     * per-installation concept to resolve in the first place).
     */
    private readonly appAuth?: { appId: string; privateKey: string; baseUrl: string },
    /**
     * User-PAT Octokit for minting signed attachment CDN URLs. Installation
     * clients cannot; leave undefined when no user PAT is configured.
     */
    private readonly evidenceOctokit?: Octokit,
  ) {}

  /**
   * Resolves (and caches) the Octokit client authenticated for whichever
   * installation covers `owner/repo`.
   *
   * `this.octokit` is bound to the installation for GITHUB_OWNER/GITHUB_REPO
   * (typically `acme-internal/issues`). A token minted for that
   * org cannot see a repo in another org — GitHub answers 404, not 403,
   * which is how `close_pull_request` on `acme/web-app#3099` and
   * `createIssue` (spec submit) on the same repo refused with "Not Found"
   * while `dispatchWorkflow` succeeded (it already went through this helper).
   *
   * Every method that takes an arbitrary owner/repo and talks to GitHub
   * must use this. Token-mode auth has no per-installation concept and
   * falls back to `this.octokit` unchanged.
   */
  private async getClientForRepo(owner: string, repo: string): Promise<Octokit> {
    if (!this.appAuth) {
      return this.octokit;
    }
    const key = `${owner}/${repo}`;
    const cached = this.crossRepoClientCache.get(key);
    if (cached) return cached;

    if (!this.appLevelOctokit) {
      this.appLevelOctokit = new Octokit({
        authStrategy: createAppAuth,
        auth: { appId: this.appAuth.appId, privateKey: this.appAuth.privateKey },
        baseUrl: this.appAuth.baseUrl,
      });
    }

    const installationId = await resolveInstallationId(this.appLevelOctokit, owner, repo);
    const client = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: this.appAuth.appId, privateKey: this.appAuth.privateKey, installationId },
      baseUrl: this.appAuth.baseUrl,
    });
    this.crossRepoClientCache.set(key, client);
    return client;
  }

  async getRepoAccessToken(owner: string, repo: string): Promise<string | null> {
    try {
      const client = await this.getClientForRepo(owner, repo);
      if (typeof client.auth !== "function") return null;
      const readToken = async (arg?: { type: "installation" }): Promise<string | null> => {
        const result = arg ? await client.auth(arg) : await client.auth();
        const token = (result as { token?: unknown } | undefined)?.token;
        return typeof token === "string" && token.length > 0 ? token : null;
      };
      try {
        const installed = await readToken({ type: "installation" });
        if (installed) return installed;
      } catch {
        // Token-mode Octokit rejects type: "installation".
      }
      return await readToken();
    } catch {
      return null;
    }
  }

  async renderGfmHtml(owner: string, repo: string, markdown: string): Promise<string | null> {
    const text = markdown.trim();
    if (!text) return null;
    let fallback: string | null = null;
    for (const client of await this.htmlMintClients(owner, repo)) {
      try {
        const response = await client.request("POST /markdown", {
          text,
          mode: "gfm",
          context: `${owner}/${repo}`,
        });
        const html = typeof response.data === "string" && response.data.trim() ? response.data : null;
        if (!html) continue;
        if (htmlHasSignedCdn(html)) return html;
        fallback ??= html;
      } catch {
        continue;
      }
    }
    return fallback;
  }

  async getIssueHtml(owner: string, repo: string, issueNumber: number): Promise<string | null> {
    if (!Number.isInteger(issueNumber) || issueNumber < 1) return null;
    let fallback: string | null = null;
    try {
      for (const client of await this.htmlMintClients(owner, repo)) {
        const html = await readIssueHtml(client, owner, repo, issueNumber);
        if (!html) continue;
        if (htmlHasSignedCdn(html)) return html;
        fallback ??= html;
      }
    } catch {
      return fallback;
    }
    return fallback;
  }

  private async htmlMintClients(owner: string, repo: string): Promise<Octokit[]> {
    const clients: Octokit[] = [await this.getClientForRepo(owner, repo)];
    if (this.evidenceOctokit) clients.push(this.evidenceOctokit);
    return clients;
  }

  async listBugHuntIssues(options: ListBugHuntIssuesOptions): Promise<GithubIssueDto[]> {
    const { owner, repo, label, state = "open", perPage = 100, page = 1 } = options;
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.issues.listForRepo({
      owner,
      repo,
      labels: label,
      state,
      per_page: perPage,
      page,
    });

    return this.filterIssues(owner, repo, response.data as unknown as OctokitIssueLike[]);
  }

  async listIssues(options: ListIssuesOptions): Promise<GithubIssueDto[]> {
    const { owner, repo, state = "open", perPage = 100, page = 1 } = options;
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.issues.listForRepo({
      owner,
      repo,
      state,
      per_page: perPage,
      page,
    });
    return this.filterIssues(owner, repo, response.data as unknown as OctokitIssueLike[]);
  }

  /**
   * Mirrors the query the corpus synchroniser previously issued with a raw
   * fetch(): state=all, since, direction=asc, caller-driven pagination. Kept
   * raw (no DTO mapping) so `pull_request` and the exact `updated_at` watermark
   * survive. Octokit throws on a non-2xx response, which is the same contract
   * the previous `throw new Error("GitHub API <status>")` gave the caller.
   */
  async listIssuesUpdatedSince(
    owner: string,
    repo: string,
    since: string,
    perPage = 100,
    page = 1,
  ): Promise<GithubRawIssue[]> {
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.issues.listForRepo({
      owner,
      repo,
      state: "all",
      since,
      direction: "asc",
      per_page: perPage,
      page,
    });
    return response.data as unknown as GithubRawIssue[];
  }

  async listReleases(owner: string, repo: string, perPage = 20): Promise<GithubRawRelease[]> {
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.repos.listReleases({
      owner,
      repo,
      per_page: perPage,
    });
    return response.data as unknown as GithubRawRelease[];
  }

  async createIssue(
    owner: string,
    repo: string,
    title: string,
    body: string,
    labels: string[] = [],
  ): Promise<GithubIssueDto> {
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.issues.create({
        owner,
        repo,
        title,
        body,
        labels: labels.length > 0 ? labels : undefined,
      });
      this.logger.log(`Created issue ${owner}/${repo}#${response.data.number}`, "OctokitGithubProvider");
      return toIssueDto(owner, repo, response.data as unknown as OctokitIssueLike);
    } catch (error) {
      if (isMissingActionsPermission(error)) {
        throw toActionsPermissionError(owner, repo, "Issues:write", "create an issue");
      }
      throw error;
    }
  }

  async updateIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    patch: { title: string; body: string },
  ): Promise<GithubIssueDto> {
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.issues.update({ owner, repo, issue_number: issueNumber, ...patch });
      this.logger.log(`Updated issue ${owner}/${repo}#${issueNumber}`, "OctokitGithubProvider");
      return toIssueDto(owner, repo, response.data as unknown as OctokitIssueLike);
    } catch (error) {
      if (isMissingActionsPermission(error)) {
        throw toActionsPermissionError(owner, repo, "Issues:write", "update an issue");
      }
      throw error;
    }
  }

  private filterIssues(owner: string, repo: string, issues: OctokitIssueLike[]): GithubIssueDto[] {
    return issues
      .filter((issue) => !("pull_request" in issue) || !(issue as { pull_request?: unknown }).pull_request)
      .map((issue) => toIssueDto(owner, repo, issue));
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GithubIssueDto> {
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.issues.get({ owner, repo, issue_number: issueNumber });
    return toIssueDto(owner, repo, response.data as unknown as OctokitIssueLike);
  }

  /**
   * Cross-installation issue read. Kept as a distinct name because
   * `GitHubProvider` declares it optional and callers that must fail loudly on
   * an unreadable repo (for example, build briefs) depend on the gateway's
   * "not implemented" throw rather than a silent default-installation read.
   * Behaviourally identical to `getIssue` since both mint the per-repo client.
   */
  async getIssueForRepo(owner: string, repo: string, issueNumber: number): Promise<GithubIssueDto> {
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.issues.get({ owner, repo, issue_number: issueNumber });
    return toIssueDto(owner, repo, response.data as unknown as OctokitIssueLike);
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number): Promise<GithubPullRequestDto> {
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    const data = response.data as unknown as {
      number: number;
      state: string;
      merged: boolean;
      merged_at: string | null;
      merge_commit_sha?: string | null;
      html_url: string;
      draft?: boolean;
      mergeable?: boolean | null;
      head?: { ref?: string | null; sha?: string | null } | null;
      base?: { ref?: string | null } | null;
    };
    return {
      number: data.number,
      state: data.state === "closed" ? "closed" : "open",
      merged: Boolean(data.merged),
      mergedAt: data.merged_at ?? null,
      url: data.html_url,
      draft: Boolean(data.draft),
      mergeable: data.mergeable ?? null,
      // Carried unconditionally: `reopen_pull_request` needs to know WHICH
      // branch to probe, and this is the only field that says. It survives the
      // branch's deletion, which is why it is a name to check rather than proof
      // of existence.
      headRef: data.head?.ref ?? null,
      // Same reason as `headRef` above, one operation further on: a rebase
      // asked for by PR number replays onto the base THIS pull request
      // targets. Reading it here is what keeps that from defaulting to `main`.
      baseRef: data.base?.ref ?? null,
      headSha: data.head?.sha ?? null,
      // GitHub populates `merge_commit_sha` on an OPEN PR too, where it is the
      // test-merge commit rather than anything in the base branch's history.
      // Carrying that forward would give release-tracing a SHA to compare tags
      // against for a fix that has not landed, so it is dropped unless merged.
      mergeCommitSha: data.merged ? (data.merge_commit_sha ?? null) : null,
    };
  }

  /**
   * An issue read that carries `milestone` and `closed_at` (for the `issues` role).
   *
   * Deliberately NOT on the `GitHubProvider` interface — same reasoning as
   * `getReviewStatus` below: only release-tracing consumes it, and requiring it
   * on the interface would force every test double in the repo to grow an
   * implementation. `GitHubMutationGateway` passes it through so the capability
   * is reachable in production.
   */
  async getIssueDetail(owner: string, repo: string, issueNumber: number): Promise<GithubIssueDetailDto> {
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.issues.get({ owner, repo, issue_number: issueNumber });
    const data = response.data as unknown as {
      number: number;
      title: string;
      state: string;
      labels: Array<string | { name?: string }>;
      milestone?: { title?: string | null } | null;
      closed_at?: string | null;
      html_url: string;
    };
    return {
      number: data.number,
      title: data.title,
      state: data.state === "closed" ? "closed" : "open",
      labels: toLabelNames(data.labels),
      milestone: data.milestone?.title ?? null,
      closedAt: data.closed_at ?? null,
      url: data.html_url,
    };
  }

  /**
   * Every tag in the repository, most recent ref first.
   *
   * Paginated to `maxTags` because a long-lived repo can hold thousands and the
   * caller compares them one API call at a time. The list carries no dates —
   * `{name, commit:{sha}}` only — which is why the "tags created after the
   * merge" filter cannot be applied here and is derived from the comparison
   * status instead.
   */
  async listTags(owner: string, repo: string, maxTags = 100): Promise<GithubTagDto[]> {
    const tags: GithubTagDto[] = [];
    const perPage = Math.min(100, maxTags);
    const client = await this.getClientForRepo(owner, repo);
    for (let page = 1; tags.length < maxTags; page += 1) {
      const response = await client.rest.repos.listTags({ owner, repo, per_page: perPage, page });
      const batch = response.data as unknown as Array<{ name: string; commit: { sha: string } }>;
      if (batch.length === 0) break;
      for (const tag of batch) {
        tags.push({ name: tag.name, commitSha: tag.commit.sha });
      }
      if (batch.length < perPage) break;
    }
    return tags.slice(0, maxTags);
  }

  /**
   * `GET /compare/{base}...{head}` — the only server-side answer to "does this
   * ref's history contain this commit", since GitHub exposes no
   * `git tag --contains`.
   *
   * Returns `null` on 404 rather than throwing: a tag that has been deleted
   * between the list and the compare must skip one comparison, not fail the
   * whole release trace.
   */
  async compareCommits(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<GithubCommitComparisonDto | null> {
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${base}...${head}`,
      });
      const data = response.data as unknown as {
        status: string;
        ahead_by: number;
        behind_by: number;
      };
      return { status: data.status, aheadBy: data.ahead_by, behindBy: data.behind_by };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404) return null;
      throw error;
    }
  }

  /**
   * Reads what a pull request is actually waiting on: standing review verdicts,
   * check-run outcomes, and mergeability.
   *
   * Deliberately NOT on the `GitHubProvider` interface. Adding a required
   * method there would force every mutation gateway and test double to grow an
   * implementation for a capability only the escalation ladder consumes; this
   * lives on the concrete Octokit provider and satisfies
   * `PullRequestReviewPort` structurally at the point of use.
   *
   * Three reads, because GitHub splits the answer across three endpoints:
   * `pulls.get` carries draft/merged/mergeable, `pulls.listReviews` the review
   * verdicts, and `checks.listForRef` the CI outcomes for the head SHA.
   *
   * Check runs degrade to `[]` rather than throwing — a repo with no CI, or an
   * App installation without the Checks permission, must still yield review
   * data. A missing check list means "nothing known to be failing", and the
   * summariser treats an empty list as non-blocking.
   */
  async getReviewStatus(owner: string, repo: string, pullNumber: number): Promise<GithubPullRequestReviewStatusDto> {
    const client = await this.getClientForRepo(owner, repo);
    const prResponse = await client.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    const pr = prResponse.data as unknown as {
      number: number;
      html_url: string;
      state: string;
      draft?: boolean;
      merged?: boolean;
      mergeable?: boolean | null;
      title?: string;
      created_at?: string;
      updated_at?: string;
      user?: { login?: string | null } | null;
      head?: { sha?: string; ref?: string | null };
      base?: { ref?: string | null };
      requested_reviewers?: Array<{ login?: string | null }> | null;
      requested_teams?: Array<{ slug?: string | null }> | null;
    };

    const reviewsResponse = await client.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    const allReviews = [...reviewsResponse.data];
    for (let page = 2; allReviews.length === (page - 1) * 100; page++) {
      const next = await client.rest.pulls.listReviews({ owner, repo, pull_number: pullNumber, per_page: 100, page });
      allReviews.push(...next.data);
    }
    const reviews: GithubPullRequestReviewDto[] = allReviews
      .map((review): GithubPullRequestReviewDto | null => {
        const reviewer = review.user?.login;
        // A review with no resolvable author cannot be attributed to a
        // reviewer, and the summariser keys standing verdicts by reviewer.
        // Dropping it is safer than inventing an identity for it.
        if (!reviewer) return null;
        return {
          reviewer,
          commitId: review.commit_id ?? undefined,
          authorType: review.user?.type,
          authorAssociation: review.author_association,
          state: String(review.state).toUpperCase() as GithubPullRequestReviewState,
          // `submitted_at` is absent on a PENDING review; epoch keeps it
          // strictly older than any real review so it never wins the
          // "most recent decisive verdict" comparison.
          submittedAt: review.submitted_at ? new Date(review.submitted_at) : new Date(0),
        } satisfies GithubPullRequestReviewDto;
      })
      .filter((r): r is GithubPullRequestReviewDto => r !== null);

    let checks: GithubPullRequestCheckDto[] = [];
    let checksRead = false;
    const headSha = pr.head?.sha;
    if (headSha) {
      try {
        const checksResponse = await client.rest.checks.listForRef({
          owner,
          repo,
          ref: headSha,
          per_page: 100,
        });
        checks = checksResponse.data.check_runs.map((run) => ({
          name: run.name,
          status: run.status as GithubPullRequestCheckDto["status"],
          conclusion: (run.conclusion ?? null) as GithubPullRequestCheckDto["conclusion"],
        }));
        checksRead = true;
      } catch (err) {
        this.logger.warn(
          `Check runs unavailable for ${owner}/${repo}#${pullNumber}: ${err instanceof Error ? err.message : "unknown"}`,
          "OctokitGithubProvider",
        );
      }
    }

    const state: GithubPullRequestReviewStatusDto["state"] = pr.merged
      ? "merged"
      : pr.state === "closed"
        ? "closed"
        : "open";

    // Outstanding review requests. GitHub removes a reviewer from these lists
    // as soon as they submit a review, so what survives here is precisely
    // "asked, has not answered" — the signal a nudge needs in order to name a
    // real person instead of guessing one from a config file.
    const requestedReviewers = (pr.requested_reviewers ?? [])
      .map((r) => r.login)
      .filter((login): login is string => Boolean(login));
    const requestedTeams = (pr.requested_teams ?? [])
      .map((t) => t.slug)
      .filter((slug): slug is string => Boolean(slug));

    return {
      number: pr.number,
      url: pr.html_url,
      state,
      draft: Boolean(pr.draft),
      reviews,
      checks,
      requestedReviewers,
      requestedTeams,
      // Passed through unchanged, including null. Coercing null to false here
      // would report "has conflicts" for every PR GitHub has not finished
      // computing, which is the exact distinction the summariser relies on.
      mergeable: pr.mergeable ?? null,
      title: pr.title ?? "",
      createdAt: pr.created_at ?? "",
      updatedAt: pr.updated_at ?? "",
      authorLogin: pr.user?.login ?? null,
      headRef: pr.head?.ref ?? null,
      baseRef: pr.base?.ref ?? null,
      headSha: headSha ?? null,
      checksRead,
    };
  }

  /**
   * Lists pull requests in a repo. Read-only, not on `GitHubProvider` — same
   * precedent as `getReviewStatus`: one agent tool consumes this, and putting
   * it on the interface would force every test double to grow an
   * implementation. Goes through `getClientForRepo` so a listing of
   * `acme/web-app` does not 404 the way `getPullRequest` used to.
   */
  async listPullRequests(
    owner: string,
    repo: string,
    options: ListPullRequestsOptions = {},
  ): Promise<ListedPullRequestDto[]> {
    const client = await this.getClientForRepo(owner, repo);
    const perPage = Math.min(100, Math.max(1, options.perPage ?? 20));
    // GitHub wants `head` as `user:ref`. A bare branch name is not rejected —
    // it just matches nothing — so qualify it here rather than handing callers
    // a filter that silently returns an empty list.
    const head = options.head?.trim();
    const qualifiedHead = head ? (head.includes(":") ? head : `${owner}:${head}`) : undefined;
    const response = await client.rest.pulls.list({
      owner,
      repo,
      state: options.state ?? "open",
      sort: options.sort ?? "created",
      direction: options.direction ?? "asc",
      per_page: perPage,
      page: options.page ?? 1,
      ...(qualifiedHead ? { head: qualifiedHead } : {}),
      ...(options.base?.trim() ? { base: options.base.trim() } : {}),
    });
    const rows = (response.data ?? []) as unknown as Array<{
      number: number;
      title: string;
      html_url: string;
      state: string;
      draft?: boolean;
      user?: { login?: string | null } | null;
      created_at: string;
      updated_at: string;
      merged_at?: string | null;
      head?: { ref?: string | null };
      base?: { ref?: string | null };
    }>;
    return rows.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      state: pr.state === "closed" ? "closed" : "open",
      draft: Boolean(pr.draft),
      authorLogin: pr.user?.login ?? null,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      headRef: pr.head?.ref ?? null,
      baseRef: pr.base?.ref ?? null,
      mergedAt: pr.merged_at ?? null,
    }));
  }

  /**
   * Updates a PR's head branch with the latest from its base
   * (`PUT .../update-branch`). Does not merge the PR. 422s that mean
   * "already up to date" or "merge conflict" are returned as `{updated:false}`
   * rather than thrown — those are ordinary answers, not installation faults.
   */
  async updatePullRequestBranch(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<UpdatePullRequestBranchResult> {
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.pulls.updateBranch({
        owner,
        repo,
        pull_number: pullNumber,
      });
      const message =
        (response.data as { message?: string } | undefined)?.message ??
        `Updated the head branch of ${owner}/${repo}#${pullNumber} from its base.`;
      return { updated: true, message };
    } catch (error) {
      const status = errorStatus(error);
      const raw = error instanceof Error ? error.message : String(error);
      if (status === 422) {
        return { updated: false, message: raw };
      }
      if (status === 403 || status === 404) {
        throw toActionsPermissionError(
          owner,
          repo,
          "Contents:write and PullRequests:write",
          `update the branch of PR #${pullNumber}`,
        );
      }
      throw error;
    }
  }

  /**
   * Paginated deliberately, and loudly capped.
   *
   * GitHub's default page size is 30. Every caller of this method scans for the
   * *newest* marker comment — the QA board, PR evidence, closure receipts — so
   * an unpaginated call does not merely truncate: it freezes the search window
   * at the issue's first 30 comments and returns a stale record that looks
   * current. Checklist #2098 crossed 30 comments and the QA poller then spent
   * every sweep re-scoring an 18-day-old run, appending a comment each time and
   * pushing the live board further out of reach.
   *
   * The cap warns rather than silently truncating, because a silent truncation
   * is exactly the failure above wearing a larger number.
   */
  async listComments(owner: string, repo: string, issueNumber: number): Promise<GithubCommentDto[]> {
    const client = await this.getClientForRepo(owner, repo);
    const perPage = 100;
    const comments: GithubCommentDto[] = [];
    let page = 1;
    for (; page <= LIST_COMMENTS_MAX_PAGES; page += 1) {
      const response = await client.rest.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: perPage,
        page,
      });
      for (const comment of response.data) {
        comments.push({
          id: comment.id,
          authorLogin: comment.user?.login ?? null,
          body: comment.body ?? "",
          createdAt: comment.created_at,
        });
      }
      if (response.data.length < perPage) return comments;
    }
    this.logger.warn(
      `Comment list for ${owner}/${repo}#${issueNumber} hit the ${LIST_COMMENTS_MAX_PAGES}-page cap ` +
        `(${comments.length} comments); callers that look for the newest marker comment may be reading a stale one.`,
      "OctokitGithubProvider",
    );
    return comments;
  }

  /**
   * Edits an existing comment in place.
   *
   * Exists so a poller can keep one living board comment instead of appending a
   * new one on every sweep. Optional on the interface: a provider that cannot
   * edit simply omits it and callers fall back to `addComment`.
   */
  async updateComment(owner: string, repo: string, commentId: number, body: string): Promise<GithubCommentDto> {
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
    this.logger.log(`Updated comment ${commentId} on ${owner}/${repo}`, "OctokitGithubProvider");
    return {
      id: response.data.id,
      authorLogin: response.data.user?.login ?? null,
      body: response.data.body ?? "",
      createdAt: response.data.created_at,
    };
  }

  async addComment(owner: string, repo: string, issueNumber: number, body: string): Promise<GithubCommentDto> {
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
    this.logger.log(`Added comment to ${owner}/${repo}#${issueNumber}`, "OctokitGithubProvider");
    return {
      id: response.data.id,
      authorLogin: response.data.user?.login ?? null,
      body: response.data.body ?? "",
      createdAt: response.data.created_at,
    };
  }

  async addSubIssue(
    owner: string,
    repo: string,
    parentIssueNumber: number,
    childIssueId: number,
  ): Promise<void> {
    const client = await this.getClientForRepo(owner, repo);
    try {
      await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", {
        owner,
        repo,
        issue_number: parentIssueNumber,
        sub_issue_id: childIssueId,
      });
      this.logger.log(
        `Added sub-issue ${childIssueId} under ${owner}/${repo}#${parentIssueNumber}`,
        "OctokitGithubProvider",
      );
    } catch (error) {
      const status = (error as { status?: number }).status;
      const message = String((error as { message?: unknown }).message ?? "").toLowerCase();
      if (status === 422 && /already|duplicate|sub-issue/i.test(message)) {
        return;
      }
      throw error;
    }
  }

  /**
   * Records that `issueNumber` is BLOCKED BY the issue with `blockingIssueId`.
   *
   * GitHub's dependency API is one-directional on purpose: `blocked_by` is
   * writable and `blocking` is only the inverse view of it, so "A blocks B" is
   * expressed by posting B blocked_by A. Callers that phrase it the other way
   * round have to flip it themselves — there is no endpoint that would do it
   * for them.
   *
   * Takes the blocking issue's numeric **id**, not its number, exactly as
   * `addSubIssue` takes `childIssueId`. The two are easy to confuse and GitHub
   * accepts a plausible-looking wrong one, which is why the resolution from
   * number to id happens once, in the service, against `getIssue`.
   *
   * Swallows the 422 GitHub returns for a dependency that already exists,
   * following `addSubIssue` above: re-running a link that is already correct is
   * the normal case when a batch is retried, and it is not a failure.
   */
  async addIssueDependency(
    owner: string,
    repo: string,
    issueNumber: number,
    blockingIssueId: number,
  ): Promise<void> {
    const client = await this.getClientForRepo(owner, repo);
    try {
      await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by", {
        owner,
        repo,
        issue_number: issueNumber,
        issue_id: blockingIssueId,
      });
      this.logger.log(
        `Marked ${owner}/${repo}#${issueNumber} blocked by issue id ${blockingIssueId}`,
        "OctokitGithubProvider",
      );
    } catch (error) {
      const status = (error as { status?: number }).status;
      const message = String((error as { message?: unknown }).message ?? "").toLowerCase();
      if (status === 422 && /already|duplicate|dependenc/i.test(message)) {
        return;
      }
      throw error;
    }
  }

  async listSubIssues(owner: string, repo: string, parentIssueNumber: number): Promise<GithubIssueDto[]> {
    const client = await this.getClientForRepo(owner, repo);
    const collected: GithubIssueDto[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await client.request("GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", {
        owner,
        repo,
        issue_number: parentIssueNumber,
        per_page: 100,
        page,
      });
      const batch = (response.data ?? []) as unknown as OctokitIssueLike[];
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const issue of batch) {
        collected.push(toIssueDto(owner, repo, issue));
      }
      if (batch.length < 100) break;
    }
    return collected;
  }

  async listTimeline(owner: string, repo: string, issueNumber: number): Promise<GithubTimelineEventDto[]> {
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.issues.listEventsForTimeline({
      owner,
      repo,
      issue_number: issueNumber,
    });
    return response.data.map((event, index) => ({
      id: index,
      event: event.event ?? "unknown",
      actorLogin: (event as { actor?: { login?: string } }).actor?.login ?? null,
      createdAt: (event as { created_at?: string }).created_at ?? new Date().toISOString(),
      raw: event as unknown as Record<string, unknown>,
    }));
  }

  async listLinkedPullRequests(owner: string, repo: string, issueNumber: number): Promise<LinkedPullRequestDto[]> {
    const timeline = await this.listTimeline(owner, repo, issueNumber);
    const prs: LinkedPullRequestDto[] = [];
    for (const event of timeline) {
      if (event.event === "cross-referenced" || event.event === "connected") {
        const source = (event.raw as { source?: { issue?: Record<string, unknown> } }).source?.issue;
        if (source && "pull_request" in source) {
          prs.push({
            number: source["number"] as number,
            url: source["html_url"] as string,
            state: (source["state"] as string) === "closed"
              ? ((source["pull_request"] as { merged_at?: string | null })?.merged_at ? "merged" : "closed")
              : "open",
            merged: Boolean((source["pull_request"] as { merged_at?: string | null })?.merged_at),
            title: source["title"] as string,
          });
        }
      }
    }
    return prs;
  }

  async setLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<string[]> {
    const unique = Array.from(new Set(labels));
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.issues.setLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: unique,
    });
    this.logger.log(`Set labels [${unique.join(", ")}] on ${owner}/${repo}#${issueNumber}`, "OctokitGithubProvider");
    return toLabelNames(response.data as unknown as Array<{ name?: string }>);
  }

  async addLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<string[]> {
    if (labels.length === 0) {
      const current = await this.getIssue(owner, repo, issueNumber);
      return current.labels;
    }
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels,
    });
    return toLabelNames(response.data as unknown as Array<{ name?: string }>);
  }

  async removeLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void> {
    const client = await this.getClientForRepo(owner, repo);
    for (const label of labels) {
      try {
        await client.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label });
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 404) {
          throw error;
        }
        // Label already absent: idempotent no-op.
      }
    }
  }

  async assignUsers(owner: string, repo: string, issueNumber: number, assignees: string[]): Promise<string[]> {
    const current = await this.getIssue(owner, repo, issueNumber);
    const target = new Set(assignees);
    const currentSet = new Set(current.assignees);

    const toAdd = assignees.filter((a) => !currentSet.has(a));
    const toRemove = current.assignees.filter((a) => !target.has(a));

    const client = await this.getClientForRepo(owner, repo);
    if (toAdd.length > 0) {
      await client.rest.issues.addAssignees({ owner, repo, issue_number: issueNumber, assignees: toAdd });
    }
    if (toRemove.length > 0) {
      await client.rest.issues.removeAssignees({ owner, repo, issue_number: issueNumber, assignees: toRemove });
    }

    const refreshed = await this.getIssue(owner, repo, issueNumber);
    this.logger.log(
      `Assigned [${refreshed.assignees.join(", ")}] on ${owner}/${repo}#${issueNumber}`,
      "OctokitGithubProvider",
    );
    return refreshed.assignees;
  }

  async closeIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    reason: "completed" | "not_planned" = "completed",
  ): Promise<GithubIssueDto> {
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      state: "closed",
      state_reason: reason,
    });
    return toIssueDto(owner, repo, response.data as unknown as OctokitIssueLike);
  }

  async reopenIssue(owner: string, repo: string, issueNumber: number): Promise<GithubIssueDto> {
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      state: "open",
    });
    return toIssueDto(owner, repo, response.data as unknown as OctokitIssueLike);
  }

  /**
   * Appends `Fixes owner/repo#N` to a PR body when that closing keyword is
   * missing. Closing keywords only work in the PR title/body (not comments)
   * and only for an issue in the same org as the PR — the caller chooses the
   * ref. Uses `getClientForRepo` because the PR lives in a product repo, which
   * may be a different org than the primary installation.
   */
  async appendPullRequestClosingRef(
    owner: string,
    repo: string,
    pullNumber: number,
    issueRef: string,
  ): Promise<void> {
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    const current = typeof response.data.body === "string" ? response.data.body : "";
    const closingLine = `Fixes ${issueRef}`;
    if (bodyAlreadyCloses(current, issueRef)) return;
    const body = current.trim().length > 0 ? `${current.trimEnd()}\n\n${closingLine}\n` : `${closingLine}\n`;
    await client.rest.pulls.update({ owner, repo, pull_number: pullNumber, body });
  }

  async closePullRequest(owner: string, repo: string, pullNumber: number): Promise<GithubPullRequestDto> {
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.pulls.update({
      owner,
      repo,
      pull_number: pullNumber,
      state: "closed",
    });
    const data = response.data as unknown as {
      number: number;
      state: string;
      merged: boolean;
      merged_at: string | null;
      html_url: string;
    };
    return {
      number: data.number,
      state: data.state === "closed" ? "closed" : "open",
      merged: Boolean(data.merged),
      mergedAt: data.merged_at ?? null,
      url: data.html_url,
    };
  }

  async updatePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    changes: { title?: string; body?: string },
  ): Promise<GithubPullRequestDto> {
    const client = await this.getClientForRepo(owner, repo);
    // `state` is deliberately absent from the payload: omitting it leaves the
    // PR open or closed exactly as it was. Sending one would make an edit
    // silently reopen a closed PR.
    const response = await client.rest.pulls.update({
      owner,
      repo,
      pull_number: pullNumber,
      ...(changes.title === undefined ? {} : { title: changes.title }),
      ...(changes.body === undefined ? {} : { body: changes.body }),
    });
    const data = response.data as unknown as {
      number: number;
      state: string;
      merged: boolean;
      merged_at: string | null;
      html_url: string;
    };
    return {
      number: data.number,
      state: data.state === "closed" ? "closed" : "open",
      merged: Boolean(data.merged),
      mergedAt: data.merged_at ?? null,
      url: data.html_url,
    };
  }

  async reopenPullRequest(owner: string, repo: string, pullNumber: number): Promise<GithubPullRequestDto> {
    const client = await this.getClientForRepo(owner, repo);
    const response = await client.rest.pulls.update({
      owner,
      repo,
      pull_number: pullNumber,
      state: "open",
    });
    const data = response.data as unknown as {
      number: number;
      state: string;
      merged: boolean;
      merged_at: string | null;
      html_url: string;
    };
    return {
      number: data.number,
      state: data.state === "closed" ? "closed" : "open",
      merged: Boolean(data.merged),
      mergedAt: data.merged_at ?? null,
      url: data.html_url,
    };
  }

  /**
   * Whether `branch` exists on the remote, via `GET /git/ref/heads/{branch}`.
   *
   * A dedicated probe rather than a field read, because the pull-request payload
   * cannot answer this: GitHub keeps `head.ref` on a PR after the branch is
   * deleted (it is recorded on the PR, not resolved from the repo), so a present
   * `head.ref` is not evidence the ref still exists. The ref endpoint is the
   * thing that actually knows, and it answers 404 when the branch is gone.
   *
   * Returns `false` for 404 — "gone" is an ordinary answer here, exactly as it
   * is for `getFileContents`, and a caller asking whether a branch exists should
   * not have to catch an exception to find out. Anything else (403, 5xx, network)
   * is rethrown: that is "could not look", which callers must not read as "gone".
   */
  async branchExists(owner: string, repo: string, branch: string): Promise<boolean> {
    try {
      const client = await this.getClientForRepo(owner, repo);
      await client.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
      return true;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404) return false;
      throw error;
    }
  }

  /**
   * See `resolveRef` on the interface. Order matters: branch, then tag, then
   * raw commit. A name that is both a branch and a tag resolves to the branch,
   * which is what someone naming `main` or a release branch means.
   */
  async resolveRef(
    owner: string,
    repo: string,
    options: { ref?: string; submodulePath?: string } = {},
  ): Promise<ResolvedRefDto | null> {
    const client = await this.getClientForRepo(owner, repo);
    const submodulePath = options.submodulePath?.trim();

    if (submodulePath) {
      try {
        const response = await client.rest.repos.getContent({
          owner,
          repo,
          path: submodulePath,
          ...(options.ref?.trim() ? { ref: options.ref.trim() } : {}),
        });
        const entry = response.data as { type?: string; sha?: string; submodule_git_url?: string };
        // A path that exists but is a file or directory is not a gitlink;
        // returning its blob sha would hand the caller a value that looks like
        // a commit and is not one.
        if (entry.type !== "submodule" || !entry.sha) return null;
        return {
          requested: submodulePath,
          sha: entry.sha,
          kind: "submodule",
          ...(entry.submodule_git_url ? { submoduleUrl: entry.submodule_git_url } : {}),
        };
      } catch (error) {
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
    }

    const ref = options.ref?.trim() || (await this.defaultBranchFor(owner, repo, client));
    if (!ref) return null;

    for (const [prefix, kind] of [
      ["heads/", "branch"],
      ["tags/", "tag"],
    ] as const) {
      try {
        const response = await client.rest.git.getRef({ owner, repo, ref: `${prefix}${ref}` });
        const sha = (response.data as { object?: { sha?: string } }).object?.sha;
        if (sha) return { requested: ref, sha, kind };
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
      }
    }

    // Not a branch or tag — it may already be a commit. Confirming it exists
    // matters more than the round trip: returning an unverified string would
    // let a typo reach `update_submodule_pointer` and commit a dangling gitlink.
    try {
      const response = await client.rest.git.getCommit({ owner, repo, commit_sha: ref });
      const sha = (response.data as { sha?: string }).sha;
      return sha ? { requested: ref, sha, kind: "commit" } : null;
    } catch (error) {
      const status = (error as { status?: number }).status;
      // 422 is GitHub's answer for a string that is not a valid object id.
      if (status === 404 || status === 422) return null;
      throw error;
    }
  }

  private async defaultBranchFor(
    owner: string,
    repo: string,
    client: Awaited<ReturnType<typeof this.getClientForRepo>>,
  ): Promise<string | null> {
    try {
      const response = await client.rest.repos.get({ owner, repo });
      return (response.data as { default_branch?: string }).default_branch ?? null;
    } catch (error) {
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  }

  async dispatchWorkflow(
    owner: string,
    repo: string,
    workflowFile: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<void> {
    try {
      const client = await this.getClientForRepo(owner, repo);
      await client.rest.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: workflowFile,
        ref,
        inputs,
      });
      this.logger.log(`Dispatched ${workflowLabel(workflowFile)} on ${owner}/${repo}@${ref}`, "OctokitGithubProvider");
    } catch (error) {
      if (isMissingActionsPermission(error)) {
        throw toActionsPermissionError(owner, repo, "Actions:write", `dispatch ${workflowLabel(workflowFile)}`);
      }
      throw error;
    }
  }

  async findDispatchedRun(
    owner: string,
    repo: string,
    workflowFile: string,
    since: Date,
    excludeRunIds?: readonly number[],
    nameContains?: string,
  ): Promise<DispatchedWorkflowRun | null> {
    let runs: Array<{
      id: number;
      html_url: string;
      status: string | null;
      event?: string;
      created_at: string;
      name?: string | null;
      display_title?: string | null;
    }>;
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: workflowFile,
        event: "workflow_dispatch",
        created: `>=${since.toISOString()}`,
        per_page: 20,
      });
      runs = (response.data.workflow_runs ?? []) as unknown as typeof runs;
    } catch (error) {
      if (isMissingActionsPermission(error)) {
        throw toActionsPermissionError(owner, repo, "Actions:read", `list runs for ${workflowLabel(workflowFile)}`);
      }
      throw error;
    }

    const sinceMs = since.getTime();
    const excluded = new Set(excludeRunIds ?? []);
    const needle = nameContains?.trim() ?? "";
    const candidates = runs
      .filter((run) => {
        if (new Date(run.created_at).getTime() < sinceMs || excluded.has(run.id)) return false;
        if (needle && !workflowRunNameIncludes(workflowRunDisplayName(run), needle)) return false;
        return true;
      })
      // Earliest-first, not latest-first: a run this dispatch caused should
      // register with the Actions API within seconds of `since`, well
      // before a later, unrelated dispatch's run does. Picking "latest"
      // instead would systematically prefer a more recent, different
      // attempt's run over this attempt's own — see DispatchedWorkflowRun's
      // docstring. When `nameContains` is set, that title match is the
      // load-bearing filter; earliest-first only breaks ties.
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    const earliest = candidates[0];
    if (!earliest) return null;

    return {
      runId: earliest.id,
      runUrl: earliest.html_url,
      status: earliest.status ?? "unknown",
    };
  }

  /**
   * The most recent runs of one workflow, newest first, whatever started
   * them. `findDispatchedRun` answers "which run did MY dispatch cause"; this
   * answers "is anything of this workflow running right now", which is what a
   * self-chaining loop needs before it is started again. Not on
   * `GitHubProvider` — one consumer, the getReviewStatus precedent.
   */
  async listWorkflowRuns(
    owner: string,
    repo: string,
    workflowFile: string,
    options: { perPage?: number } = {},
  ): Promise<GithubWorkflowRunDto[]> {
    let runs: Array<{
      id: number;
      html_url: string;
      status: string | null;
      conclusion: string | null;
      name?: string | null;
      display_title?: string | null;
      event?: string | null;
      head_sha?: string | null;
      created_at?: string | null;
      updated_at?: string | null;
    }>;
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: workflowFile,
        per_page: Math.min(100, Math.max(1, options.perPage ?? 20)),
      });
      runs = (response.data.workflow_runs ?? []) as unknown as typeof runs;
    } catch (error) {
      if (isMissingActionsPermission(error)) {
        throw toActionsPermissionError(owner, repo, "Actions:read", `list runs for ${workflowLabel(workflowFile)}`);
      }
      throw error;
    }
    return runs.map((run) => ({
      runId: run.id,
      runUrl: run.html_url,
      status: run.status ?? "unknown",
      conclusion: run.conclusion ?? null,
      logVerdict: null,
      name: run.name ?? null,
      displayTitle: run.display_title ?? null,
      event: run.event ?? null,
      headSha: run.head_sha ?? null,
      createdAt: run.created_at ?? null,
      updatedAt: run.updated_at ?? null,
    }));
  }

  /**
   * The repository's default branch, read live. An empty repository still has
   * one (GitHub reports the org default), which is why this does not go
   * through `resolveRef`: that needs the branch to exist. Null on 404.
   */
  async getDefaultBranch(owner: string, repo: string): Promise<string | null> {
    const client = await this.getClientForRepo(owner, repo);
    return this.defaultBranchFor(owner, repo, client);
  }

  async getWorkflowRun(
    owner: string,
    repo: string,
    runId: number,
    options?: { includeLogVerdict?: boolean },
  ): Promise<GithubWorkflowRunDto | null> {
    const client = await this.getClientForRepo(owner, repo);
    let run: {
      id: number;
      html_url: string;
      status: string | null;
      conclusion: string | null;
      name?: string | null;
      display_title?: string | null;
      event?: string | null;
      head_sha?: string | null;
      path?: string; head_branch?: string; run_attempt?: number;
      repository?: { full_name?: string }; head_repository?: { full_name?: string };
      created_at?: string | null;
      updated_at?: string | null;
    };
    try {
      const response = await client.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
      run = response.data as unknown as typeof run;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 404) return null;
      if (isMissingActionsPermission(error)) {
        throw toActionsPermissionError(owner, repo, "Actions:read", `read run ${runId}`);
      }
      throw error;
    }

    const dto: GithubWorkflowRunDto = {
      runId: run.id,
      runUrl: run.html_url,
      status: run.status ?? "unknown",
      conclusion: run.conclusion ?? null,
      logVerdict: null,
      name: run.name ?? null,
      displayTitle: run.display_title ?? null,
      event: run.event ?? null,
      headSha: run.head_sha ?? null,
      workflowPath: run.path, headBranch: run.head_branch, runAttempt: run.run_attempt,
      repositoryFullName: run.repository?.full_name, headRepositoryFullName: run.head_repository?.full_name,
      createdAt: run.created_at ?? null,
      updatedAt: run.updated_at ?? null,
    };
    if (run.status !== "completed" || options?.includeLogVerdict === false) return dto;

    let jobs: Array<{ id: number }>;
    try {
      const response = await client.rest.actions.listJobsForWorkflowRun({ owner, repo, run_id: runId });
      jobs = (response.data.jobs ?? []) as unknown as Array<{ id: number }>;
    } catch (error) {
      if (isMissingActionsPermission(error)) {
        throw toActionsPermissionError(owner, repo, "Actions:read", `list jobs for run ${runId}`);
      }
      return dto;
    }

    for (const job of jobs) {
      try {
        const response = await client.rest.actions.downloadJobLogsForWorkflowRun({
          owner,
          repo,
          job_id: job.id,
        });
        const log = stripLogTimestamps(
          typeof response.data === "string" ? response.data : String(response.data ?? ""),
        );
        const match = log.match(QA_LOG_VERDICT_PATTERN);
        if (match && (match[1] === "PASS" || match[1] === "FAIL" || match[1] === "INFRA" || match[1] === "NEEDS_REVIEW")) {
          dto.logVerdict = match[1];
          return dto;
        }
      } catch {
        continue;
      }
    }
    return dto;
  }

  async searchCode(owner: string, repo: string, query: string, perPage = 10): Promise<CodeSearchMatchDto[]> {
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.search.code({
        q: `${query} repo:${owner}/${repo}`,
        per_page: perPage,
        headers: { accept: "application/vnd.github.text-match+json" },
      });
      const items = (response.data.items ?? []) as unknown as Array<{
        path: string;
        html_url: string;
        text_matches?: Array<{ fragment?: string }>;
      }>;
      return items.map((item) => ({
        path: item.path,
        url: item.html_url,
        snippets: (item.text_matches ?? []).map((m) => m.fragment).filter((s): s is string => Boolean(s)),
      }));
    } catch (error) {
      if (isMissingActionsPermission(error)) {
        throw toActionsPermissionError(owner, repo, "Contents:read", `search code in`);
      }
      throw error;
    }
  }

  /**
   * Note the split handling of 403 vs 404, which the other methods on this
   * class lump together via `isMissingActionsPermission`: here a 404 is a
   * legitimate "no such path" answer and must return null, so only a 403 is
   * reported as a permission problem. The cost of that split is that a 404
   * caused by the App not seeing the repo at all also returns null instead of
   * a pointed error — accepted deliberately, because the alternative (raising
   * on every missing file) would make the common case unusable.
   */
  async getFileContents(owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
    let data: unknown;
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.repos.getContent({ owner, repo, path, ref });
      data = response.data;
    } catch (error) {
      if (errorStatus(error) === 404) {
        return null;
      }
      if (errorStatus(error) === 403) {
        throw toActionsPermissionError(owner, repo, "Contents:read", `read ${path}`);
      }
      throw error;
    }

    // A directory listing comes back as an array; there is no single file to
    // decode, so this is "nothing to read" rather than an error.
    if (Array.isArray(data)) {
      this.logger.warn(
        `${owner}/${repo}:${path} is a directory, not a file — returning null`,
        "OctokitGithubProvider",
      );
      return null;
    }

    const file = data as { type?: string; encoding?: string; content?: string };
    if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string") {
      // GitHub returns `encoding: "none"` with an empty `content` for files
      // past its inline size ceiling, and `type: "submodule"`/"symlink" for
      // things that are not readable text. Returning "" here would claim the
      // file is empty, which is a different and wrong answer.
      this.logger.warn(
        `${owner}/${repo}:${path} has no inline readable content (type=${file.type ?? "?"}, ` +
          `encoding=${file.encoding ?? "?"}) — returning null`,
        "OctokitGithubProvider",
      );
      return null;
    }

    return Buffer.from(file.content, "base64").toString("utf8");
  }

  /**
   * File read that survives GitHub's ~1MB inline ceiling.
   * `getFileContents` above deliberately answers null for oversized files —
   * the right refusal for bounded readers like repo-doc chunking. This
   * variant falls back to the git blob (good to 100MB) using the sha the
   * contents API still reports when it omits the content. Same 404→null /
   * 403→named-permission semantics as its siblings.
   */
  async getLargeFileContents(owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
    const inline = await this.getFileContents(owner, repo, path, ref);
    if (inline !== null) return inline;

    let data: unknown;
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.repos.getContent({ owner, repo, path, ref });
      data = response.data;
    } catch (error) {
      if (errorStatus(error) === 404) return null;
      if (errorStatus(error) === 403) {
        throw toActionsPermissionError(owner, repo, "Contents:read", `read ${path}`);
      }
      throw error;
    }
    if (Array.isArray(data)) return null;
    const file = data as { type?: string; sha?: string };
    if (file.type !== "file" || typeof file.sha !== "string" || file.sha.length === 0) return null;
    return this.getBlob(owner, repo, file.sha, LARGE_FILE_DECODE_CAP_BYTES);
  }

  /**
   * Blob SHA of a file — the change-detection key for large-file snapshots.
   * Works at any size: the contents API reports `sha` even when it omits the
   * content past its inline ceiling. 404 → null, same as its siblings.
   */
  async getFileSha(owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
    let data: unknown;
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.repos.getContent({ owner, repo, path, ref });
      data = response.data;
    } catch (error) {
      if (errorStatus(error) === 404) return null;
      if (errorStatus(error) === 403) {
        throw toActionsPermissionError(owner, repo, "Contents:read", `read ${path}`);
      }
      throw error;
    }
    if (Array.isArray(data)) return null;
    const file = data as { type?: string; sha?: string };
    return file.type === "file" && typeof file.sha === "string" && file.sha.length > 0 ? file.sha : null;
  }

  /**
   * Same 403/404 split as `getFileContents`: a missing path (or a repo this
   * App cannot see) is an empty listing, not an exception. Only a 403 is a
   * permission problem. The listing is metadata only — path/type/size/sha —
   * because the whole point of this method is to enumerate a tree that
   * `getFileContents` cannot read as a file.
   *
   * A repo-wide listing uses the recursive git-trees API. A `path` uses
   * `repos.getContent` for that directory (one level). Both are capped;
   * overflow sets `truncated` rather than dropping entries silently.
   */
  async getTree(owner: string, repo: string, path?: string, ref?: string): Promise<GithubTreeResult> {
    const empty: GithubTreeResult = { entries: [], truncated: false };
    const normalised = (path ?? "").replace(/^\/+|\/+$/g, "");
    const client = await this.getClientForRepo(owner, repo);

    try {
      if (normalised) {
        return await this.listDirectoryTree(client, owner, repo, normalised, ref);
      }
      return await this.listRecursiveRepoTree(client, owner, repo, ref);
    } catch (error) {
      if (errorStatus(error) === 404) {
        return empty;
      }
      if (errorStatus(error) === 403) {
        throw toActionsPermissionError(
          owner,
          repo,
          "Contents:read",
          `list tree${normalised ? ` at ${normalised}` : ""}`,
        );
      }
      throw error;
    }
  }

  private async listRecursiveRepoTree(
    client: Octokit,
    owner: string,
    repo: string,
    ref: string | undefined,
  ): Promise<GithubTreeResult> {
    // git.getTree wants a SHA or a ref name. When the caller omitted `ref`,
    // resolve HEAD rather than guessing `main` — a wrong default would list
    // the wrong tree and look like a complete answer.
    let treeSha = ref;
    if (!treeSha) {
      const commit = await client.rest.repos.getCommit({ owner, repo, ref: "HEAD" });
      treeSha = commit.data.sha;
    }

    const response = await client.rest.git.getTree({
      owner,
      repo,
      tree_sha: treeSha,
      recursive: "true",
    });
    const raw = (response.data.tree ?? []) as Array<{
      path?: string;
      type?: string;
      size?: number;
      sha?: string;
    }>;
    const mapped: GithubTreeEntry[] = [];
    for (const node of raw) {
      if (node.type !== "blob" && node.type !== "tree") continue;
      if (typeof node.path !== "string" || typeof node.sha !== "string") continue;
      mapped.push({
        path: node.path,
        type: node.type,
        size: typeof node.size === "number" ? node.size : null,
        sha: node.sha,
      });
      if (mapped.length >= TREE_ENTRY_CAP) break;
    }
    const githubTruncated = Boolean((response.data as { truncated?: boolean }).truncated);
    return {
      entries: mapped,
      // Skipping a submodule (`type: "commit"`) is not truncation — it was
      // never a blob or tree. Only GitHub's own cut, or our cap, counts.
      truncated: githubTruncated || mapped.length >= TREE_ENTRY_CAP,
    };
  }

  private async listDirectoryTree(
    client: Octokit,
    owner: string,
    repo: string,
    path: string,
    ref: string | undefined,
  ): Promise<GithubTreeResult> {
    const response = await client.rest.repos.getContent({ owner, repo, path, ref });
    const data = response.data;

    const items = Array.isArray(data) ? data : [data];
    const mapped: GithubTreeEntry[] = [];
    for (const item of items) {
      const entry = item as { type?: string; path?: string; name?: string; sha?: string; size?: number };
      const type = entry.type === "file" ? "blob" : entry.type === "dir" ? "tree" : null;
      if (!type) continue;
      const entryPath = typeof entry.path === "string" ? entry.path : entry.name;
      if (typeof entryPath !== "string" || typeof entry.sha !== "string") continue;
      mapped.push({
        path: entryPath,
        type,
        size: type === "blob" && typeof entry.size === "number" ? entry.size : null,
        sha: entry.sha,
      });
      if (mapped.length >= TREE_ENTRY_CAP) break;
    }
    return {
      entries: mapped,
      truncated: mapped.length >= TREE_ENTRY_CAP,
    };
  }

  /**
   * Same 403/404 split as `getFileContents`. Binary and oversize blobs return
   * null rather than a guess: `Buffer.toString("utf8")` would replace invalid
   * sequences with U+FFFD and look like a successful read of text that is
   * not in the blob.
   *
   * `maxBytes` defaults to the conservative 512 KiB cap, so an incidental
   * source-file read still cannot pull an unbounded blob into memory. Callers
   * that exist specifically to read a big document raise it deliberately.
   */
  async getBlob(
    owner: string,
    repo: string,
    sha: string,
    maxBytes: number = BLOB_DECODE_CAP_BYTES,
  ): Promise<string | null> {
    let data: { content?: string; encoding?: string; size?: number };
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.git.getBlob({ owner, repo, file_sha: sha });
      data = response.data as typeof data;
    } catch (error) {
      if (errorStatus(error) === 404) {
        return null;
      }
      if (errorStatus(error) === 403) {
        throw toActionsPermissionError(owner, repo, "Contents:read", `read blob ${sha}`);
      }
      throw error;
    }

    if (typeof data.content !== "string" || data.encoding !== "base64") {
      this.logger.warn(
        `${owner}/${repo} blob ${sha} has no base64 content (encoding=${data.encoding ?? "?"}) — returning null`,
        "OctokitGithubProvider",
      );
      return null;
    }

    const buf = Buffer.from(data.content, "base64");
    // Cap on the decoded bytes, not the base64 length: a 512 KiB file is
    // what the caller asked for, and returning a prefix would claim the
    // blob ended there.
    if (buf.length > maxBytes) {
      this.logger.warn(
        `${owner}/${repo} blob ${sha} is ${buf.length} bytes, over the ${maxBytes} decode cap — returning null`,
        "OctokitGithubProvider",
      );
      return null;
    }
    if (buf.includes(0)) {
      return null;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      return null;
    }
  }

  /**
   * Same 403/404 split as `getFileContents`: a run this App cannot see is an
   * empty list, not an Actions-permission lecture. Only a 403 is reported as
   * missing Actions:read.
   */
  async listWorkflowRunArtifacts(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<GithubWorkflowArtifact[]> {
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.actions.listWorkflowRunArtifacts({
        owner,
        repo,
        run_id: runId,
        per_page: 100,
      });
      const artifacts = (response.data.artifacts ?? []) as Array<{
        id: number;
        name: string;
        size_in_bytes: number;
        expired: boolean;
        archive_download_url?: string | null;
      }>;
      return artifacts.map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        sizeInBytes: artifact.size_in_bytes,
        expired: Boolean(artifact.expired),
        ...(typeof artifact.archive_download_url === "string"
          ? { archiveDownloadUrl: artifact.archive_download_url }
          : {}),
      }));
    } catch (error) {
      if (errorStatus(error) === 404) {
        return [];
      }
      if (errorStatus(error) === 403) {
        throw toActionsPermissionError(owner, repo, "Actions:read", `list artifacts for run ${runId}`);
      }
      throw error;
    }
  }

  /**
   * Splits 403 from 404 for the same reason `getPullRequestFiles` does: the
   * common 404 is a wrong artifact id, and telling that caller the App is
   * missing Actions:read sends them debugging an installation that is fine.
   */
  async downloadWorkflowRunArtifact(owner: string, repo: string, artifactId: number): Promise<Buffer> {
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.actions.downloadArtifact({
        owner,
        repo,
        artifact_id: artifactId,
        archive_format: "zip",
      });
      return artifactBytesToBuffer(response.data);
    } catch (error) {
      if (errorStatus(error) === 404) {
        throw new Error(
          `Artifact ${artifactId} on ${owner}/${repo} was not found. Check the id and repo — note GitHub also ` +
            `answers 404 for a repo the calling GitHub App cannot see, so this is not proof the artifact does not exist.`,
        );
      }
      if (errorStatus(error) === 403) {
        throw toActionsPermissionError(owner, repo, "Actions:read", `download artifact ${artifactId}`);
      }
      throw error;
    }
  }

  async listWorkflowRunJobs(owner: string, repo: string, runId: number): Promise<GithubWorkflowJobDto[]> {
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: runId,
        per_page: 100,
      });
      const jobs = (response.data.jobs ?? []) as Array<{
        id: number;
        name: string;
        status: string | null;
        conclusion: string | null;
        html_url: string;
        started_at: string | null;
        completed_at: string | null;
        steps?: Array<{
          number: number;
          name: string;
          status: string | null;
          conclusion: string | null;
          started_at?: string | null;
          completed_at?: string | null;
        }>;
      }>;
      return jobs.map((job) => ({
        jobId: job.id,
        name: job.name,
        status: job.status ?? "unknown",
        conclusion: job.conclusion ?? null,
        htmlUrl: job.html_url,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        ...(Array.isArray(job.steps)
          ? {
              steps: job.steps.map((step) => ({
                number: step.number,
                name: step.name,
                status: step.status ?? "unknown",
                conclusion: step.conclusion ?? null,
                startedAt: step.started_at ?? null,
                completedAt: step.completed_at ?? null,
              })),
            }
          : {}),
      }));
    } catch (error) {
      if (errorStatus(error) === 404) return [];
      if (errorStatus(error) === 403) {
        throw toActionsPermissionError(owner, repo, "Actions:read", `list jobs for run ${runId}`);
      }
      throw error;
    }
  }

  async downloadWorkflowJobLogs(owner: string, repo: string, jobId: number): Promise<string> {
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.actions.downloadJobLogsForWorkflowRun({
        owner,
        repo,
        job_id: jobId,
      });
      const raw = typeof response.data === "string" ? response.data : String(response.data ?? "");
      return stripLogTimestamps(raw);
    } catch (error) {
      if (errorStatus(error) === 404) {
        throw new Error(
          `Job ${jobId} on ${owner}/${repo} was not found. Check the id and repo — note GitHub also ` +
            `answers 404 for a repo the calling GitHub App cannot see.`,
        );
      }
      if (errorStatus(error) === 403) {
        throw toActionsPermissionError(owner, repo, "Actions:read", `download logs for job ${jobId}`);
      }
      throw error;
    }
  }

  async cancelWorkflowRun(owner: string, repo: string, runId: number): Promise<void> {
    try {
      const client = await this.getClientForRepo(owner, repo);
      await client.rest.actions.cancelWorkflowRun({ owner, repo, run_id: runId });
    } catch (error) {
      if (errorStatus(error) === 409) {
        throw new Error(`Run ${runId} on ${owner}/${repo} cannot be cancelled (already completed).`);
      }
      if (errorStatus(error) === 404) {
        throw new Error(
          `Run ${runId} on ${owner}/${repo} was not found. Check the id and repo — note GitHub also ` +
            `answers 404 for a repo the calling GitHub App cannot see.`,
        );
      }
      if (errorStatus(error) === 403) {
        throw toActionsPermissionError(owner, repo, "Actions:write", `cancel run ${runId}`);
      }
      throw error;
    }
  }

  /**
   * Splits 403 from 404 for the same reason `getFileContents` does, rather
   * than lumping both into a permission error the way the Actions methods
   * above do: the overwhelmingly common cause of a 404 here is a PR number
   * that does not exist (a typo, or a number belonging to a different repo),
   * and telling that reader the App is missing Contents:read sends them off
   * debugging an installation that is fine. A 403 is still reported as a
   * permission problem.
   *
   * Same caveat as `getFileContents`: GitHub also answers 404 for a repo the
   * calling App cannot see, so "pull request not found" means "not visible to
   * this installation" and is not proof the PR does not exist.
   */
  async getPullRequestFiles(owner: string, repo: string, pullNumber: number): Promise<PullRequestFileDto[]> {
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });
      const files = (response.data ?? []) as unknown as Array<{
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        changes: number;
        patch?: string;
      }>;
      return files.map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        // Spread rather than `patch: file.patch`: when GitHub omits the diff
        // (binary/oversized file) the key stays absent instead of becoming an
        // explicit `undefined`, so the DTO says "no diff supplied" rather than
        // implying an empty one.
        ...(typeof file.patch === "string" ? { patch: file.patch } : {}),
      }));
    } catch (error) {
      if (errorStatus(error) === 404) {
        throw new Error(
          `Pull request ${owner}/${repo}#${pullNumber} was not found. Check the number and repo — note GitHub also ` +
            `answers 404 for a repo the calling GitHub App cannot see, so this is not proof the PR does not exist.`,
        );
      }
      if (errorStatus(error) === 403) {
        throw toActionsPermissionError(owner, repo, "Contents:read", `list files for PR #${pullNumber}`);
      }
      throw error;
    }
  }

  async createPullRequest(
    owner: string,
    repo: string,
    options: CreatePullRequestOptions,
  ): Promise<CreatedPullRequestDto> {
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.pulls.create({
        owner,
        repo,
        title: options.title,
        head: options.head,
        base: options.base,
        body: options.body,
        draft: options.draft,
      });
      const data = response.data as unknown as {
        number: number;
        state: string;
        merged?: boolean;
        merged_at: string | null;
        html_url: string;
        draft?: boolean;
      };
      this.logger.log(
        `Opened PR ${owner}/${repo}#${data.number} (${options.head} -> ${options.base})`,
        "OctokitGithubProvider",
      );
      return {
        number: data.number,
        state: data.state === "closed" ? "closed" : "open",
        merged: Boolean(data.merged),
        mergedAt: data.merged_at ?? null,
        url: data.html_url,
        draft: Boolean(data.draft),
      };
    } catch (error) {
      if (isMissingActionsPermission(error)) {
        throw toActionsPermissionError(
          owner,
          repo,
          "Contents:write and PullRequests:write",
          `open a pull request`,
        );
      }
      throw error;
    }
  }

  /**
   * Merges an open PR into its current base (`PUT .../pulls/{n}/merge`).
   * Always uses GitHub's `merge` method — never rebase, never squash — matching
   * the nested-stack procedure. The caller supplies `sha` so a race
   * against a new push is a 409 rather than a silent wrong-tip merge.
   */
  async mergePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    options: MergePullRequestOptions = {},
  ): Promise<MergedPullRequestDto> {
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.pulls.merge({
        owner,
        repo,
        pull_number: pullNumber,
        merge_method: "merge",
        sha: options.sha,
        commit_title: options.commitTitle,
        commit_message: options.commitMessage,
      });
      const data = response.data as { merged?: boolean; sha?: string; message?: string };
      this.logger.log(`Merged PR ${owner}/${repo}#${pullNumber}`, "OctokitGithubProvider");
      return {
        merged: data.merged === true,
        sha: data.sha ?? null,
        message: data.message ?? `Merged ${owner}/${repo}#${pullNumber}.`,
      };
    } catch (error) {
      if (isMissingActionsPermission(error)) {
        throw toActionsPermissionError(
          owner,
          repo,
          "Contents:write and PullRequests:write",
          `merge pull request #${pullNumber}`,
        );
      }
      throw error;
    }
  }

  /** The delivery publisher can write one Markdown spec on its own branch. */
  async publishSpec(owner: string, repo: string, input: {
    branch: string; base: string; path: string; body: string; title: string; expectedHead?: string;
  }): Promise<{ number: number; head: string; url: string }> {
    if (!/^lexi\/spec-[a-z0-9-]+$/.test(input.branch) ||
        !/^docs\/specs\/[a-zA-Z0-9_-]+\.md$/.test(input.path) ||
        !input.body.trim() || Buffer.byteLength(input.body) > 100_000) {
      throw new Error("Invalid spec branch, path, or document size.");
    }
    const client = await this.getClientForRepo(owner, repo);
    let head: string;
    try {
      head = (await client.rest.git.getRef({ owner, repo, ref: `heads/${input.branch}` })).data.object.sha;
      if (!input.expectedHead) throw new Error("Spec branch already exists without a saved head. Reconcile it before writing.");
    } catch (error) {
      if ((error as { status?: number }).status !== 404 || input.expectedHead) throw error;
      const base = (await client.rest.git.getRef({ owner, repo, ref: `heads/${input.base}` })).data.object.sha;
      head = (await client.rest.git.createRef({ owner, repo, ref: `refs/heads/${input.branch}`, sha: base })).data.object.sha;
    }
    if (input.expectedHead && head !== input.expectedHead) throw new Error("Spec branch changed. Review the current head before writing.");
    const existing = await client.rest.pulls.list({ owner, repo, head: `${owner}:${input.branch}`, base: input.base, state: "all", per_page: 100 });
    if (existing.data.some(pr => pr.state !== "open")) throw new Error("Spec PR was closed or merged. A person must reconcile it.");
    const commit = await client.rest.git.getCommit({ owner, repo, commit_sha: head });
    const tree = await client.rest.git.createTree({ owner, repo, base_tree: commit.data.tree.sha,
      tree: [{ path: input.path, mode: "100644", type: "blob", content: input.body }] });
    const next = await client.rest.git.createCommit({ owner, repo, message: input.title, tree: tree.data.sha, parents: [head] });
    await client.rest.git.updateRef({ owner, repo, ref: `heads/${input.branch}`, sha: next.data.sha, force: false });
    const pr = existing.data[0] ?? (await client.rest.pulls.create({ owner, repo, head: input.branch, base: input.base,
      title: input.title, body: `Review the Markdown spec at ${input.path}. Build and merge are separate steps.`, draft: true })).data;
    return { number: pr.number, head: next.data.sha, url: pr.html_url };
  }

  /**
   * Creates `refs/heads/{name}` pointing at the tip of `from` (default `main`).
   * Refuses if the branch already exists — this never force-updates a ref.
   */
  async createBranch(owner: string, repo: string, options: CreateBranchOptions): Promise<CreatedBranchDto> {
    const name = assertSafeBranchName(options.name, "branch");
    const from = assertSafeBranchName(options.from ?? "main", "from");
    const client = await this.getClientForRepo(owner, repo);
    let sha: string;
    try {
      const ref = await client.rest.git.getRef({ owner, repo, ref: `heads/${from}` });
      sha = String((ref.data as { object?: { sha?: string } }).object?.sha ?? "");
    } catch (error) {
      if (errorStatus(error) === 404) {
        throw new Error(`Source branch "${from}" does not exist on ${owner}/${repo}.`);
      }
      if (isMissingActionsPermission(error)) {
        throw toActionsPermissionError(owner, repo, "Contents:write and PullRequests:write", `read branch ${from}`);
      }
      throw error;
    }
    if (!sha) {
      throw new Error(`Source branch "${from}" on ${owner}/${repo} has no commit sha.`);
    }
    try {
      await client.rest.git.createRef({ owner, repo, ref: `refs/heads/${name}`, sha });
    } catch (error) {
      if (errorStatus(error) === 422) {
        throw new Error(`Branch "${name}" already exists on ${owner}/${repo}.`);
      }
      if (isMissingActionsPermission(error)) {
        throw toActionsPermissionError(owner, repo, "Contents:write and PullRequests:write", `create branch ${name}`);
      }
      throw error;
    }
    this.logger.log(`Created branch ${owner}/${repo}:${name} from ${from} (${sha})`, "OctokitGithubProvider");
    return {
      name,
      sha,
      url: `https://github.com/${owner}/${repo}/tree/${name}`,
    };
  }

  /**
   * Deletes a branch ref, returning the sha it pointed at.
   *
   * Two things this does that a bare `deleteRef` call does not:
   *
   * 1. **Reads the tip first.** The sha is captured before the ref goes, and
   *    returned to the caller, because it is the only way back: GitHub keeps
   *    the commits reachable by sha for weeks, so `createRef` at that sha
   *    restores the branch exactly. Deleting without reporting where it was
   *    turns a reversible act into an irreversible one.
   * 2. **Reads back afterwards.** `DELETE .../git/refs/heads/{branch}` answers
   *    204 without telling you whether anything was actually removed, so
   *    "the call succeeded" is not evidence the branch is gone. The branch is
   *    only reported deleted once a subsequent read 404s.
   *
   * A branch that does not exist is an error, not a silent success — a caller
   * that asked to delete something absent has a wrong idea about the world and
   * should hear so.
   */
  async deleteBranch(owner: string, repo: string, branch: string): Promise<DeletedBranchDto> {
    const name = assertSafeBranchName(branch, "branch");
    const client = await this.getClientForRepo(owner, repo);

    let sha: string;
    try {
      const ref = await client.rest.git.getRef({ owner, repo, ref: `heads/${name}` });
      sha = String((ref.data as { object?: { sha?: string } }).object?.sha ?? "");
    } catch (error) {
      if (errorStatus(error) === 404) {
        throw new Error(`Branch "${name}" does not exist on ${owner}/${repo}.`);
      }
      if (isMissingActionsPermission(error)) {
        throw toActionsPermissionError(owner, repo, "Contents:write", `read branch ${name}`);
      }
      throw error;
    }
    if (!sha) {
      throw new Error(`Branch "${name}" on ${owner}/${repo} has no commit sha; refusing to delete a ref we cannot restore.`);
    }

    try {
      await client.rest.git.deleteRef({ owner, repo, ref: `heads/${name}` });
    } catch (error) {
      // A 404 HERE is not "no permission" — the read above just succeeded, so
      // the ref existed a moment ago. Someone else removed it in between. This
      // has to be caught before `isMissingActionsPermission`, which treats 403
      // and 404 alike and would report a race as a misconfigured installation.
      if (errorStatus(error) === 404) {
        throw new Error(
          `Branch "${name}" on ${owner}/${repo} was deleted by someone else between reading it and deleting it. ` +
            `It is gone, but this call did not remove it. It pointed at ${sha}.`,
        );
      }
      if (errorStatus(error) === 422) {
        throw new Error(
          `Branch "${name}" on ${owner}/${repo} could not be deleted — GitHub rejected the ref deletion, which is what it does for a protected branch.`,
        );
      }
      if (isMissingActionsPermission(error)) {
        throw toActionsPermissionError(owner, repo, "Contents:write", `delete branch ${name}`);
      }
      throw error;
    }

    // Read-back. See the note above: 204 is not proof.
    let stillThere = false;
    try {
      await client.rest.git.getRef({ owner, repo, ref: `heads/${name}` });
      stillThere = true;
    } catch (error) {
      if (errorStatus(error) !== 404) throw error;
    }
    if (stillThere) {
      throw new BranchDeletionUnverifiedError(
        `GitHub accepted the deletion of "${name}" on ${owner}/${repo} but the branch still reads as present. ` +
          `The delete may or may not have taken effect — do NOT report this as "nothing was changed". It pointed at ${sha}.`,
      );
    }

    this.logger.log(`Deleted branch ${owner}/${repo}:${name} (was ${sha})`, "OctokitGithubProvider");
    return { name, sha };
  }

  /**
   * Merges `head` (a branch or SHA) into `base` without going through a PR
   * (`POST .../merges`). Used to land a PR's head onto an integration branch.
   * A 409 is returned as `{conflict:true}` rather than thrown — that is the
   * skill's stop condition, not an installation fault.
   */
  async mergeIntoBranch(owner: string, repo: string, options: MergeIntoBranchOptions): Promise<MergeIntoBranchResult> {
    const base = assertSafeBranchName(options.base, "base");
    // Agent-owned working branches keep a GitHub PR as the audit record.
    // The governed tool opens and merges that PR; this API must not be a
    // back door that lands the same merge with no trail.
    if (base.toLowerCase().startsWith("lexi/")) {
      throw new Error(
        `Direct merge into "${base}" is refused — lexi/* branches must land through a pull request so GitHub keeps an audit trail.`,
      );
    }
    const head = options.head.trim();
    if (!head) {
      throw new Error("head is required.");
    }
    const looksLikeSha = /^[0-9a-f]{7,40}$/i.test(head);
    if (!looksLikeSha) {
      assertSafeBranchName(head, "head");
    }
    try {
      const client = await this.getClientForRepo(owner, repo);
      const response = await client.rest.repos.merge({
        owner,
        repo,
        base,
        head,
        commit_message: options.commitMessage,
      });
      const status = (response as { status?: number }).status;
      const data = response.data as { sha?: string } | undefined;
      if (status === 204 || !data?.sha) {
        return {
          merged: true,
          alreadyUpToDate: true,
          conflict: false,
          sha: data?.sha ?? null,
          message: `${head} is already in ${base}.`,
        };
      }
      this.logger.log(`Merged ${head} into ${owner}/${repo}:${base} (${data.sha})`, "OctokitGithubProvider");
      return {
        merged: true,
        alreadyUpToDate: false,
        conflict: false,
        sha: data.sha,
        message: options.commitMessage ?? `Merged ${head} into ${base}.`,
      };
    } catch (error) {
      if (errorStatus(error) === 409) {
        const raw = error instanceof Error ? error.message : String(error);
        return {
          merged: false,
          alreadyUpToDate: false,
          conflict: true,
          sha: null,
          message: raw,
        };
      }
      if (isMissingActionsPermission(error)) {
        throw toActionsPermissionError(
          owner,
          repo,
          "Contents:write and PullRequests:write",
          `merge ${head} into ${base}`,
        );
      }
      throw error;
    }
  }

  /**
   * Commits a gitlink update on `branch` so a nested submodule points at `sha`.
   * Only `packages` and `design_system` are accepted.
   */
  async updateSubmodulePointer(
    owner: string,
    repo: string,
    options: UpdateSubmodulePointerOptions,
  ): Promise<UpdatedSubmodulePointerDto> {
    const branch = assertSafeBranchName(options.branch, "branch");
    const path = assertSubmodulePath(options.path);
    const sha = assertFullSha(options.sha, "sha");
    const message = options.commitMessage.trim();
    if (!message) {
      throw new Error("commitMessage is required.");
    }
    try {
      const client = await this.getClientForRepo(owner, repo);
      const ref = await client.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
      const parentSha = String((ref.data as { object?: { sha?: string } }).object?.sha ?? "");
      if (!parentSha) {
        throw new Error(`Branch "${branch}" on ${owner}/${repo} has no commit sha.`);
      }
      const parent = await client.rest.git.getCommit({ owner, repo, commit_sha: parentSha });
      const baseTree = String((parent.data as { tree?: { sha?: string } }).tree?.sha ?? "");
      const tree = await client.rest.git.createTree({
        owner,
        repo,
        base_tree: baseTree,
        tree: [{ path, mode: "160000", type: "commit", sha }],
      });
      const commit = await client.rest.git.createCommit({
        owner,
        repo,
        message,
        tree: (tree.data as { sha: string }).sha,
        parents: [parentSha],
      });
      const commitSha = (commit.data as { sha: string }).sha;
      await client.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commitSha });
      this.logger.log(
        `Updated submodule ${path} on ${owner}/${repo}:${branch} to ${sha} (${commitSha})`,
        "OctokitGithubProvider",
      );
      return { path, sha, commitSha, branch };
    } catch (error) {
      if (error instanceof Error && /is required|not allowed|not a legal|must be a full/.test(error.message)) {
        throw error;
      }
      if (isMissingActionsPermission(error)) {
        throw toActionsPermissionError(
          owner,
          repo,
          "Contents:write and PullRequests:write",
          `update submodule ${path} on ${branch}`,
        );
      }
      throw error;
    }
  }
}

function htmlHasSignedCdn(html: string): boolean {
  return /https:\/\/(?:private-user-images|user-images|objects|camo)\.githubusercontent\.com\//i.test(html);
}

async function readIssueHtml(
  client: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string | null> {
  const parts: string[] = [];
  try {
    const response = await client.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
      mediaType: { format: "full" },
      headers: { accept: "application/vnd.github.full+json" },
    });
    const html = (response.data as { body_html?: unknown }).body_html;
    if (typeof html === "string" && html.trim()) parts.push(html);
  } catch {
    // Default REST JSON is markdown `body` — cookie-gated user-attachments.
  }
  const joinedSoFar = parts.join("\n");
  if (!htmlHasSignedCdn(joinedSoFar) && typeof client.graphql === "function") {
    try {
      const data = await client.graphql<{
        repository?: {
          issue?: {
            bodyHTML?: string | null;
            comments?: { nodes?: Array<{ bodyHTML?: string | null }> };
          } | null;
        } | null;
      }>(
        `query ($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              bodyHTML
              comments(first: 30) { nodes { bodyHTML } }
            }
          }
        }`,
        { owner, name: repo, number: issueNumber },
      );
      const issue = data.repository?.issue;
      if (typeof issue?.bodyHTML === "string" && issue.bodyHTML.trim()) {
        parts.push(issue.bodyHTML);
      }
      for (const node of issue?.comments?.nodes ?? []) {
        if (typeof node?.bodyHTML === "string" && node.bodyHTML.trim()) {
          parts.push(node.bodyHTML);
        }
      }
    } catch {
      // GraphQL is a fallback; REST HTML may still be usable.
    }
  }
  const joined = parts.join("\n").trim();
  return joined || null;
}
