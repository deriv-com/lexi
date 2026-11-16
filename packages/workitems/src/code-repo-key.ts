import type { RepoRegistry } from "./repo-registry";

/**
 * Resolving a dispatch target into `WorkItem.codeRepoKey`.
 *
 * The column is documented as "`config/repos.yaml` key with role=code", and it
 * went unwritten for a good reason: the only repo identity available at the
 * dispatch point is an `organization/repository`, which is a *different
 * identifier*. Writing a slug into a column documented to hold a key would
 * have been worse than leaving it null, because nothing downstream could tell
 * the wrong-shaped value from a right one.
 *
 * So this is a resolution, never a transform. `repos.yaml` already knows which
 * key owns which slug and which roles that key holds — `home_web` is not
 * derivable from `acme/web-app` by any case or separator rewrite, and a
 * hand-rolled mapping would be a second source of truth that drifts the moment
 * either side changes. {@link RepoRegistry.resolveBySlug} is the lookup; this
 * module only adds the role constraint and the vocabulary for failing loudly.
 */

/**
 * Where the resolution stands for one work item.
 *
 * `UNREGISTERED` and `NOT_A_CODE_REPO` are deliberately distinct even though
 * both end in a null column. "no such repo in repos.yaml" and "that repo is
 * registered but is not a code repo" are different config gaps with different
 * fixes — add an entry, versus add a role to an entry that already exists.
 * Collapsing them would tell whoever investigates to do the wrong one.
 */
export const CODE_REPO_KEY_STATUS = {
  RESOLVED: "resolved",
  UNREGISTERED: "unregistered",
  NOT_A_CODE_REPO: "not_a_code_repo",
  /**
   * The slug is registered under SEVERAL keys, so it does not name one repo.
   *
   * A monorepo holding a web app in `web/` and a mobile app in `mobile/` is
   * two keys differing only by `workdir`. A slug cannot pick
   * between them, and taking the first would file half the work items under
   * the other app's key — a wrong-but-plausible value, which is precisely the
   * failure this module was written to avoid. A fourth status rather than a
   * silent choice, for the same reason `UNREGISTERED` and `NOT_A_CODE_REPO`
   * are two: the fix is different. Here it is to resolve by key, which the
   * caller can do only if it holds one.
   */
  AMBIGUOUS: "ambiguous",
} as const;

export type CodeRepoKeyStatus =
  (typeof CODE_REPO_KEY_STATUS)[keyof typeof CODE_REPO_KEY_STATUS];

/** `WorkItem.metadata` keys this module owns. */
export const CODE_REPO_KEY_STATUS_METADATA_KEY = "codeRepoKeyStatus";
export const CODE_REPO_SLUG_METADATA_KEY = "codeRepoSlug";
export const CODE_REPO_KEY_REJECTED_METADATA_KEY = "codeRepoKeyRejected";

/**
 * The outcome of one lookup.
 *
 * Only the `RESOLVED` variant carries a `key`, and that is the point: the type
 * makes "write whatever key we found" unreachable for a repo that failed the
 * role check, so the constraint the column documents is enforced by
 * construction rather than restated in a comment a caller can ignore.
 */
export type CodeRepoKeyResolution =
  | { status: typeof CODE_REPO_KEY_STATUS.RESOLVED; key: string; slug: string }
  | { status: typeof CODE_REPO_KEY_STATUS.UNREGISTERED; slug: string }
  | { status: typeof CODE_REPO_KEY_STATUS.NOT_A_CODE_REPO; key: string; slug: string }
  // Carries every candidate rather than one of them, so whoever investigates
  // sees the choice that could not be made instead of a key they must then
  // guess the provenance of.
  | { status: typeof CODE_REPO_KEY_STATUS.AMBIGUOUS; keys: string[]; slug: string };

/**
 * Resolve an `organization/repository` into the `repos.yaml` key that owns it,
 * subject to that key holding the `code` role.
 *
 * Never invents a key. An unknown slug is reported as unknown — a repo missing
 * from the registry is a config gap someone should close, and the only way it
 * gets closed is if the gap is visible rather than papered over with a guess.
 */
