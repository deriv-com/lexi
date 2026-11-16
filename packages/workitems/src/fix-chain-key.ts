import type { WorkItemKind } from "@lexi/contracts";
import { ISSUES_REPO_KEY } from "./repo-registry";

/**
 * Re-keys the fix chain from `productionIssueNumber` to `workItemId`.
 *
 * `ImplementationLink`, `ReleaseRecord` and `DeploymentRecord` are all keyed on
 * `(productionIssueNumber, productionRepository)`. That is not merely awkward
 * for non-bug work — it makes it **impossible**: a feature has no production
 * issue, so there is no key under which to record that it was released or
 * deployed. "Feature verified = a deployment record exists" cannot be
 * satisfied while the only way to attach a deployment is via a bug number.
 *
 * The re-key is additive rather than a cutover, because the rows already in the
 * database were written before `workItemId` existed. Reading a bug's fix chain
 * on `workItemId` alone would return empty for every issue Lexi has ever
 * tracked — and an empty fix chain does not read as "not migrated", it reads as
 * "no PRs, no releases, nothing shipped", which is a false and load-bearing
 * claim. So the read path matches either key, and the write path keeps
 * stamping the legacy columns for bugs so existing consumers keep working
 * until the integration pass migrates them.
 */

export interface FixChainSubject {
  workItemId: string;
  kind: WorkItemKind;
  /** `config/repos.yaml` key of the repo the issue lives in. */
  trackingRepoKey?: string;
  /** "organization/repository" for that tracking repo. */
  trackingRepoSlug?: string;
  issueNumber?: number;
}

export interface FixChainWriteKey {
  workItemId: string;
  productionIssueNumber?: number;
  productionRepository?: string;
}

export type FixChainWhere =
  | { workItemId: string }
  | {
      OR: [
        { workItemId: string },
        { workItemId: null; productionIssueNumber: number; productionRepository: string },
      ];
    };

/**
 * True when a subject also has a *legacy* identity — i.e. it is a bug whose
 * issue lives in the issues corpus.
 *
 * The tracking-repo check matters: a bug tracked in a product repo shares a
 * number space with genuinely unrelated production issues, so stamping its
 * number into `productionIssueNumber` would silently attach its PRs and
 * releases to somebody else's bug.
 */
function hasLegacyIdentity(
  subject: FixChainSubject,
): subject is FixChainSubject & { issueNumber: number; trackingRepoSlug: string } {
  return (
    subject.kind === "bug" &&
    subject.trackingRepoKey === ISSUES_REPO_KEY &&
    typeof subject.issueNumber === "number" &&
    typeof subject.trackingRepoSlug === "string" &&
    subject.trackingRepoSlug.length > 0
  );
}

export class FixChainKeyResolver {
  /**
   * The key columns to persist on a new `ImplementationLink` / `ReleaseRecord`
   * / `DeploymentRecord`. `workItemId` is always written; the legacy pair is
   * written only when the subject genuinely has one.
   */
  writeKey(subject: FixChainSubject): FixChainWriteKey {
    if (!subject.workItemId) {
      throw new Error("FixChainKeyResolver.writeKey requires a workItemId — the fix chain is keyed on it.");
    }

    if (!hasLegacyIdentity(subject)) {
      return { workItemId: subject.workItemId };
    }

    return {
      workItemId: subject.workItemId,
      productionIssueNumber: subject.issueNumber,
      productionRepository: subject.trackingRepoSlug,
    };
  }

  /**
   * The `where` clause for reading a subject's fix chain. For a bug this
   * matches new rows by `workItemId` **or** pre-migration rows by their
   * production key; the legacy branch pins `workItemId: null` so a row that
   * has been migrated is matched once, not twice.
   */
  readWhere(subject: FixChainSubject): FixChainWhere {
    if (!hasLegacyIdentity(subject)) {
      return { workItemId: subject.workItemId };
    }

    return {
      OR: [
        { workItemId: subject.workItemId },
        {
          workItemId: null,
          productionIssueNumber: subject.issueNumber,
          productionRepository: subject.trackingRepoSlug,
        },
      ],
    };
  }

  /** For callers that still hold only an issue number (the pre-re-key path). */
  legacyReadWhere(
    productionIssueNumber: number,
    productionRepository: string,
  ): { productionIssueNumber: number; productionRepository: string } {
    return { productionIssueNumber, productionRepository };
  }
}

/** "acme-internal/issues#4821", or null when there is no legacy identity. */
export function legacyBugKeyFor(subject: FixChainSubject): string | null {
  return hasLegacyIdentity(subject) ? `${subject.trackingRepoSlug}#${subject.issueNumber}` : null;
}

/** Whether a persisted row predates the re-key and still needs backfilling. */
export function isLegacyFixChainKey(row: {
  workItemId?: string | null;
  productionIssueNumber?: number | null;
}): boolean {
  return (
    (row.workItemId === null || row.workItemId === undefined) &&
    row.productionIssueNumber !== null &&
    row.productionIssueNumber !== undefined
  );
}
