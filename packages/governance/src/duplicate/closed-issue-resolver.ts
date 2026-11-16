import type { GitHubProvider } from "@lexi/github";
import { extractLinkedRefs } from "@lexi/github";
import type { PinoLoggerService } from "@lexi/logger";
import { resolveClosedIssueAction } from "./duplicate-engine";

export interface ClosedIssueResolution {
  action: "REOPEN" | "REGRESSION" | "RESOLVE_CANONICAL" | "NONE";
  /** True only when a mutation actually executed. */
  executed: boolean;
  blocked: boolean;
  reason: string;
  reopenedIssue?: number;
  regressionIssue?: number;
  /** For RESOLVE_CANONICAL: the end of the duplicate chain. */
  ultimateCanonical?: number;
  /** Full walked chain including the starting issue, for audit. */
  chain?: number[];
}

export interface ClosedIssueResolverOptions {
  owner: string;
  repo: string;
  enabled: boolean;
  /** Hard cap on duplicate-chain depth. Protects against cycles and long chains. */
  maxChainDepth: number;
  regressionLabel: string;
}

interface ChainIssue {
  number: number;
  state: string;
  labels: string[];
  body?: string | null;
}

export interface CanonicalChainResult {
  ultimate: number;
  chain: number[];
  stoppedBecause: "resolved" | "cycle" | "depth" | "unresolvable";
}

const PRIORITY_LABEL_PATTERN = /^priority:P(\d+)$/i;

/**
 * Raises priority by one level (P3 → P2). Never lowers: a human-set priority is
 * authoritative downward, matching the severity policy's
 * humanPriorityPreserved rule. P0 is the ceiling.
 */
export function raisePriorityLabels(labels: string[]): string[] {
  return labels.map((label) => {
    const match = PRIORITY_LABEL_PATTERN.exec(label);
    if (!match) {
      return label;
    }
    const current = Number(match[1]);
    const raised = Math.max(0, current - 1);
    // Preserve the original casing of the `priority:` prefix.
    const prefix = label.slice(0, label.length - String(current).length);
    return `${prefix}${raised}`;
  });
}

function isClosedDuplicate(issue: ChainIssue): boolean {
  return (
    issue.state === "closed" &&
    issue.labels.some((label) => label.toLowerCase() === "duplicate")
  );
}

/**
 * Follows a duplicate chain to its ultimate canonical issue.
 *
 * A visited set plus a depth cap are both required: GitHub allows A→B→A cycles
 * and arbitrarily long chains, and either would hang or mislead the caller. On
 * a cycle we stop and return the chain walked so far rather than guessing which
 * issue is authoritative.
 */
export async function followCanonicalChain(
  startNumber: number,
  fetchIssue: (n: number) => Promise<ChainIssue | null>,
  extractReferences: (text: string) => number[],
  maxDepth: number,
): Promise<CanonicalChainResult> {
  const chain: number[] = [startNumber];
  const visited = new Set<number>([startNumber]);

  let current = await fetchIssue(startNumber);
  if (!current) {
    return { ultimate: startNumber, chain, stoppedBecause: "unresolvable" };
  }

  for (;;) {
    const node: ChainIssue = current;
    if (!isClosedDuplicate(node)) {
      return { ultimate: node.number, chain, stoppedBecause: "resolved" };
    }

    const references = extractReferences(node.body ?? "");
    const next = references.find((n) => n !== node.number);
    if (next === undefined) {
      return { ultimate: node.number, chain, stoppedBecause: "unresolvable" };
    }
    if (visited.has(next)) {
      return { ultimate: node.number, chain, stoppedBecause: "cycle" };
    }
    if (chain.length + 1 > maxDepth) {
      return { ultimate: node.number, chain, stoppedBecause: "depth" };
    }

    const fetched = await fetchIssue(next);
    chain.push(next);
    visited.add(next);
    if (!fetched) {
      return { ultimate: next, chain, stoppedBecause: "unresolvable" };
    }
    current = fetched;
  }
}

/**
 * Acts on the closed-issue duplicate rules: reopen an issue closed without the
 * bug ever being observed, file a regression against one closed as fixed, or
 * walk a duplicate chain to its ultimate canonical issue.
 *
 * Every mutating path is double-gated: CLOSED_ISSUE_SEMANTICS_ENABLED here, and
 * the GitHub mutation gateway underneath. The flag check happens before any
 * provider call so a disabled deployment produces a recommendation and nothing
 * else.
 */
export class ClosedIssueResolver {
  constructor(
    private readonly github: GitHubProvider,
    private readonly options: ClosedIssueResolverOptions,
    private readonly logger: PinoLoggerService,
  ) {}

  async resolve(
    canonicalNumber: number,
    submission: { title: string; url?: string; summary: string },
  ): Promise<ClosedIssueResolution> {
    let issue: Awaited<ReturnType<GitHubProvider["getIssue"]>>;
    try {
      issue = await this.github.getIssue(this.options.owner, this.options.repo, canonicalNumber);
    } catch (error) {
      return {
        action: "NONE",
        executed: false,
        blocked: true,
        reason: `Could not read issue #${canonicalNumber}: ${this.message(error)}`,
      };
    }

    if (issue.state !== "closed") {
      return {
        action: "NONE",
        executed: false,
        blocked: false,
        reason: "Issue is open; closed-issue rules do not apply.",
      };
    }

    const action = resolveClosedIssueAction({
      state: issue.state,
      closedReason: issue.stateReason,
      labels: issue.labels,
    });

    if (!this.options.enabled) {
      return {
        action,
        executed: false,
        blocked: true,
        reason: "CLOSED_ISSUE_SEMANTICS_ENABLED=false — recommendation only, no mutation attempted.",
      };
    }

    if (action === "NONE") {
      return {
        action,
        executed: false,
        blocked: false,
        reason: `Issue #${canonicalNumber} is closed but matches no closed-issue rule; no action taken.`,
      };
    }

    if (action === "RESOLVE_CANONICAL") {
      return this.resolveCanonicalChain(canonicalNumber);
    }

    if (action === "REOPEN") {
      return this.executeReopen(canonicalNumber, submission);
    }

    return this.executeRegression(canonicalNumber, submission, issue.labels);
  }

