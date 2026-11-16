/**
 * Protected branches — refs no agent may merge into, commit to, or rewrite.
 *
 * The codebase already knew how to name a trunk branch: `rebase-branch.yml` and
 * `governed-action-tools.ts` both refused `main|master|develop|qa|production|
 * release*` for *rebase*, because a force-push rewrites shared history.
 *
 * No equivalent check existed on any *merge* path. `merge_into_branch` and
 * `update_submodule_pointer` accepted a free-form target that
 * was validated for git-ref legality and nothing else — `main` passed every
 * validator in the repo. This module is that missing check, in one place so the
 * merge paths and the rebase path cannot drift apart.
 *
 * Policy: Lexi creates branches and works on them. Landing a branch on a
 * default branch is a human act.
 */

/**
 * Branch names that are a trunk or release line regardless of which repo they
 * are in.
 *
 * NOTE this is deliberately NARROWER than the rebase list in
 * `rebase-branch.yml` / `REBASE_FORBIDDEN_BRANCHES`, which ends `release[/-].*`.
 * The two answer different questions:
 *
 *   rebase  — "may this branch's history be rewritten?"  A force-push onto any
 *             shared release line is destructive, so the hyphen form is in.
 *   merge   — "may code be landed here without a human?"  The hyphen form
 *             `release-integration-YYYY-MM-DD` is a *working* branch that
 *             release-integration exists to merge into. Blocking it would
 *             break the intended flow, not protect anything.
 *
 * So `release/1.2` is protected and both `release-integration-2026-09-14` and
 * `release/integration-2026-08-19` are not.
 *
 * The separator is NOT the distinction — "integration" is. An earlier version
 * of this keyed on slash-vs-hyphen, on the grounds that a ruleset on
 * mobile-packages refuses direct merges to `release/**` and the repo
 * therefore prefers the hyphen. That was wrong: `release/integration-*` is the
 * older spelling of the same WORKING branch and is still what several callers
 * pass, so protecting it broke release-integration rather than guarding a
 * release line.
 *
 * `qa` and `staging` are included: in this system pushing to `qa` IS the
 * deploy, so landing code there is a release act, not a working step.
 */
const PROTECTED_BRANCH_NAMES = /^(main|master|develop|dev|trunk|stable|qa|staging|production|prod|release)$/i;

/** A release line such as `release/1.2` — but never an integration branch. */
const RELEASE_LINE = /^release\//i;

/** Integration branches are working branches whatever their separator. */
const INTEGRATION_BRANCH = /integration/i;

/** Why a branch was refused, so the refusal can say something specific. */
export type ProtectedBranchReason = "trunk" | "default-branch";

export interface ProtectedBranchVerdict {
  readonly protected: boolean;
  readonly reason?: ProtectedBranchReason;
  /** Present when `reason` is `default-branch`. */
  readonly defaultBranch?: string;
}

/** Strips `refs/heads/` so a fully-qualified ref cannot slip past the name test. */
export function normalizeBranchName(branch: string): string {
  return branch
    .trim()
    .replace(/^refs\/heads\//i, "")
    .replace(/^heads\//i, "");
}

/**
 * Classifies a branch.
 *
 * `defaultBranch` is the repository's own default when known. It matters: one
 * repo in `config/repos.yaml` uses `master`, and a repo could use any name at
 * all — a hard-coded list alone would miss it.
 */
export function classifyBranch(branch: string, defaultBranch?: string | null): ProtectedBranchVerdict {
  const name = normalizeBranchName(branch);
  if (!name) return { protected: false };

  if (PROTECTED_BRANCH_NAMES.test(name)) {
    return { protected: true, reason: "trunk" };
  }

  if (RELEASE_LINE.test(name) && !INTEGRATION_BRANCH.test(name)) {
    return { protected: true, reason: "trunk" };
  }

  const fallback = defaultBranch ? normalizeBranchName(defaultBranch) : "";
  if (fallback && name.toLowerCase() === fallback.toLowerCase()) {
    return { protected: true, reason: "default-branch", defaultBranch: fallback };
  }

  return { protected: false };
}

/** Convenience predicate. */
export function isProtectedBranch(branch: string, defaultBranch?: string | null): boolean {
  return classifyBranch(branch, defaultBranch).protected;
}

/**
 * Refusal text for a blocked write.
 *
 * `action` is a verb phrase describing what was attempted, e.g.
 * `"merge into"` or `"commit to"`. The sentence always ends by stating that
 * nothing was changed, because a refusal that leaves the reader unsure whether
 * a mutation half-happened is worse than no refusal at all.
 */
export function describeProtectedBranchRefusal(
  branch: string,
  action: string,
  verdict: ProtectedBranchVerdict,
): string {
  const name = normalizeBranchName(branch);
  const why =
    verdict.reason === "default-branch"
      ? `it is the default branch of this repository`
      : `it is a trunk or release branch`;
  return (
    `Refusing to ${action} "${name}": ${why}, and landing code there is a human decision. ` +
    `Nothing was changed. Open a pull request and ask a person to merge it.`
  );
}
