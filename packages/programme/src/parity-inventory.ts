import { load } from "js-yaml";
import type { ParityInventoryDocument, ParityPlatform } from "@lexi/contracts";

/**
 * Pure, deterministic extraction of a parity inventory
 * from a file listing plus whatever contents the caller managed to read.
 *
 * Structural only — path patterns and source regexes, no model. Every list
 * is sorted, deduped and capped, so the same input always yields the same
 * document and two snapshots of one tree compare byte-for-byte. Anything
 * that could not be inspected is written down in `notes` rather than
 * silently omitted: a brief treats this as a FLOOR, and a floor built on an
 * unacknowledged gap is a lie.
 *
 * I/O (listing the tree, reading blobs, persistence) lives in the
 * orchestrator's `ParityInventoryService`.
 */

export interface ParityInventoryFile {
  /** Repo-relative path, forward slashes, no leading slash. */
  path: string;
  /** Absent when the file was listed but not read (budget, size, error). */
  content?: string;
}

export interface ParityInventoryInput {
  files: ParityInventoryFile[];
  /** Overrides detection when the caller already knows. */
  platform?: ParityPlatform;
}

export type ParityInventoryExtract = Omit<
  ParityInventoryDocument,
  "id" | "referenceRepoSlug" | "ref" | "headSha" | "version" | "capturedAt"
>;

/** Every list in the document is cut here, with a note when it happens. */
export const PARITY_LIST_CAP = 500;

/* ------------------------------------------------------------------------ */
/* Path classification                                                       */
/* ------------------------------------------------------------------------ */

const SOURCE_EXT = /\.(?:tsx?|jsx?|mjs|cjs|dart)$/;
const IGNORED_PATH =
  /(?:^|\/)(?:node_modules|dist|build|out|coverage|\.next|\.dart_tool|ios|android|macos|windows|linux|\.git)\//;
const TEST_PATH = /(?:\.(?:test|spec|stories)\.|(?:^|\/)(?:__tests__|__mocks__|test|tests|integration_test)\/)/;
const GENERATED_EXT = /\.(?:d\.ts|g\.dart|freezed\.dart|gr\.dart|mocks\.dart)$/;

/** A plain source file worth reading for flags/events/env — not test, not generated. */
export function isParitySourcePath(path: string): boolean {
  return (
    SOURCE_EXT.test(path) &&
    !IGNORED_PATH.test(path) &&
    !TEST_PATH.test(path) &&
    !GENERATED_EXT.test(path)
  );
}

// Next.js conventions: `app/` or `pages/` at the repo root, under `src/`, or
// under one workspace package (`apps/web/src/app/...`). Deeper `pages/`
// directories are component folders, not routers, and are treated as screens.
const NEXT_APP_PAGE = /^(?:(?:apps|packages)\/[^/]+\/)?(?:src\/)?app\/(?:(.+)\/)?page\.(?:tsx|jsx|ts|js)$/;
const NEXT_PAGES_FILE = /^(?:(?:apps|packages)\/[^/]+\/)?(?:src\/)?pages\/(.+)\.(?:tsx|jsx|ts|js)$/;
const ROUTER_DIR = /(?:^|\/)(?:routes|router|routing|navigation)\//;
const SCREEN_DIR = /(?:^|\/)(?:screens|pages|views)\//;
const FEATURE_DIR = /(?:^|\/)features\//;
const FEATURE_SCREEN_FILE = /(?:Screen|Page|_screen|_page)\.(?:tsx|jsx|ts|js|dart)$/;

function isFeatureScreenPath(path: string): boolean {
  return FEATURE_DIR.test(path) && FEATURE_SCREEN_FILE.test(path);
}

function nextAppRoute(path: string): string | null {
  if (IGNORED_PATH.test(path)) return null;
  const match = NEXT_APP_PAGE.exec(path);
  if (!match) return null;
  // "app/(marketing)/trade/[id]/page.tsx" → ["(marketing)", "trade", "[id]"]
  const segments = (match[1] ?? "")
    .split("/")
    .filter((s) => s.length > 0)
    .filter((s) => !(s.startsWith("(") && s.endsWith(")"))) // route groups
    .filter((s) => !s.startsWith("@")); // parallel-route slots
  return "/" + segments.join("/");
}

