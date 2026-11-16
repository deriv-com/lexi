import type { DirectFixSettings, PreviewLinkSettings } from "@lexi/contracts";
import type { RepoRegistry } from "./repo-registry";

/**
 * The workflow every original product repo hosts — `acme/web-app`,
 * `acme-internal/mobile-app`, `acme/p2p-web` and
 * `acme-internal/p2p-mobile`. An entry without a `directFix` block keeps
 * dispatching exactly this, at its `defaultBranch`, with no platform input.
 */
export const DEFAULT_DIRECT_FIX_WORKFLOW_FILE = "direct-fix.yml";

/** What a dispatch site needs, with the defaults already applied. */
export interface ResolvedDirectFixSettings {
  workflow: string;
  /** The ref to dispatch at — the run checks it out and its PR must target it. */
  ref: string;
  /**
   * True only when `directFix.ref` names a working branch. The dispatch site
   * stamps a BASE BRANCH station then, because the workflow has no input for
   * it and `gh pr create` would otherwise target the repository default.
   */
  refIsWorkingBranch: boolean;
  targetPlatform?: DirectFixSettings["targetPlatform"];
}

/**
 * Settings for dispatching `productKey`'s direct fix.
 *
 * `fallbackRef` is the ref the caller would have used before this existed (the
 * product's `defaultBranch`), so an unknown key degrades to today's dispatch
 * rather than to a different one.
 */
export function resolveDirectFixSettings(
  registry: Pick<RepoRegistry, "resolveRepo">,
  productKey: string | undefined,
  fallbackRef: string | undefined,
): ResolvedDirectFixSettings {
  const repo = productKey ? registry.resolveRepo(productKey) : null;
  const settings = repo?.directFix;
  const baseRef = fallbackRef?.trim() || repo?.defaultBranch || "main";
  const ref = settings?.ref?.trim() || baseRef;
  return {
    workflow: settings?.workflow ?? DEFAULT_DIRECT_FIX_WORKFLOW_FILE,
    ref,
    refIsWorkingBranch: Boolean(settings?.ref?.trim()) && ref !== baseRef,
    ...(settings?.targetPlatform ? { targetPlatform: settings.targetPlatform } : {}),
  };
}

/**
 * The workflow file to poll for a run dispatched at `slug`.
 *
 * Keyed by slug because that is all a persisted attempt row carries. A workflow
 * file is a property of the REPOSITORY, not of the app, so two keys sharing a
 * slug (the web and mobile rebuilds) cannot legitimately disagree about it; the
 * first entry that declares one wins.
 */
export function directFixWorkflowForSlug(
  registry: Pick<RepoRegistry, "resolveAllBySlug">,
  slug: string,
): string {
  const declared = registry.resolveAllBySlug(slug).find((repo) => repo.directFix?.workflow);
  return declared?.directFix?.workflow ?? DEFAULT_DIRECT_FIX_WORKFLOW_FILE;
}

/**
 * Where a PR on `slug` gets its test link from, or `null`.
 *
 * Keyed by slug for the same reason as {@link directFixWorkflowForSlug}. The web
 * and mobile rebuilds share a slug, so the first entry that declares one wins.
 */
export function previewLinkForSlug(
  registry: Pick<RepoRegistry, "resolveAllBySlug">,
  slug: string,
): PreviewLinkSettings | null {
  return registry.resolveAllBySlug(slug).find((repo) => repo.previewLink)?.previewLink ?? null;
}

/** Every slug that opted into the preview link relay, de-duplicated. */
export function previewLinkSlugs(registry: Pick<RepoRegistry, "listRepos">): string[] {
  return [...new Set(registry.listRepos().filter((repo) => repo.previewLink).map((repo) => repo.slug))];
}
