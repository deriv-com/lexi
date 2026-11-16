import type {
  CreatedBranchDto,
  CreateBranchOptions,
  GitHubMutationGateway,
  GitHubProvider,
  GithubIssueDto,
  MergedPullRequestDto,
  MergePullRequestOptions,
} from "@lexi/github";

/**
 * The GitHub surface the read tools use.
 *
 * Structural slices of `GitHubProvider` and `GitHubMutationGateway`, so the
 * gateway a deployment already builds (which wraps the provider in the
 * writes-enabled / dry-run switch) satisfies these as-is, and a test double
 * only implements what it exercises. Methods the provider does not guarantee
 * are optional, and a tool whose method is absent says so instead of
 * pretending the answer is empty.
 */
export type GithubReadClient = Pick<
  GitHubProvider,
  | "getIssue"
  | "getPullRequest"
  | "listComments"
  | "listIssues"
  | "getFileContents"
  | "getPullRequestFiles"
  | "listWorkflowRunJobs"
  | "listWorkflowRunArtifacts"
  | "downloadWorkflowJobLogs"
> &
  Partial<Pick<GitHubMutationGateway, "getReviewStatus" | "listPullRequests" | "listWorkflowRuns" | "getWorkflowRun">> & {
    /**
     * GitHub issue search, when the deployment provides it. Without it,
     * `search_issues` scans the most recent issues and says how many it read.
     */
    searchIssues?(owner: string, repo: string, query: string, limit: number): Promise<GithubIssueDto[]>;
  };

/**
 * The GitHub surface the write tools use. Pass the `GitHubMutationGateway`:
 * its writes throw `WriteGateBlockedError` when writes are disabled or in dry
 * run, and the tools report that as "not performed".
 */
export type GithubWriteClient = Pick<
  GitHubProvider,
  | "getIssue"
  | "getPullRequest"
  | "getFileContents"
  | "addComment"
  | "addLabels"
  | "removeLabels"
  | "closeIssue"
  | "reopenIssue"
  | "createIssue"
  | "createPullRequest"
  | "closePullRequest"
  | "reopenPullRequest"
> &
  Partial<Pick<GitHubMutationGateway, "getReviewStatus" | "branchExists" | "getDefaultBranch">> & {
    createBranch?(owner: string, repo: string, options: CreateBranchOptions): Promise<CreatedBranchDto>;
    mergePullRequest?(
      owner: string,
      repo: string,
      pullNumber: number,
      options?: MergePullRequestOptions,
    ): Promise<MergedPullRequestDto>;
  };

/** The GitHub surface agent-fix dispatch and result reading use. */
export type GithubDispatchClient = Pick<
  GitHubProvider,
  | "dispatchWorkflow"
  | "findDispatchedRun"
  | "listWorkflowRunJobs"
  | "downloadWorkflowJobLogs"
  | "listWorkflowRunArtifacts"
  | "downloadWorkflowRunArtifact"
> &
  Partial<Pick<GitHubMutationGateway, "getDefaultBranch" | "getWorkflowRun">>;

/** Parses a GitHub Actions run URL: https://github.com/owner/repo/actions/runs/123[/job/456]. */
export function parseRunUrl(value: string): { slug: string; runId: number; jobId?: number } | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(
    value.trim(),
  );
  if (!match) return null;
  const runId = Number(match[2]);
  const jobId = match[3] ? Number(match[3]) : undefined;
  if (!Number.isSafeInteger(runId)) return null;
  return { slug: match[1], runId, ...(jobId && Number.isSafeInteger(jobId) ? { jobId } : {}) };
}
