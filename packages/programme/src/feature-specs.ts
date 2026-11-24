/**
 * Per-page feature specs: the rebuild repo keeps one Markdown
 * document per feature under a directory such as `docs/feature-spec/`, and a
 * build task must read the one(s) for the page it builds.
 *
 * Matching is by name, because the directory is authored by people and has
 * no machine-readable index. A screen is a prototype route — `(auth)/login`,
 * `(auth)/signup/verify`, `home` — and a spec matches it when:
 *   - its file name carries the route's last segment (`login.md`,
 *     `01-login-page.md`, `auth/login.md`), prefix-tolerant so `verify`
 *     finds `verification.md`; or
 *   - its name is made only of the route's own segments (`auth.md` covers
 *     every `(auth)/…` screen, `signup.md` covers `(auth)/signup/verify`).
 * A screen no file matches is not a failure: the brief then names the
 * directory and tells the agent to pick the covering spec itself.
 */

/** Words that describe a document rather than a feature, ignored in matching. */
const FILLER = new Set(["spec", "specs", "feature", "features", "page", "pages", "screen", "screens", "flow", "md"]);

/** Index files describe the directory, not one feature. */
const INDEX_NAMES = new Set(["readme", "index", "_index", "overview"]);

function stripBracketSegments(value: string): string {
  let out = "";
  let pos = 0;
  while (pos < value.length) {
    const open = value.indexOf("[", pos);
    if (open === -1) {
      out += value.slice(pos);
      break;
    }
    out += value.slice(pos, open);
    const close = value.indexOf("]", open + 1);
    if (close === -1) {
      out += value.slice(open);
      break;
    }
    out += " ";
    pos = close + 1;
  }
  return out;
}

function tokens(value: string): string[] {
  return stripBracketSegments(value.toLowerCase()) // dynamic segments: [id], [...slug]
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !/^\d+$/.test(token));
}

function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  // verify ↔ verification, account ↔ accounts — but not signup ↔ signin,
  // login ↔ logout, or "in" ↔ "invite": the shared prefix must be the whole
  // shorter word bar at most its last letter.
  const shorter = a.length <= b.length ? a : b;
  let common = 0;
  while (common < shorter.length && a[common] === b[common]) common += 1;
  return shorter.length >= 4 && common >= Math.max(4, shorter.length - 1);
}

/** The file's name relative to the spec directory, without `.md`. */
function specName(path: string, dir: string): string {
  const relative = path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path;
  return relative.replace(/\.md$/i, "");
}

export function isFeatureSpecIndex(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  return INDEX_NAMES.has(base.replace(/\.md$/i, "").toLowerCase());
}

/**
 * The feature-spec files among `paths` that cover `screen`, sorted. `paths`
 * are repo-relative `.md` blobs under `dir`; index files never match.
 */
export function matchFeatureSpecs(screen: string, paths: readonly string[], dir: string): string[] {
  const segments = screen.split("/").filter(Boolean);
  const leaf = tokens(segments[segments.length - 1] ?? "").filter((token) => !FILLER.has(token));
  const screenWords = tokens(screen).filter((token) => !FILLER.has(token));
  if (screenWords.length === 0) return [];

  return paths
    .filter((path) => !isFeatureSpecIndex(path))
    .filter((path) => {
      const words = tokens(specName(path, dir)).filter((token) => !FILLER.has(token));
      if (words.length === 0) return false;
      const byLeaf = leaf.length > 0 && leaf.every((want) => words.some((have) => sameWord(want, have)));
      const byRoute = words.every((have) => screenWords.some((want) => sameWord(want, have)));
      return byLeaf || byRoute;
    })
    .sort((a, b) => a.localeCompare(b));
}

/** Union of the matches for every screen, sorted and de-duplicated. */
export function featureSpecsForScreens(
  screens: readonly string[],
  paths: readonly string[],
  dir: string,
): string[] {
  return [...new Set(screens.flatMap((screen) => matchFeatureSpecs(screen, paths, dir)))].sort((a, b) =>
    a.localeCompare(b),
  );
}
