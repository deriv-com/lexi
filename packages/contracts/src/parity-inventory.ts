/**
 * Parity-inventory contracts.
 *
 * A rebuild programme references an EXISTING production repo
 * (acme/web-app for Acme Web, say). Build agents in CI never get a
 * token to that repo, so the orchestrator extracts a structural inventory
 * from it — routes, screens, feature flags, analytics events, locale size,
 * env surface, dependencies — and serves it to build briefs. The rebuild
 * must match or exceed it: the inventory is a FLOOR, never a ceiling.
 *
 * Extraction is deterministic and structural (path patterns and source
 * regexes, no model), so two captures of the same tree are byte-identical.
 * Same posture as `ApiContractDocument`: durable, versioned, self-contained.
 */

export type ParityPlatform = "web" | "flutter" | "unknown";

export interface ParityInventoryDocument {
  id: string;
  /** "organization/repository" that was inspected. */
  referenceRepoSlug: string;
  /** Branch (or ref) inspected. */
  ref: string;
  /**
   * Content fingerprint of the tree at capture — the dedupe key. GitHub's
   * recursive tree listing does not return the root tree SHA, so this is a
   * sha256 over every blob's `path\0sha`; an unchanged tree yields the same
   * value and no new version.
   */
  headSha: string;
  /** Monotonic per slug; a re-snapshot is a new version, never an edit. */
  version: number;
  capturedAt: string;
  platform: ParityPlatform;
  /** Route paths / page identifiers, e.g. "/", "/trade/[id]". */
  routes: string[];
  /** Screen / page component names, e.g. "TradePage", "HomeScreen". */
  screens: string[];
  /** Feature-flag identifiers found in source. */
  features: string[];
  /** Analytics event names found in source. */
  analyticsEvents: string[];
  /** Leaf-key count of the English locale files (0 when none were found). */
  i18nKeyCount: number;
  /** process.env.X / import.meta.env.X / fromEnvironment / .env.example names. */
  envVars: string[];
  /** Runtime dependencies from package.json (or pubspec.yaml), name → version. */
  dependencies: Record<string, string>;
  /** Blobs in the inspected tree, read or not. */
  fileCount: number;
  /** What could NOT be inspected — honest gaps a brief must not paper over. */
  notes: string[];
}
