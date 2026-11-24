import { loadRepoRegistry, type RepoRegistry } from "./repo-registry";

/**
 * Registry-derived `platform` property for agent tool schemas.
 *
 * `platform: { type: "string", enum: ["web", "mobile"] }` was hard-coded into
 * six tool-schema sites, and — worse — so was the prose that told the model
 * which repo each value routed to. Adding a repo therefore meant editing six
 * enums and six sentences, and any one of them going stale would send the
 * model a value the dispatcher could not resolve.
 *
 * Both halves are generated here from `config/repos.yaml`, so the enum and the
 * description can never disagree with each other or with the registry. Adding a
 * code repo is a config change — the tool schemas pick it up on the next boot.
 */

export interface PlatformSchemaProperty {
  type: "string";
  enum: string[];
  description: string;
}

/** Drops a trailing run of dots and whitespace without a backtracking expression. */
function stripTrailingDotsAndSpace(value: string): string {
  let end = value.length;
  while (end > 0) {
    const ch = value[end - 1]!;
    if (ch === "." || ch.trim() === "") end -= 1;
    else break;
  }
  return value.slice(0, end);
}

/**
 * The platform values a code-dispatch tool may offer: every non-placeholder
 * repo that declares a platform *and* holds the `code` role. A platform whose
 * repo cannot accept code is never offered, so the model cannot pick a target
 * that is certain to be refused.
 */
export function platformEnumValues(registry: RepoRegistry): string[] {
  return registry.platformKeys();
}

/**
 * The platform values a READ-ONLY tool may offer: every repo holding `code`,
 * placeholders included.
 *
 * Wider than {@link platformEnumValues} on purpose. A placeholder is barred
 * from dispatch, not from being looked at, and building both enums from the
 * dispatch list would leave placeholder repos readable by the App but
 * unnameable by any tool — see `RepoRegistry.readableRepos`.
 */
export function readPlatformEnumValues(registry: RepoRegistry): string[] {
  return registry.readablePlatformKeys();
}

/** "web (acme/web-app) or mobile (acme-internal/mobile-app)". */
export function describePlatformRouting(registry: RepoRegistry): string {
  const parts = registry.platformKeys().map((platform) => {
    const repo = registry.resolveByPlatform(platform);
    return `${platform} (${repo?.slug ?? "unregistered"})`;
  });

  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

/** The same sentence over the read surface. */
export function describeReadPlatformRouting(registry: RepoRegistry): string {
  const parts = registry.readablePlatformKeys().map((platform) => {
    const repo = registry.resolveReadableByPlatform(platform);
    return `${platform} (${repo?.slug ?? "unregistered"})`;
  });

  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

/**
 * Builds the whole property. `sentence` is the tool-specific lead ("Which repo
 * to search", "Which product this bug affects") — the routing facts are
 * appended so each call site states its own intent without restating, and
 * risking contradicting, the registry.
 */
export function buildPlatformSchemaProperty(
  registry: RepoRegistry,
  sentence: string,
): PlatformSchemaProperty {
  const trimmed = stripTrailingDotsAndSpace(sentence.trim());
  return {
    type: "string",
    enum: platformEnumValues(registry),
    description: `${trimmed}. Routes to ${describePlatformRouting(registry)}, per config/repos.yaml.`,
  };
}

let cachedRegistry: RepoRegistry | undefined;

/**
 * The process-wide registry, loaded from `GOVERNANCE_CONFIG_DIR` — the same
 * convention `RepositoryRegistry` is constructed with in `core.providers.ts`.
 *
 * Memoized because the tool-schema sites are plain object literals evaluated
 * on every turn: without this, building the payload would read and re-parse
 * `repos.yaml` once per site, per turn, per loop iteration.
 */
export function defaultRepoRegistry(): RepoRegistry {
  if (!cachedRegistry) {
    cachedRegistry = loadRepoRegistry(process.env.GOVERNANCE_CONFIG_DIR ?? "config");
  }
  return cachedRegistry;
}

/** Drops the registry cache. For tests that rewrite `repos.yaml` on disk. */
export function resetDefaultRepoRegistry(): void {
  cachedRegistry = undefined;
}

/**
 * One-line accessor for the six tool-schema call sites, which have no registry
 * in scope and must stay surgical edits rather than a restructure.
 */
export function platformSchemaProperty(sentence: string): PlatformSchemaProperty {
  return buildPlatformSchemaProperty(defaultRepoRegistry(), sentence);
}

/**
 * Builds the property for a READ-ONLY tool, over the wider read surface.
 *
 * Separate function rather than a flag on {@link buildPlatformSchemaProperty}
 * so the choice is visible at the call site: a reader can see which tools reach
 * the placeholder repos by reading the schema, without holding the placeholder
 * rule in their head. A mutation tool that reached for this by mistake would be
 * offering a target its own dispatcher will refuse, and the name says so.
 */
export function buildReadPlatformSchemaProperty(
  registry: RepoRegistry,
  sentence: string,
): PlatformSchemaProperty {
  const trimmed = stripTrailingDotsAndSpace(sentence.trim());
  return {
    type: "string",
    enum: readPlatformEnumValues(registry),
    description: `${trimmed}. Routes to ${describeReadPlatformRouting(registry)}, per config/repos.yaml. Read-only: some of these repos accept reads but not dispatch, so a platform offered here may be refused by trigger_direct_fix or create_issue.`,
  };
}

/** One-line accessor for the read-tool schema sites. */
export function readPlatformSchemaProperty(sentence: string): PlatformSchemaProperty {
  return buildReadPlatformSchemaProperty(defaultRepoRegistry(), sentence);
}
