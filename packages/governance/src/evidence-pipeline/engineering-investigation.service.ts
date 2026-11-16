import type {
  CodeEvidence,
  EngineeringInvestigation,
  LinkedIssue,
  LinkedPullRequest,
  ProjectStatus,
  ReleaseEvidence,
} from "./engineering-investigation.types";

/**
 * Minimal GitHub interface required by the investigation service.
 * This is NOT the full GitHubProvider — we only need read operations.
 * Keeps the governance package from depending on the full @lexi/github surface.
 */
export interface InvestigationGitHubPort {
  getIssue(owner: string, repo: string, issueNumber: number): Promise<{
    githubNumber: number;
    title: string;
    body: string | null;
    state: "open" | "closed";
    labels: string[];
    assignees: string[];
    stateReason: string | null;
  }>;
  listLinkedPullRequests(owner: string, repo: string, issueNumber: number): Promise<Array<{
    number: number;
    url: string;
    state: "open" | "closed" | "merged";
    merged: boolean;
    title: string;
  }>>;
  listComments(owner: string, repo: string, issueNumber: number): Promise<Array<{
    id: number;
    authorLogin: string | null;
    body: string;
    createdAt: string;
  }>>;
  listTimeline(owner: string, repo: string, issueNumber: number): Promise<Array<{
    event: string;
    actorLogin: string | null;
    createdAt: string;
    raw: Record<string, unknown>;
  }>>;
  /** Optional: search for PRs mentioning a term. Not all providers will implement. */
  searchPullRequests?(owner: string, repo: string, query: string): Promise<Array<{
    number: number;
    state: "open" | "closed" | "merged";
    merged: boolean;
    title: string;
    mergedAt: string | null;
  }>>;
}

export interface InvestigationError {
  stage: string;
  message: string;
  recoverable: boolean;
}

export interface InvestigationConfig {
  /** Repositories to check for implementation PRs/issues */
  targetRepositories: Array<{ owner: string; repo: string }>;
  /** The source issue's repository */
  sourceOwner: string;
  sourceRepo: string;
}

/**
 * Gathers objective engineering facts from GitHub about an issue.
 *
 * Critical design principle: distinguish "checked and found nothing"
 * from "could not check." API failures MUST NOT become "no fix evidence."
 */
export class EngineeringChangeInvestigationService {
  constructor(
    private readonly github: InvestigationGitHubPort,
    private readonly config: InvestigationConfig,
  ) {}