function nextPagesRoute(path: string): string | null {
  if (IGNORED_PATH.test(path) || TEST_PATH.test(path) || GENERATED_EXT.test(path)) return null;
  // The app router's "app/" also lives under repos with a "pages/" of
  // non-route components; only treat "pages/" as the pages router when the
  // file is not itself inside an app router tree.
  if (NEXT_APP_PAGE.test(path)) return null;
  const match = NEXT_PAGES_FILE.exec(path);
  if (!match) return null;
  const inner = match[1];
  if (inner.startsWith("api/") || inner === "api") return null;
  const segments = inner.split("/");
  const last = segments[segments.length - 1];
  if (last.startsWith("_")) return null; // _app, _document, _error
  if (last === "index") segments.pop();
  return "/" + segments.join("/");
}

/** True when the path is a Next.js route file (either router). */
export function isParityRoutePath(path: string): boolean {
  return nextAppRoute(path) !== null || nextPagesRoute(path) !== null;
}

/** Files whose PATH alone marks them as screens or route declarations. */
export function isParityScreenPath(path: string): boolean {
  if (!isParitySourcePath(path)) return false;
  return isParityRoutePath(path) || ROUTER_DIR.test(path) || SCREEN_DIR.test(path) || isFeatureScreenPath(path);
}

const LOCALE_DIR = /(?:^|\/)(?:locales?|i18n|translations|lang|languages)\//;
const LOCALE_JSON_TAIL = /(?:^|\/)en(?:[-_][A-Za-z]{2,4})?(?:\/[^/]+)?\.json$/;
const LOCALE_ARB = /(?:^|\/)[^/]*en(?:[-_][A-Za-z]{2,4})?\.arb$/;

function isLocaleJsonPath(path: string): boolean {
  const match = LOCALE_DIR.exec(path);
  if (!match) return false;
  return LOCALE_JSON_TAIL.test(path.slice(match.index + match[0].length));
}

// English locale files: any `locales/` or `i18n/` tree holding `en*.json`
// (file or directory), or an `*en*.arb` bundle for Flutter.
export function isParityLocalePath(path: string): boolean {
  if (IGNORED_PATH.test(path)) return false;
  return isLocaleJsonPath(path) || LOCALE_ARB.test(path);
}

const ENV_EXAMPLE = /(?:^|\/)\.env(?:\.[\w-]+)*\.(?:example|sample|template|dist)$/;

export function isParityEnvExamplePath(path: string): boolean {
  return ENV_EXAMPLE.test(path) && !IGNORED_PATH.test(path);
}

export function isParityManifestPath(path: string): boolean {
  return (path === "package.json" || path === "pubspec.yaml") && !IGNORED_PATH.test(path);
}

const CANDIDATE_ROOT = /^(?:src|app|pages|lib|apps|packages|features|modules)\//;
const NESTED_SOURCE_ROOT = /\/(?:src|lib|app|pages)\//;

export interface ParityFileSelection {
  /** Paths to read, priority order, at most `maxFiles`. */
  selected: string[];
  /** Source files that qualified but fell outside the budget. */
  skippedSourceFiles: number;
}

/**
 * Chooses which blobs are worth READING, in priority order, within a
 * budget. Manifests, env examples and locale files come first because they
 * are cheap and load-bearing; then route/screen files; then everything
 * else under a source root. Deterministic: ties break on path order.
 */
export function selectParityFiles(paths: string[], options: { maxFiles: number }): ParityFileSelection {
  const tiers: string[][] = [[], [], [], []];
  const seen = new Set<string>();
  for (const raw of paths) {
    const path = raw.replace(/^\/+/, "");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (isParityManifestPath(path) || isParityEnvExamplePath(path)) tiers[0].push(path);
    else if (isParityLocalePath(path)) tiers[1].push(path);
    else if (isParityScreenPath(path)) tiers[2].push(path);
    else if (isParitySourcePath(path) && (CANDIDATE_ROOT.test(path) || NESTED_SOURCE_ROOT.test(path)))
      tiers[3].push(path);
  }
  for (const tier of tiers) tier.sort();
  const ordered = tiers.flat();
  const budget = Math.max(0, Math.floor(options.maxFiles));
  return {
    selected: ordered.slice(0, budget),
    skippedSourceFiles: Math.max(0, ordered.length - budget),
  };
}

/* ------------------------------------------------------------------------ */
/* Naming helpers                                                            */
/* ------------------------------------------------------------------------ */