  private async resolveCanonicalChain(canonicalNumber: number): Promise<ClosedIssueResolution> {
    try {
      const result = await followCanonicalChain(
        canonicalNumber,
        async (n) => {
          const fetched = await this.github.getIssue(this.options.owner, this.options.repo, n);
          return {
            number: fetched.githubNumber,
            state: fetched.state,
            labels: fetched.labels,
            body: fetched.body,
          };
        },
        (text) => this.extractReferences(text),
        this.options.maxChainDepth,
      );

      return {
        action: "RESOLVE_CANONICAL",
        executed: false,
        blocked: false,
        reason:
          `Issue #${canonicalNumber} is itself a closed duplicate. Chain ${result.chain.join(" → ")} ` +
          `resolved to #${result.ultimate} (stopped because: ${result.stoppedBecause}). Read-only resolution; no mutation performed.`,
        ultimateCanonical: result.ultimate,
        chain: result.chain,
      };
    } catch (error) {
      return {
        action: "RESOLVE_CANONICAL",
        executed: false,
        blocked: true,
        reason: `Could not resolve duplicate chain from #${canonicalNumber}: ${this.message(error)}`,
      };
    }
  }

  private async executeReopen(
    canonicalNumber: number,
    submission: { title: string; url?: string; summary: string },
  ): Promise<ClosedIssueResolution> {
    try {
      await this.github.reopenIssue(this.options.owner, this.options.repo, canonicalNumber);
      await this.github.addComment(
        this.options.owner,
        this.options.repo,
        canonicalNumber,
        [
          "A new matching bug report was received for this issue.",
          "",
          `**New report:** ${submission.title}`,
          submission.url ? `**Source:** ${submission.url}` : undefined,
          "",
          `**Summary:** ${submission.summary}`,
          "",
          "Reopened because this issue had been closed without the bug being observed, so a fresh report means it is still outstanding rather than a regression.",
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n"),
      );

      this.logger.log(`Reopened issue #${canonicalNumber} on new matching report`, "ClosedIssueResolver");
      return {
        action: "REOPEN",
        executed: true,
        blocked: false,
        reason: `Issue #${canonicalNumber} was closed without the bug being observed; reopened on a new matching report.`,
        reopenedIssue: canonicalNumber,
      };
    } catch (error) {
      return {
        action: "REOPEN",
        executed: false,
        blocked: true,
        reason: `Reopen of #${canonicalNumber} did not execute: ${this.message(error)}`,
      };
    }
  }

  private async executeRegression(
    canonicalNumber: number,
    submission: { title: string; url?: string; summary: string },
    originalLabels: string[],
  ): Promise<ClosedIssueResolution> {
    const labels = [this.options.regressionLabel, ...raisePriorityLabels(originalLabels)];
    try {
      const created = await this.github.createIssue(
        this.options.owner,
        this.options.repo,
        `[Regression] ${submission.title}`,
        [
          `Regression of #${canonicalNumber}, which was closed as fixed.`,
          submission.url ? `**Source:** ${submission.url}` : undefined,
          "",
          `**Summary:** ${submission.summary}`,
        ]
          .filter((line): line is string => line !== undefined)
          .join("\n"),
        labels,
      );

      await this.github.addComment(
        this.options.owner,
        this.options.repo,
        canonicalNumber,
        `A matching report was received after this issue was closed as fixed. Filed as a regression: #${created.githubNumber}.`,
      );

      this.logger.log(
        `Filed regression #${created.githubNumber} for closed issue #${canonicalNumber}`,
        "ClosedIssueResolver",
      );
      return {
        action: "REGRESSION",
        executed: true,
        blocked: false,
        reason: `Issue #${canonicalNumber} was closed as fixed; filed regression #${created.githubNumber}.`,
        regressionIssue: created.githubNumber,
      };
    } catch (error) {
      return {
        action: "REGRESSION",
        executed: false,
        blocked: true,
        reason: `Regression filing for #${canonicalNumber} did not execute: ${this.message(error)}`,
      };
    }
  }

  /**
   * Duplicate markers appear either as a full github.com URL or as a bare
   * `#123` shorthand. Full URLs are restricted to the configured repo so a link
   * to an unrelated repository never redirects the chain.
   */
  private extractReferences(text: string): number[] {
    const numbers: number[] = [];
    const seen = new Set<number>();

    const push = (n: number) => {
      if (!Number.isFinite(n) || seen.has(n)) return;
      seen.add(n);
      numbers.push(n);
    };

    for (const ref of extractLinkedRefs(text)) {
      if (
        ref.type === "issues" &&
        ref.owner.toLowerCase() === this.options.owner.toLowerCase() &&
        ref.repo.toLowerCase() === this.options.repo.toLowerCase()
      ) {
        push(ref.number);
      }
    }

    for (const match of text.matchAll(/#(\d+)/g)) {
      push(Number(match[1]));
    }

    return numbers;
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