  async investigate(
    issueNumber: number,
    codeSearchTerms: string[] = [],
  ): Promise<EngineeringInvestigation & { repositoriesChecked: string[]; activeEngineeringWork: boolean; errors: InvestigationError[] }> {
    const errors: InvestigationError[] = [];
    const repositoriesChecked: string[] = [];
    const linkedIssues: LinkedIssue[] = [];
    const linkedPullRequests: LinkedPullRequest[] = [];
    let projectStatus: ProjectStatus | undefined;

    // 1. Check linked PRs from the source issue
    try {
      const prs = await this.github.listLinkedPullRequests(
        this.config.sourceOwner,
        this.config.sourceRepo,
        issueNumber,
      );
      repositoriesChecked.push(`${this.config.sourceOwner}/${this.config.sourceRepo}`);

      for (const pr of prs) {
        linkedPullRequests.push({
          number: pr.number,
          repo: `${this.config.sourceOwner}/${this.config.sourceRepo}`,
          state: pr.merged ? "merged" : pr.state,
          title: pr.title,
          changedFiles: [], // Would need separate API call per PR
          targetBranch: "main", // Default assumption
          mergedAt: pr.merged ? undefined : undefined, // Not available from linked PR API
        });
      }
    } catch (err) {
      errors.push({
        stage: "linked_pull_requests",
        message: err instanceof Error ? err.message : "Unknown error fetching linked PRs",
        recoverable: true,
      });
    }

    // 2. Check timeline for cross-references to other issues/PRs
    try {
      const timeline = await this.github.listTimeline(
        this.config.sourceOwner,
        this.config.sourceRepo,
        issueNumber,
      );

      for (const event of timeline) {
        if (event.event === "cross-referenced" && event.raw.source) {
          const source = event.raw.source as Record<string, unknown>;
          const issue = source.issue as Record<string, unknown> | undefined;
          if (issue) {
            const repo = (issue.repository as Record<string, unknown>)?.full_name as string | undefined;
            const num = issue.number as number | undefined;
            const state = issue.state as string | undefined;
            const pullRequest = issue.pull_request as Record<string, unknown> | undefined;

            if (num && repo) {
              if (pullRequest) {
                // It's a PR cross-reference
                const merged = pullRequest.merged_at != null;
                linkedPullRequests.push({
                  number: num,
                  repo: repo,
                  state: merged ? "merged" : (state === "closed" ? "closed" : "open"),
                  title: (issue.title as string) ?? "",
                  changedFiles: [],
                  targetBranch: "main",
                  mergedAt: merged ? (pullRequest.merged_at as string) : undefined,
                });
              } else {
                // It's an issue cross-reference
                linkedIssues.push({
                  number: num,
                  repo: repo,
                  state: state === "closed" ? "closed" : "open",
                  labels: [],
                  relationship: "related",
                  title: (issue.title as string) ?? "",
                });
              }
            }
          }
        }
      }
    } catch (err) {
      errors.push({
        stage: "timeline_analysis",
        message: err instanceof Error ? err.message : "Unknown error fetching timeline",
        recoverable: true,
      });
    }

    // 3. Check comments for fix indicators
    let commentsIndicateFix = false;
    try {
      const comments = await this.github.listComments(
        this.config.sourceOwner,
        this.config.sourceRepo,
        issueNumber,
      );

      const fixIndicators = [
        /fix(ed)?\s+(in|by|via)\s+#?\d+/i,
        /resolved\s+(in|by|via)/i,
        /merged\s+(fix|patch|PR)/i,
        /this\s+(is|was|has been)\s+fixed/i,
        /closing.*as.*fixed/i,
        /deployed.*fix/i,
      ];

      for (const comment of comments) {
        if (fixIndicators.some((pattern) => pattern.test(comment.body))) {
          commentsIndicateFix = true;
          break;
        }
      }
    } catch (err) {
      errors.push({
        stage: "comment_analysis",
        message: err instanceof Error ? err.message : "Unknown error fetching comments",
        recoverable: true,
      });
    }

    // 4. Search target repositories for related PRs (if search is available)
    if (this.github.searchPullRequests && codeSearchTerms.length > 0) {
      for (const targetRepo of this.config.targetRepositories) {
        const repoKey = `${targetRepo.owner}/${targetRepo.repo}`;
        if (repositoriesChecked.includes(repoKey)) continue;

        try {
          const searchQuery = codeSearchTerms.slice(0, 3).join(" ");
          const results = await this.github.searchPullRequests(targetRepo.owner, targetRepo.repo, searchQuery);
          repositoriesChecked.push(repoKey);

          for (const pr of results) {
            // Avoid duplicates
            if (linkedPullRequests.some((existing) => existing.number === pr.number && existing.repo === repoKey)) continue;
            linkedPullRequests.push({
              number: pr.number,
              repo: repoKey,
              state: pr.merged ? "merged" : pr.state,
              title: pr.title,
              changedFiles: [],
              targetBranch: "main",
              mergedAt: pr.mergedAt ?? undefined,
            });
          }
        } catch (err) {
          errors.push({
            stage: `search_${repoKey}`,
            message: err instanceof Error ? err.message : `Error searching ${repoKey}`,
            recoverable: true,
          });
        }
      }
    }

    // 5. Determine code evidence (heuristic from what we found)
    const codeEvidence = deriveCodeEvidence(linkedPullRequests, commentsIndicateFix);

    // 6. Determine release evidence (heuristic — full release tracking requires deployment API)
    const releaseEvidence = deriveReleaseEvidence(linkedPullRequests, commentsIndicateFix);

    // 7. Determine if there is active engineering work
    const activeEngineeringWork =
      linkedPullRequests.some((pr) => pr.state === "open") ||
      linkedIssues.some((i) => i.state === "open" && i.relationship === "implementation");

    // 8. Build limitations list
    const limitations: string[] = [];
    if (errors.length > 0) {
      limitations.push(`${errors.length} API call(s) failed — some evidence may be missing.`);
    }
    if (!this.github.searchPullRequests) {
      limitations.push("PR search unavailable — only directly linked PRs were found.");
    }
    if (codeEvidence.suspectedPatternExists === null) {
      limitations.push("Code analysis not performed — cannot confirm whether faulty pattern exists.");
    }
    if (releaseEvidence.fixReleased === null) {
      limitations.push("Release tracking not available — deployment status unknown.");
    }

    return {
      repositoriesChecked,
      linkedIssues,
      linkedPullRequests,
      projectStatus,
      codeEvidence,
      releaseEvidence,
      activeEngineeringWork,
      investigatedAt: new Date(),
      limitations,
      errors,
    };
  }
}

function deriveCodeEvidence(
  prs: LinkedPullRequest[],
  commentsIndicateFix: boolean,
): CodeEvidence {
  const mergedPRs = prs.filter((pr) => pr.state === "merged");

  return {
    // We cannot check code patterns without a code search API — mark as null (unknown)
    suspectedPatternExists: null,
    // Heuristic: if any merged PR exists, assume a fix commit is on default
    fixCommitOnDefault: mergedPRs.length > 0,
    // Cannot determine test additions without diffstat — mark false conservatively
    relatedTestsAdded: false,
    // Check if fix only on feature branch
    fixOnFeatureBranchOnly: prs.some((pr) => pr.state === "open") && mergedPRs.length === 0,
  };
}

function deriveReleaseEvidence(
  prs: LinkedPullRequest[],
  commentsIndicateFix: boolean,
): ReleaseEvidence {
  const mergedPRs = prs.filter((pr) => pr.state === "merged");

  // Without a release/deployment API, we can only infer from comments and merge state
  if (mergedPRs.length === 0) {
    return {
      fixReleased: null,
      deployedToProduction: null,
    };
  }

  // If comments indicate deployment, upgrade the release evidence
  if (commentsIndicateFix) {
    return {
      fixReleased: true,
      deployedToProduction: null, // Still can't confirm production deployment
      releaseVersion: undefined,
    };
  }

  // Merged PR exists but no release signal
  return {
    fixReleased: null, // Unknown — merged doesn't mean released
    deployedToProduction: null,
  };
}
