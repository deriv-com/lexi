import { GitHubProvider, extractLinkedRefs, LinkedRef } from "@lexi/github";
import { PinoLoggerService } from "@lexi/logger";
import { IssueRecord } from "./types";

export interface ClosureEvidence {
  url: string;
  type: "issue" | "pull";
}

/**
 * Deterministic cross-org closure check: some bug reports are filed against a
 * shared intake repository (say `acme/issues`) but the actual fix lands in a
 * repository owned by another organisation (say `acme-eng/web`), and the
 * reporter usually links that issue/PR directly
 * in the body or a comment. `GitHubProvider` already takes `owner`/`repo`
 * as explicit per-call arguments, so it's cross-org capable with zero
 * changes -- this class just walks the linked refs and asks GitHub whether
 * any of them are already resolved.
 *
 * Deliberately does no fuzzy/AI-based matching: only an exact linked ref is
 * trusted, to avoid false-positive closures. A single unreachable/404
 * ref (e.g. a repo the token can't read) is logged and skipped rather than
 * aborting the whole check.
 *
 * Security: the issue body/comments this check scans are fully attacker-
 * controlled (anyone who can file or comment on a bug report). Without
 * a trust boundary on which *owners* a linked ref is allowed to belong to,
 * a reporter could link an unrelated already-closed issue or already-merged
 * PR in a repo they fully control (e.g. a throwaway public repo) to get a
 * real bug report auto-closed as "already fixed" with fabricated evidence,
 * bypassing reproduction and AI analysis entirely. `trustedOwners` is a
 * hand-configured allow-list (the issue's own `repoOwner` is always
 * implicitly trusted); a ref pointing at any other owner is ignored before
 * ever calling GitHub about it -- not just excluded from being "evidence."
 */
export class CrossOrgClosureChecker {
  private readonly trustedOwners: Set<string>;

  constructor(
    private readonly github: GitHubProvider,
    private readonly logger: PinoLoggerService,
    trustedOwners: string[] = [],
  ) {
    this.trustedOwners = new Set(trustedOwners.map((owner) => owner.toLowerCase()));
  }

  async check(issue: IssueRecord): Promise<ClosureEvidence | null> {
    const comments = await this.github.listComments(issue.repoOwner, issue.repoName, issue.githubNumber);
    const text = [issue.body ?? "", ...comments.map((comment) => comment.body)].join("\n");
    const refs = extractLinkedRefs(text);

    for (const ref of refs) {
      if (!this.isTrustedOwner(ref.owner, issue.repoOwner)) {
        this.logger.log(
          `Cross-org closure check ignoring link to untrusted owner ${ref.owner}/${ref.repo}#${ref.number} (${ref.type}) -- not in the trusted-owners allow-list`,
          "CrossOrgClosureChecker",
        );
        continue;
      }

      try {
        const evidence = await this.checkRef(ref);
        if (evidence) {
          return evidence;
        }
      } catch (error) {
        this.logger.error(
          `Cross-org closure check failed for ${ref.owner}/${ref.repo}#${ref.number} (${ref.type}): ${
            error instanceof Error ? error.message : String(error)
          }`,
          "CrossOrgClosureChecker",
        );
      }
    }

    return null;
  }

  private isTrustedOwner(refOwner: string, issueOwner: string): boolean {
    const normalized = refOwner.toLowerCase();
    return normalized === issueOwner.toLowerCase() || this.trustedOwners.has(normalized);
  }

  private async checkRef(ref: LinkedRef): Promise<ClosureEvidence | null> {
    if (ref.type === "pull") {
      const pr = await this.github.getPullRequest(ref.owner, ref.repo, ref.number);
      if (pr.merged) {
        return { url: pr.url, type: "pull" };
      }
      return null;
    }

    const linkedIssue = await this.github.getIssue(ref.owner, ref.repo, ref.number);
    if (linkedIssue.state === "closed") {
      return { url: linkedIssue.url, type: "issue" };
    }
    return null;
  }
}
