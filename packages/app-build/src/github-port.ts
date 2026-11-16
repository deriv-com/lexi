import type { GitHubMutationGateway, GitHubProvider } from "@lexi/github";

/**
 * The GitHub surface app-build needs, and nothing more.
 *
 * A structural slice of `GitHubProvider` and `GitHubMutationGateway`: pass the
 * gateway a deployment already builds, so the writes-enabled / dry-run switch
 * and the protected-workflow refusal apply to every label change, comment and
 * dispatch here. A test double implements only these methods.
 *
 * The gateway's list methods return null when the wrapped provider cannot do
 * them; app-build treats null as "not readable", never as "none".
 */
export type AppBuildGithubPort = Pick<
  GitHubProvider,
  "getIssue" | "listComments" | "addComment" | "addLabels" | "removeLabels" | "dispatchWorkflow" | "getFileContents"
> &
  Pick<GitHubMutationGateway, "listPullRequests" | "listWorkflowRuns" | "getDefaultBranch"> &
  Partial<Pick<GitHubProvider, "findDispatchedRun">>;

/** One workflow run, as the port lists them. */
export type AppBuildWorkflowRun = NonNullable<Awaited<ReturnType<AppBuildGithubPort["listWorkflowRuns"]>>>[number];
