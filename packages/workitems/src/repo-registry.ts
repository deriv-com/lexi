import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import { z } from "zod";
import type { RepoDescriptor, RepoRole } from "@lexi/contracts";

/**
 * The role-aware repository registry, loaded from `repos.yaml`.
 *
 * `source.issues` is the issue tracker; `products.*` are the code repos. Role
 * gates every repo-touching capability, so a spec cannot be filed into the bug
 * corpus and a code search cannot be pointed at the tracker:
 *
 *   `code`   -> code search, file reads, agent-fix dispatch, pull requests,
 *               repo-doc chunking
 *   `issues` -> corpus sync, dedup scan, bug intake
 *   `specs`  -> spec-issue creation
 *
 * Separate from `@lexi/governance`'s `RepositoryRegistry`, which answers a
 * different question ("which repo implements this team's work?").
 */

const ROLES = ["issues", "code", "specs"] as const;

const roleSchema = z.enum(ROLES);

const sourceEntrySchema = z.object({
  organization: z.string(),
  repository: z.string(),
  // Defaulted rather than required so an un-migrated repos.yaml still loads:
  // the source repo has only ever been the bug tracker.
  roles: z.array(roleSchema).default(["issues"]),
});

const productEntrySchema = z.object({
  organization: z.string(),
  repository: z.string(),
  /**
   * Deliberately `z.string()`, not an enum: adding a repo must be a config
   * change, not a code change.
   */
  platform: z.string().optional(),
  team: z.string().optional(),
  /** Product repos are code+specs homes unless they say otherwise. */
  roles: z.array(roleSchema).default(["code", "specs"]),
  /**
   * Per-repo autonomy tier. Defaulted to `standard` so every existing entry
   * keeps its posture — pull requests are never merged without a human —
   * without being edited. Only an agent-owned rebuild repo declares
   * `autonomous`, which is what a merge carve-out keys on. A strict enum: a
   * typo here must fail the boot-time parse, not silently read as some third
   * tier.
   */
  autonomyTier: z.enum(["standard", "autonomous"]).default("standard"),
  placeholder: z.boolean().optional().default(false),
  /**
   * Branch `workflow_dispatch` of `direct-fix.yml` targets. GitHub 404s
   * "No ref found for: main" when this is wrong.
   * Omitted products inherit `main`.
   */
  defaultBranch: z.string().min(1).default("main"),
  /**
   * The repository-relative directory holding this app, when the repository
   * holds more than one.
   *
   * A monorepo holding a web app in `web/` and a mobile app in `mobile/` is
   * registered under two keys that name one slug and differ only here. Omitted means
   * the repository root, which is every other entry.
   *
   * It travels with the descriptor rather than sitting in a policy side-table
   * because it is part of *where the app is*, exactly like `defaultBranch`,
   * and because it is the only thing that tells two same-slug keys apart —
   * see {@link RepoRegistry.resolveAllBySlug}.
   *
   * Validated so it can never escape the checkout: no leading or trailing
   * slash, and no `..`.
   */
  workdir: z
    .string()
    .min(1)
    .refine((value) => !value.includes(".."), { message: "workdir must not contain '..'" })
    .refine((value) => !value.startsWith("/") && !value.endsWith("/"), {
      message: "workdir must have no leading or trailing '/'",
    })
    .optional(),
  /**
   * The Projects v2 board this product's issues sit on.
   *
   * `shippedStatus` is the column a card moves to when a quick fix ships (a PR
   * is opened for it). It is config rather than a constant because
   * boards have different vocabularies (`In Review` on one, `In progress` on
   * another), so no single hard-coded string could be right for every board. It is stored
   * verbatim and matched against the board's own options at runtime; nothing
   * normalises or title-cases it.
   *
   * Optional: a board with no agreed column is a documented skip, and a caller
   * must never substitute a column that looks close.
   */
  project: z
    .object({
      organization: z.string(),
      projectNumber: z.number(),
      shippedStatus: z.string().optional(),
    })
    .optional(),
  /**
   * Opt-in override of the direct-fix dispatch contract — see
   * `DirectFixSettings` in `@lexi/contracts`. Strict so a misspelt key fails the
   * boot-time parse instead of silently dispatching the default workflow.
   */
  directFix: z
    .object({
      workflow: z.string().min(1).refine((value) => /^[A-Za-z0-9._-]+\.ya?ml$/.test(value), {
        message: "directFix.workflow must be a bare .yml/.yaml file name",
      }),
      ref: z.string().min(1).optional(),
      targetPlatform: z.enum(["web", "mobile"]).optional(),
    })
    .strict()
    .optional(),
  /**
   * Opt-in: relay a Lexi PR's test link into its thread. See
   * `PreviewLinkSettings` in `@lexi/contracts`. Strict for the same reason as
   * `directFix`.
   */
  previewLink: z
    .object({
      hosts: z.array(z.string().regex(/^[a-z0-9.-]+$/, "previewLink.hosts entries must be bare lowercase domains")).min(1),
      umbrella: z.object({ branch: z.string().min(1), into: z.string().min(1) }).strict().optional(),
    })
    .strict()
    .optional(),
});