function pascalCase(value: string): string {
  return value
    .replace(/\[\.\.\.(\w+)\]/g, "$1")
    .replace(/[[\]()@]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function baseName(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.replace(/\.[^.]+$/, "");
}

const DEFAULT_EXPORT =
  /export\s+default\s+(?:async\s+)?(?:function\s+([A-Z]\w*)|(?:memo|observer|forwardRef)\(\s*([A-Z]\w*)|([A-Z]\w*)[^\S\r\n]*(?:;[^\S\r\n]*)?$)/m;
const DART_SCREEN_CLASS = /class\s+([A-Z]\w*(?:Screen|Page|View))\s+extends\s+/g;
const GENERIC_COMPONENT_NAMES = new Set(["Page", "Layout", "Component", "Index", "Default", "App"]);

function routeFileScreenName(path: string, content: string | undefined): string {
  if (content) {
    const match = DEFAULT_EXPORT.exec(content);
    const name = match?.[1] ?? match?.[2] ?? match?.[3];
    // `export default function Page()` is the Next.js template, not a name.
    if (name && !GENERIC_COMPONENT_NAMES.has(name)) return name;
  }
  const appRoute = nextAppRoute(path);
  if (appRoute !== null) {
    const name = pascalCase(appRoute);
    return (name || "Index") + "Page";
  }
  const pagesRoute = nextPagesRoute(path);
  if (pagesRoute !== null) {
    const name = pascalCase(pagesRoute);
    return (name || "Index") + "Page";
  }
  return pascalCase(baseName(path));
}

/* ------------------------------------------------------------------------ */
/* Source scanning                                                           */
/* ------------------------------------------------------------------------ */

const RR_PATH_LITERAL = /\bpath\s*[:=]\s*["'`]([^"'`\n]+)["'`]/g;
const FLUTTER_GO_ROUTE = /(?:GoRoute|AutoRoute|MaterialPageRoute|PageRoute|Route)\([^()]*?\bpath\s*:\s*['"]([^'"]+)['"]/g;
const FLUTTER_ROUTE_SETTINGS = /RouteSettings\([^()]*?\bname\s*:\s*['"]([^'"]+)['"]/g;
const FLUTTER_NAMED_ROUTE = /(?:initialRoute|pushNamed|pushReplacementNamed|pushNamedAndRemoveUntil)\s*[:(]\s*(?:context\s*,\s*)?['"](\/[^'"]*)['"]/g;
const FLUTTER_ROUTES_MAP_KEY = /['"](\/[^'"\n]*)['"]\s*:\s*\(/g;

function scanRoutesInSource(path: string, content: string, platform: ParityPlatform, out: Set<string>): void {
  if (platform === "flutter" || path.endsWith(".dart")) {
    collect(FLUTTER_GO_ROUTE, content, out);
    collect(FLUTTER_ROUTE_SETTINGS, content, out);
    collect(FLUTTER_NAMED_ROUTE, content, out);
    if (/\broutes\s*:/.test(content)) collect(FLUTTER_ROUTES_MAP_KEY, content, out);
    return;
  }
  if (ROUTER_DIR.test(path) || /\bcreateBrowserRouter\b|<Route\b|<Routes\b/.test(content)) {
    collect(RR_PATH_LITERAL, content, out);
  }
}

const FEATURE_CALLS =
  /\b(?:useFeatureFlag|useFeatureFlags|isFeatureEnabled|featureEnabled|getFeatureValue|useFeatureIsOn|useFeatureValue|useFeature|evalFeature|isOn|isFeatureOn|getFlag|useFlag)\(\s*['"`]([A-Za-z0-9_.:-]+)['"`]/g;
const FEATURE_PROPERTY = /\b(?:flags|featureFlags)\.([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\()/g;
const REMOTE_CONFIG_GET = /\.(?:getBool|getString|getInt|getDouble|getValue)\(\s*['"]([A-Za-z0-9_.:-]+)['"]/g;
const PROPERTY_NOISE = new Set([
  "length",
  "map",
  "filter",
  "forEach",
  "find",
  "some",
  "every",
  "reduce",
  "includes",
  "push",
  "keys",
  "values",
  "entries",
  "then",
  "catch",
  "default",
  "prototype",
  "constructor",
]);

function scanFeatures(content: string, out: Set<string>): void {
  collect(FEATURE_CALLS, content, out);
  for (const match of content.matchAll(FEATURE_PROPERTY)) {
    const name = match[1];
    if (!PROPERTY_NOISE.has(name)) out.add(name);
  }
  if (/RemoteConfig|remoteConfig|growthbook|GrowthBook/.test(content)) {
    collect(REMOTE_CONFIG_GET, content, out);
  }
}

const ANALYTICS_CALLS = /\b(?:track|trackEvent|logEvent|sendEvent|recordEvent|trackAction)\(\s*['"`]([^'"`\n]+)['"`]/g;
const ANALYTICS_NAMED = /\b(?:logEvent|trackEvent|track)\([^()]*?\bname\s*:\s*['"]([^'"\n]+)['"]/g;

function scanAnalytics(content: string, out: Set<string>): void {
  collect(ANALYTICS_CALLS, content, out);
  collect(ANALYTICS_NAMED, content, out);
}

const ENV_PROCESS = /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
const ENV_PROCESS_INDEX = /\bprocess\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g;
const ENV_IMPORT_META = /\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
const ENV_DART = /\b(?:String|bool|int)\.fromEnvironment\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
const ENV_FILE_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm;
const ENV_NOISE = new Set(["NODE_ENV"]);

function scanEnvInSource(content: string, out: Set<string>): void {
  collect(ENV_PROCESS, content, out);
  collect(ENV_PROCESS_INDEX, content, out);
  collect(ENV_IMPORT_META, content, out);
  collect(ENV_DART, content, out);
}

function collect(pattern: RegExp, content: string, out: Set<string>): void {
  for (const match of content.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (value) out.add(value);
  }
}

/* ------------------------------------------------------------------------ */
/* Manifests and locales                                                     */
/* ------------------------------------------------------------------------ */

function parsePackageDependencies(content: string, notes: string[]): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    notes.push("package.json is not valid JSON; dependencies were not inspected");
    return null;
  }
  const deps = (parsed as { dependencies?: unknown } | null)?.dependencies;
  if (!deps || typeof deps !== "object") return {};
  const out: Record<string, string> = {};
  for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
    out[name] = typeof version === "string" ? version : JSON.stringify(version);
  }
  return out;
}

function parsePubspecDependencies(content: string, notes: string[]): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = load(content);
  } catch {
    notes.push("pubspec.yaml is not valid YAML; dependencies were not inspected");
    return null;
  }
  const deps = (parsed as { dependencies?: unknown } | null)?.dependencies;
  if (!deps || typeof deps !== "object") return {};
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
    if (spec === null || spec === undefined) out[name] = "any";
    else if (typeof spec === "string" || typeof spec === "number") out[name] = String(spec);
    else if (typeof spec === "object") {
      const detail = spec as Record<string, unknown>;
      if (typeof detail.sdk === "string") out[name] = `sdk:${detail.sdk}`;
      else if ("git" in detail) out[name] = "git";
      else if ("path" in detail) out[name] = "path";
      else if (typeof detail.version === "string") out[name] = detail.version;
      else out[name] = "any";
    } else out[name] = String(spec);
  }
  return out;
}

function countLeafKeys(value: unknown, isArb: boolean): number {
  if (value === null || typeof value !== "object") return 1;
  if (Array.isArray(value)) return value.length === 0 ? 1 : value.reduce<number>((n, v) => n + countLeafKeys(v, isArb), 0);
  let count = 0;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isArb && key.startsWith("@")) continue; // ARB metadata, not strings
    count += countLeafKeys(child, isArb);
  }
  return count;
}

/* ------------------------------------------------------------------------ */
/* Entry point                                                               */
/* ------------------------------------------------------------------------ */

function finalise(values: Set<string>, label: string, notes: string[]): string[] {
  const sorted = Array.from(values).sort();
  if (sorted.length > PARITY_LIST_CAP) {
    notes.push(`${label} list capped at ${PARITY_LIST_CAP} (${sorted.length} found)`);
    return sorted.slice(0, PARITY_LIST_CAP);
  }
  return sorted;
}

export function extractParityInventory(input: ParityInventoryInput): ParityInventoryExtract {
  const notes: string[] = [];
  const files = new Map<string, ParityInventoryFile>();
  for (const file of input.files) {
    const path = file.path.replace(/^\/+/, "");
    if (!path || files.has(path)) continue;
    files.set(path, { path, content: file.content });
  }

  const hasPubspec = files.has("pubspec.yaml");
  const hasPackageJson = files.has("package.json");
  const platform: ParityPlatform =
    input.platform ?? (hasPubspec ? "flutter" : hasPackageJson ? "web" : "unknown");

  const routes = new Set<string>();
  const screens = new Set<string>();
  const features = new Set<string>();
  const analyticsEvents = new Set<string>();
  const envVars = new Set<string>();
  let dependencies: Record<string, string> = {};
  let i18nKeyCount = 0;
  let localeFilesFound = 0;
  let localeFilesRead = 0;
  let unreadFiles = 0;

  for (const file of files.values()) {
    const { path, content } = file;
    if (
      content === undefined &&
      (isParitySourcePath(path) || isParityManifestPath(path) || isParityLocalePath(path) || isParityEnvExamplePath(path))
    ) {
      unreadFiles += 1;
    }

    // --- structure from the path alone -----------------------------------
    const appRoute = nextAppRoute(path);
    const pagesRoute = appRoute === null ? nextPagesRoute(path) : null;
    const route = appRoute ?? pagesRoute;
    if (route !== null && platform !== "flutter") {
      routes.add(route);
      screens.add(routeFileScreenName(path, content));
    } else if (
      isParitySourcePath(path) &&
      // `_app`, `_document`, `api/*` live in the pages router but are not screens.
      !NEXT_PAGES_FILE.test(path) &&
      (SCREEN_DIR.test(path) || isFeatureScreenPath(path))
    ) {
      const base = baseName(path);
      if (!/^index$/i.test(base)) screens.add(pascalCase(base));
    }

    // --- locale files ----------------------------------------------------
    if (isParityLocalePath(path)) {
      localeFilesFound += 1;
      if (content !== undefined) {
        try {
          const parsed = JSON.parse(content) as unknown;
          i18nKeyCount += countLeafKeys(parsed, path.endsWith(".arb"));
          localeFilesRead += 1;
        } catch {
          notes.push(`${path} is not valid JSON; its keys were not counted`);
        }
      }
      continue;
    }

    // --- manifests -------------------------------------------------------
    if (path === "package.json") {
      if (content === undefined) notes.push("package.json was listed but not read; dependencies are unknown");
      else dependencies = parsePackageDependencies(content, notes) ?? dependencies;
      continue;
    }
    if (path === "pubspec.yaml") {
      if (content === undefined) notes.push("pubspec.yaml was listed but not read; dependencies are unknown");
      else dependencies = parsePubspecDependencies(content, notes) ?? dependencies;
      continue;
    }

    // --- env examples ----------------------------------------------------
    if (isParityEnvExamplePath(path)) {
      if (content === undefined) notes.push(`${path} was listed but not read; its env names are unknown`);
      else {
        for (const match of content.matchAll(ENV_FILE_LINE)) envVars.add(match[1]);
      }
      continue;
    }

    // --- source scanning -------------------------------------------------
    if (content === undefined || !isParitySourcePath(path)) continue;
    if (path.endsWith(".dart")) {
      for (const match of content.matchAll(DART_SCREEN_CLASS)) screens.add(match[1]);
    }
    scanRoutesInSource(path, content, platform, routes);
    scanFeatures(content, features);
    scanAnalytics(content, analyticsEvents);
    scanEnvInSource(content, envVars);
  }

  for (const noise of ENV_NOISE) envVars.delete(noise);

  if (unreadFiles > 0) {
    notes.push(
      `${unreadFiles} relevant files (source, manifest, locale or env) were listed without content and were inspected by path only`,
    );
  }
  if (localeFilesFound === 0) notes.push("no locale files found; i18nKeyCount is 0");
  else if (localeFilesRead < localeFilesFound) {
    notes.push(
      `${localeFilesFound - localeFilesRead} of ${localeFilesFound} locale files were not read; i18nKeyCount is a lower bound`,
    );
  }
  if (!hasPackageJson && !hasPubspec) notes.push("no package.json or pubspec.yaml at the repo root; dependencies are unknown");
  if (routes.size === 0) notes.push("no route declarations recognised");

  const sortedDependencies: Record<string, string> = {};
  for (const name of Object.keys(dependencies).sort()) sortedDependencies[name] = dependencies[name];

  return {
    platform,
    routes: finalise(routes, "routes", notes),
    screens: finalise(screens, "screens", notes),
    features: finalise(features, "features", notes),
    analyticsEvents: finalise(analyticsEvents, "analyticsEvents", notes),
    i18nKeyCount,
    envVars: finalise(envVars, "envVars", notes),
    dependencies: sortedDependencies,
    fileCount: files.size,
    notes,
  };
}
