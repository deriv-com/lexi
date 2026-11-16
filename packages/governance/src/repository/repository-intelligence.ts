import type { GitHubProvider } from "@lexi/github";
import type { PinoLoggerService } from "@lexi/logger";
import { RepositoryRegistry, type RepositoryResolution } from "./repository-registry";

export interface PullRequestContext {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  url: string;
  author?: string;
  reviewStatus?: "approved" | "changes_requested" | "pending" | "unknown";
  mergedAt?: string;
  targetBranch?: string;
}

export interface ImplementationContext {
  issueNumber?: number;
  issueUrl?: string;
  issueState?: "open" | "closed";
  pullRequests: PullRequestContext[];
  lastActivityAt?: string;
}

export interface EngineeringContext {
  /** The production issue being investigated */
  productionIssue: {
    number: number;
    repository: string;
  };

  /** Resolved product/platform from the registry */
  product?: {
    key: string;
    platform: string;
    team: string;
  };

  /** The implementation repository (where the fix lives) */
  implementationRepo?: {
    organization: string;
    repository: string;
    fullName: string;
    placeholder: boolean;
  };

  /** Implementation details: linked issues, PRs, activity */
  implementation?: ImplementationContext;

  /** Project board placement (if configured) */
  project?: {
    organization: string;
    projectNumber: number;
    status?: string;
    itemId?: string;
  };

  /** Resolution status — synthesized from all signals */
  resolution: {
    status:
      | "no_implementation_found"
      | "implementation_open"
      | "pr_open"
      | "pr_in_review"
      | "pr_merged_awaiting_verification"
      | "fix_released"
      | "placeholder_repo"
      | "unknown";
    summary: string;
    fixMergedAt?: string;
    confidence: "high" | "medium" | "low";
  };

  /** What the agent should know about data completeness */
  dataCompleteness: {
    hasLinkedPRs: boolean;
    hasImplementationIssue: boolean;
    hasProjectPlacement: boolean;
    repoIsPlaceholder: boolean;
    notes: string[];
  };
}

/**
 * Repository Intelligence Service — resolves the full engineering context for
 * a production issue.
 *
 * This is NOT a workflow service. It does not mutate anything. It answers:
 * "What is the engineering truth about this problem?" by following the chain:
 *
 *   Issue → Product → Repository → PR → Merge → Release → Owner
 *
 * The agent calls this once and gets everything it needs to explain the
 * real-world status of a bug, without multiple tool round-trips.
 */
export class RepositoryIntelligenceService {
  constructor(
    private readonly registry: RepositoryRegistry,
    private readonly github: GitHubProvider,
    private readonly logger: PinoLoggerService,
  ) {}