const repoRegistryConfigSchema = z.object({
  version: z.number(),
  source: z.object({ issues: sourceEntrySchema }),
  products: z.record(z.string(), productEntrySchema),
});

export type RepoRegistryConfig = z.input<typeof repoRegistryConfigSchema>;
export type ParsedRepoRegistryConfig = z.infer<typeof repoRegistryConfigSchema>;

/** The key the source repo is addressed by, matching its YAML path. */
export const ISSUES_REPO_KEY = "issues";

export class RepoRegistry {
  private readonly repos: RepoDescriptor[];

  constructor(config: RepoRegistryConfig) {
    const parsed = repoRegistryConfigSchema.parse(config);

    const source = parsed.source.issues;
    this.repos = [
      {
        key: ISSUES_REPO_KEY,
        organization: source.organization,
        repository: source.repository,
        slug: `${source.organization}/${source.repository}`,
        roles: source.roles,
      },
      ...Object.entries(parsed.products).map(([key, entry]) => ({
        key,
        organization: entry.organization,
        repository: entry.repository,
        slug: `${entry.organization}/${entry.repository}`,
        roles: entry.roles,
        platform: entry.platform,
        team: entry.team,
        autonomyTier: entry.autonomyTier,
        defaultBranch: entry.defaultBranch,
        // Spread rather than assigned so an omitted workdir is ABSENT, not
        // `undefined`: `"workdir" in descriptor` is how a caller distinguishes
        // "builds at the root" from a descriptor built before this existed.
        ...(entry.workdir ? { workdir: entry.workdir } : {}),
        ...(entry.project ? { project: entry.project } : {}),
        ...(entry.directFix ? { directFix: entry.directFix } : {}),
        ...(entry.previewLink ? { previewLink: entry.previewLink } : {}),
      })),
    ];

    this.placeholders = new Set(
      Object.entries(parsed.products)
        .filter(([, entry]) => entry.placeholder)
        .map(([key]) => key),
    );
  }

  private readonly placeholders: Set<string>;

  /** Every registered repo, placeholders included. */
  listRepos(): RepoDescriptor[] {
    return [...this.repos];
  }

  /** `resolveRepo(key) -> {slug, roles, platform, team}`; null when unknown. */
  resolveRepo(key: string): RepoDescriptor | null {
    return this.repos.find((repo) => repo.key === key) ?? null;
  }

  /**
   * Reverse lookup for callers that only hold an `organization/repository`.
   *
   * Returns the FIRST registered match. That is exact for every slug
   * registered once, and it is not a complete answer for a monorepo that is
   * registered under several keys. A slug is not a unique identity there, and
   * no tiebreak inside this method could invent one: the caller holds the
   * extra information, or does not.
   *
   * Use this for an existence question ("is this repo one Lexi knows?"), and
   * {@link resolveAllBySlug} whenever the answer would DIFFER between two
   * same-slug entries — `platform`, `key`, `workdir`. Reading `platform` off
   * a first match is how a mobile PR would be judged as web.
   * {@link isSlugAmbiguous} answers the question directly.
   */
  resolveBySlug(slug: string): RepoDescriptor | null {
    return this.repos.find((repo) => repo.slug === slug) ?? null;
  }

  /**
   * Every entry registered under one `organization/repository`, in config
   * order.
   *
   * Usually length 0 or 1. Length > 1 means a monorepo holding several apps,
   * where the entries differ by `workdir` (and `platform`, and `key`). A
   * caller that must pick one needs something the slug does not carry — the
   * task's repo key, or the changed paths on a PR — and a caller that cannot
   * should refuse rather than take the first.
   */
  resolveAllBySlug(slug: string): RepoDescriptor[] {
    return this.repos.filter((repo) => repo.slug === slug);
  }