export function resolveCodeRepoKey(
  registry: RepoRegistry,
  slug: string,
): CodeRepoKeyResolution {
  // resolveAllBySlug, not resolveBySlug: one slug can name several apps in a
  // monorepo, and a first match would be a plausible wrong key.
  const matches = registry.resolveAllBySlug(slug);
  if (matches.length === 0) return { status: CODE_REPO_KEY_STATUS.UNREGISTERED, slug };
  if (matches.length > 1) {
    return {
      status: CODE_REPO_KEY_STATUS.AMBIGUOUS,
      keys: matches.map((match) => match.key),
      slug,
    };
  }
  const repo = matches[0]!;

  // The constraint the column documents. `issues` resolves cleanly
  // and holds `roles: [issues]` — a successful lookup is not a licence.
  if (!repo.roles.includes("code")) {
    return { status: CODE_REPO_KEY_STATUS.NOT_A_CODE_REPO, key: repo.key, slug };
  }

  return { status: CODE_REPO_KEY_STATUS.RESOLVED, key: repo.key, slug };
}

/** The key to persist, or `null` when none may be. */
export function codeRepoKeyFor(resolution: CodeRepoKeyResolution): string | null {
  return resolution.status === CODE_REPO_KEY_STATUS.RESOLVED ? resolution.key : null;
}

/**
 * The `WorkItem.metadata` fragment for one resolution.
 *
 * Always writes a status, including when the key resolved cleanly — an absent
 * status is indistinguishable from a row written before this existed, and that
 * ambiguity is exactly what makes a config gap survivable. `codeRepoKeyStatus`
 * is queryable the same way `specProvenanceStatus` is, so "which dispatches
 * targeted a repo we do not have registered" is a question with an answer.
 *
 * The rejected key IS recorded for `NOT_A_CODE_REPO` — that names the
 * `repos.yaml` entry whose `roles` need fixing. It lives in a free-form
 * diagnostic blob, which is a different thing from the documented column: the
 * column still says only what it promises.
 */
export function codeRepoKeyMetadata(
  resolution: CodeRepoKeyResolution,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    [CODE_REPO_KEY_STATUS_METADATA_KEY]: resolution.status,
    [CODE_REPO_SLUG_METADATA_KEY]: resolution.slug,
  };

  if (resolution.status === CODE_REPO_KEY_STATUS.NOT_A_CODE_REPO) {
    base[CODE_REPO_KEY_REJECTED_METADATA_KEY] = resolution.key;
  }

  // Same blob, same purpose: name what was rejected. Here it is every
  // candidate, joined, because the finding IS the plurality.
  if (resolution.status === CODE_REPO_KEY_STATUS.AMBIGUOUS) {
    base[CODE_REPO_KEY_REJECTED_METADATA_KEY] = resolution.keys.join(", ");
  }

  return base;
}

/**
 * The operator-facing sentence for a resolution that produced no key, or
 * `null` when there is nothing to report.
 *
 * Returned rather than logged so the caller keeps its own logger and context
 * prefix — and so the wording of a config finding lives next to the rules that
 * decide it is one.
 */
export function describeUnresolvedCodeRepo(
  resolution: CodeRepoKeyResolution,
): string | null {
  if (resolution.status === CODE_REPO_KEY_STATUS.UNREGISTERED) {
    return (
      `dispatch target ${resolution.slug} matches no entry in config/repos.yaml, so WorkItem.codeRepoKey ` +
      `is left null (no key was guessed). This work item cannot be traced to a registered code repo — ` +
      `add ${resolution.slug} to the repository registry.`
    );
  }

  if (resolution.status === CODE_REPO_KEY_STATUS.NOT_A_CODE_REPO) {
    return (
      `dispatch target ${resolution.slug} resolves to config/repos.yaml key "${resolution.key}", which does not ` +
      `hold the code role, so WorkItem.codeRepoKey is left null — that column documents role=code. ` +
      `Give "${resolution.key}" the code role if it really is a dispatch target.`
    );
  }

  if (resolution.status === CODE_REPO_KEY_STATUS.AMBIGUOUS) {
    return (
      `dispatch target ${resolution.slug} is registered in config/repos.yaml under ${resolution.keys.length} keys ` +
      `(${resolution.keys.join(", ")}), so the slug alone does not name one app and WorkItem.codeRepoKey is left ` +
      `null rather than filled with whichever key sorted first. This is a monorepo holding several apps; the ` +
      `dispatcher must carry the repo key, not just the slug, for this column to be fillable.`
    );
  }

  return null;
}