  async resolveContext(
    issueNumber: number,
    team?: string,
    platform?: string,
    labels?: string[],
  ): Promise<EngineeringContext> {
    const source = this.registry.getSourceRepository();
    const base: EngineeringContext = {
      productionIssue: { number: issueNumber, repository: source.fullName },
      resolution: {
        status: "unknown",
        summary: "Unable to determine implementation status.",
        confidence: "low",
      },
      dataCompleteness: {
        hasLinkedPRs: false,
        hasImplementationIssue: false,
        hasProjectPlacement: false,
        repoIsPlaceholder: false,
        notes: [],
      },
    };

    // 1. Resolve product from team/labels
    const resolvedTeam = team ?? this.inferTeamFromLabels(labels ?? []);
    if (!resolvedTeam) {
      base.resolution.summary = "No team could be inferred — cannot resolve implementation repository.";
      base.dataCompleteness.notes.push("Team not determined from labels or classification.");
      return base;
    }

    const repos = this.registry.resolveAllForTeam(resolvedTeam);
    const targetRepo = platform
      ? repos.find((r) => r.platform === platform) ?? repos[0]
      : repos[0];

    if (!targetRepo) {
      base.resolution.summary = `No implementation repository registered for team "${resolvedTeam}".`;
      base.dataCompleteness.notes.push(`Team "${resolvedTeam}" has no repository in config/repos.yaml.`);
      return base;
    }

    base.product = {
      key: targetRepo.productKey,
      platform: targetRepo.platform,
      team: targetRepo.team,
    };

    base.implementationRepo = {
      organization: targetRepo.organization,
      repository: targetRepo.repository,
      fullName: targetRepo.fullName,
      placeholder: targetRepo.placeholder,
    };

    if (targetRepo.placeholder) {
      base.resolution = {
        status: "placeholder_repo",
        summary: `Implementation repository for "${resolvedTeam}" (${targetRepo.platform}) is registered as a placeholder — not yet operational.`,
        confidence: "high",
      };
      base.dataCompleteness.repoIsPlaceholder = true;
      base.dataCompleteness.notes.push("Repository is a placeholder. No cross-repo lookup possible.");
      return base;
    }

    if (targetRepo.project) {
      base.project = { ...targetRepo.project };
      base.dataCompleteness.hasProjectPlacement = true;
    }

    // 2. Search for linked PRs in the implementation repo that reference this issue
    try {
      const linkedPRs = await this.findLinkedPullRequests(
        targetRepo,
        issueNumber,
      );
      base.implementation = { pullRequests: linkedPRs };
      base.dataCompleteness.hasLinkedPRs = linkedPRs.length > 0;

      if (linkedPRs.length > 0) {
        const lastActivity = linkedPRs
          .map((pr) => pr.mergedAt)
          .filter((d): d is string => Boolean(d))
          .sort()
          .reverse()[0];
        base.implementation.lastActivityAt = lastActivity;
      }

      // 3. Synthesize resolution status
      base.resolution = this.synthesizeResolution(linkedPRs);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      this.logger.warn(
        `Repository intelligence failed for #${issueNumber} in ${targetRepo.fullName}: ${msg}`,
        "RepositoryIntelligenceService",
      );
      base.resolution = {
        status: "unknown",
        summary: `Could not query implementation repository ${targetRepo.fullName}: ${msg}`,
        confidence: "low",
      };
      base.dataCompleteness.notes.push(`GitHub API error: ${msg}`);
    }

    return base;
  }

  private inferTeamFromLabels(labels: string[]): string | undefined {
    // Use the same label-to-team mapping logic as the ownership resolver
    const labelSet = new Set(labels.map((l) => l.toLowerCase()));
    for (const product of this.registry.listProducts()) {
      // Check if any label matches this product's team via common patterns
      if (labelSet.has(`domain:${product.platform}`)) {
        return product.team;
      }
      if (labelSet.has(`component:${product.team}`)) {
        return product.team;
      }
    }
    return undefined;
  }

  private async findLinkedPullRequests(
    repo: RepositoryResolution,
    issueNumber: number,
  ): Promise<PullRequestContext[]> {
    // Strategy: search for PRs that reference this production issue number
    // GitHub's search covers PR bodies and titles that mention #N or the full URL
    // Uses the linked PRs derived from timeline events on the source issue
    const linkedPRs = await this.github.listLinkedPullRequests(
      repo.organization,
      repo.repository,
      issueNumber,
    );

    return linkedPRs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.merged ? "merged" : pr.state,
      url: pr.url,
    }));
  }

  private synthesizeResolution(
    pullRequests: PullRequestContext[],
  ): EngineeringContext["resolution"] {
    if (pullRequests.length === 0) {
      return {
        status: "no_implementation_found",
        summary: "No linked pull requests found in the implementation repository. The fix may not have started, or the PR may not reference this issue number.",
        confidence: "medium",
      };
    }

    const merged = pullRequests.filter((pr) => pr.state === "merged");
    const open = pullRequests.filter((pr) => pr.state === "open");

    if (merged.length > 0) {
      const latest = merged[0];
      return {
        status: "pr_merged_awaiting_verification",
        summary: `A linked fix PR was merged (PR #${latest.number} "${latest.title}"), but production resolution has not been verified. A merged PR proves code was merged — not that the defect is resolved in production.`,
        fixMergedAt: latest.mergedAt,
        confidence: "high",
      };
    }

    if (open.length > 0) {
      const latest = open[0];
      return {
        status: "pr_open",
        summary: `Fix in progress: PR #${latest.number} "${latest.title}" is open.`,
        confidence: "high",
      };
    }

    // All PRs closed without merge
    return {
      status: "no_implementation_found",
      summary: `${pullRequests.length} linked PR(s) found but all are closed without merge — fix may have been abandoned or reworked.`,
      confidence: "medium",
    };
  }
}