  /**
   * Whether this slug names more than one registered app, i.e. whether
   * {@link resolveBySlug} is answering with one of several.
   *
   * Exists so a caller can say "this repo holds two apps and I was given no
   * way to tell which" instead of silently reporting the first one's
   * platform, key or workdir as though it were the only one.
   */
  isSlugAmbiguous(slug: string): boolean {
    return this.resolveAllBySlug(slug).length > 1;
  }

  /**
   * Every repo holding `role`, excluding placeholders — a placeholder repo is
   * not offered as a DISPATCH target, so nothing can file an issue into it or
   * trigger a fix there.
   *
   * This is a write gate, not a visibility gate. For reading a repo's contents
   * use {@link readableRepos} — see the note there for why the two must not be
   * the same list.
   */
  reposWithRole(role: RepoRole): RepoDescriptor[] {
    return this.repos.filter(
      (repo) => repo.roles.includes(role) && !this.placeholders.has(repo.key),
    );
  }

  /**
   * Every repo Lexi may READ, placeholders included: the `code` role and
   * nothing else.
   *
   * Reading is not dispatching. `placeholder` keeps a repo out of the
   * dispatch surfaces, which is a governance decision about WRITES. Applying
   * it to reads would leave the agent unable to name a repo it can already
   * read, and it would report the failure as a missing installation. Every
   * repo here is one the App can already read, so widening this list grants
   * no access that did not exist.
   *
   * The dispatch surfaces are deliberately untouched: `create_issue`,
   * `trigger_direct_fix`, `trigger_code_task` and every PR/branch mutation
   * still build from `reposWithRole`, so a placeholder remains unwritable.
   */
  readableRepos(): RepoDescriptor[] {
    return this.repos.filter((repo) => repo.roles.includes("code"));
  }

  /**
   * Resolve a readable repo by platform key. The read counterpart of
   * {@link resolveByPlatform} — same lookup, placeholders included.
   */
  resolveReadableByPlatform(platform: string): RepoDescriptor | null {
    return this.readableRepos().find((repo) => repo.platform === platform) ?? null;
  }

  /**
   * The platform keys a READ tool's `enum` is built from. Superset of
   * {@link platformKeys}: same rule, minus the placeholder exclusion.
   *
   * Two registered entries may share a slug but
   * never a platform, so each key still resolves
   * to exactly one entry. For a read that is enough — `workdir` distinguishes
   * the two builds, and a file is read from the repository, not from a workdir.
   */
  readablePlatformKeys(): string[] {
    const keys: string[] = [];
    for (const repo of this.readableRepos()) {
      if (repo.platform && !keys.includes(repo.platform)) {
        keys.push(repo.platform);
      }
    }
    return keys;
  }

  /** The gate question, answered directly. Unknown keys are simply false. */
  hasRole(key: string, role: RepoRole): boolean {
    return this.resolveRepo(key)?.roles.includes(role) ?? false;
  }

  /**
   * The autonomy-tier gate question, answered directly. Unknown keys are
   * simply false — a repo the registry cannot resolve can never be
   * autonomous, whatever the caller believes about it.
   */
  isAutonomous(key: string): boolean {
    return this.resolveRepo(key)?.autonomyTier === "autonomous";
  }

  /**
   * Resolve a code repo by its platform key. This is what lets the tool
   * schemas carry `platform` as *data* — the value the model picks is looked
   * up here rather than being matched against a literal in a switch.
   */
  resolveByPlatform(platform: string): RepoDescriptor | null {
    return (
      this.reposWithRole("code").find((repo) => repo.platform === platform) ?? null
    );
  }

  /**
   * The platform keys the tool schemas' `enum` is built from: every
   * non-placeholder repo that both declares a platform and holds the `code`
   * role. A platform you cannot dispatch code to must never be offered.
   */
  platformKeys(): string[] {
    const keys: string[] = [];
    for (const repo of this.reposWithRole("code")) {
      if (repo.platform && !keys.includes(repo.platform)) {
        keys.push(repo.platform);
      }
    }
    return keys;
  }
}

/** Loads and validates `<configDir>/repos.yaml`. */
export function loadRepoRegistry(configDir: string): RepoRegistry {
  const path = resolve(configDir, "repos.yaml");
  if (!existsSync(path)) {
    throw new Error(`Repository registry not found: ${path} (expected repos.yaml)`);
  }
  return new RepoRegistry(loadYaml(readFileSync(path, "utf8")) as RepoRegistryConfig);
}
