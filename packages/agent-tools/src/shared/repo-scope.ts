import type { AuthorizationResource } from "@lexi/agent";
import type { RepoDescriptor, RepoRole } from "@lexi/contracts";

/** A repository a tool may act on, resolved from what the model passed. */
export interface RepoTarget {
  owner: string;
  repo: string;
  /** "owner/repo". */
  slug: string;
  /** Team that owns the repository, for team-scoped authorization. */
  team?: string;
  /** The repository's default branch, when the deployment knows it. */
  defaultBranch?: string;
}

/**
 * The set of repositories a module works with.
 *
 * Every repository-touching tool resolves its target through one of these, so
 * a model cannot point a tool at a repository the operator never configured.
 * Anything that does not resolve is refused, never guessed.
 */
export interface RepoScope {
  /** Resolves an "owner/repo" slug (or a registry key, where supported). */
  resolve(ref: unknown): RepoTarget | null;
  /** The accepted values, for schema descriptions and refusal messages. */
  describe(): string;
}

const SLUG = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

export function parseRepoSlug(value: string): { owner: string; repo: string } | null {
  const match = SLUG.exec(value.trim());
  if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") return null;
  return { owner: match[1], repo: match[2] };
}

export interface StaticRepoEntry {
  slug: string;
  team?: string;
  defaultBranch?: string;
}

/** A fixed allowlist of repositories, matched case-insensitively. */
export function staticRepoScope(entries: ReadonlyArray<string | StaticRepoEntry>): RepoScope {
  const targets = new Map<string, RepoTarget>();
  for (const entry of entries) {
    const spec = typeof entry === "string" ? { slug: entry } : entry;
    const parsed = parseRepoSlug(spec.slug);
    if (!parsed) throw new Error(`Not an "owner/repo" slug: ${JSON.stringify(spec.slug)}`);
    targets.set(spec.slug.toLowerCase(), {
      ...parsed,
      slug: `${parsed.owner}/${parsed.repo}`,
      ...(spec.team ? { team: spec.team } : {}),
      ...(spec.defaultBranch ? { defaultBranch: spec.defaultBranch } : {}),
    });
  }
  return {
    resolve(ref) {
      if (typeof ref !== "string") return null;
      return targets.get(ref.trim().toLowerCase()) ?? null;
    },
    describe() {
      return [...targets.values()].map((t) => t.slug).join(", ") || "(none configured)";
    },
  };
}

/** The slice of `RepoRegistry` from `@lexi/workitems` a scope needs. */
export interface RepoRegistryLike {
  listRepos(): RepoDescriptor[];
  /** Repositories carrying a role, placeholders excluded. */
  reposWithRole(role: RepoRole): RepoDescriptor[];
}

/**
 * Repositories from the role-aware registry. Accepts either the registry key
 * ("home_web") or the slug ("acme/web-app"). With a role, only repositories
 * carrying it resolve, and placeholder repositories are excluded by the
 * registry itself: a placeholder can be read but never written.
 */
export function registryRepoScope(registry: RepoRegistryLike, role?: RepoRole): RepoScope {
  const eligible = (): RepoDescriptor[] => (role ? registry.reposWithRole(role) : registry.listRepos());
  const toTarget = (repo: RepoDescriptor): RepoTarget => ({
    owner: repo.organization,
    repo: repo.repository,
    slug: repo.slug,
    ...(repo.team ? { team: repo.team } : {}),
    ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch } : {}),
  });
  return {
    resolve(ref) {
      if (typeof ref !== "string" || !ref.trim()) return null;
      const wanted = ref.trim().toLowerCase();
      const repos = eligible();
      const byKey = repos.find((repo) => repo.key.toLowerCase() === wanted);
      if (byKey) return toTarget(byKey);
      // A slug that two registry entries share (two apps in one repository)
      // still names one GitHub repository, so either entry resolves it.
      const bySlug = repos.find((repo) => repo.slug.toLowerCase() === wanted);
      return bySlug ? toTarget(bySlug) : null;
    },
    describe() {
      const repos = eligible();
      return repos.length ? repos.map((repo) => `${repo.key} (${repo.slug})`).join(", ") : "(none configured)";
    },
  };
}

export function asRepoScope(value: RepoScope | ReadonlyArray<string | StaticRepoEntry>): RepoScope {
  return Array.isArray(value) ? staticRepoScope(value) : (value as RepoScope);
}

export function unknownRepoMessage(ref: unknown, scope: RepoScope): string {
  const shown = typeof ref === "string" && ref.trim() ? `"${ref.trim()}"` : "no repository";
  return `${shown} is not a repository this deployment works with. Use one of: ${scope.describe()}.`;
}

/** The authorization resource for a call that targets `ref`. */
export function repoResource(
  scope: RepoScope,
  ref: unknown,
  issueNumber?: unknown,
): AuthorizationResource | undefined {
  const target = scope.resolve(ref);
  if (!target) return undefined;
  return {
    repository: target.slug,
    ...(target.team ? { team: target.team } : {}),
    ...(typeof issueNumber === "number" && Number.isSafeInteger(issueNumber) ? { issueNumber } : {}),
  };
}

export const REPOSITORY_PROPERTY = (scope: RepoScope) => ({
  type: "string",
  description: `Repository, as "owner/repo". One of: ${scope.describe()}.`,
});
