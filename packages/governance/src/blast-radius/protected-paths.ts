/**
 * Protected paths — files no agent may modify, matched programmatically.
 *
 * This replaces a hand-rolled matcher that was three separate bugs stacked:
 *
 *   new RegExp(pattern.replace(/\*\*\/g, ".*").replace(/\*\/g, "[^/]*"))
 *
 *   1. The two `.replace` calls compound. `**` became `.` + `[^/]*`, not `.*`,
 *      so it could never span more than one directory and required at least one
 *      leading character — `**` + `/auth/**` did not match `auth/login.ts`.
 *   2. The result was unanchored, so every pattern was a substring search.
 *   3. Regex metacharacters in the pattern were never escaped, so the `.` in
 *      `release.yml` matched any character: `releaseXyml` was a hit.
 *
 * The rules here are a deny list for *writes*. They are deliberately strict:
 * a false positive costs a human one override, a false negative lets an agent
 * rewrite a release pipeline.
 */

/** A single deny rule, kept as data so the reason can name which rule fired. */
export interface ProtectedPathRule {
  /** Glob-ish pattern. See `matchesProtectedPattern` for supported syntax. */
  readonly pattern: string;
  /** Human-readable why, surfaced in refusal text. */
  readonly reason: string;
}

/**
 * Converts one pattern to an anchored RegExp.
 *
 * Supported syntax, and nothing else:
 *   `**` — any number of path segments, including zero
 *   `*`  — any run of characters within a single segment (never crosses `/`)
 *   `?`  — exactly one character within a segment
 *
 * Every other character is escaped to its literal. Matching is
 * case-insensitive: `Production.yml` and `PRODUCTION.YML` are the same file to
 * a case-insensitive filesystem, and an agent on macOS can create either.
 */
export function compileProtectedPattern(pattern: string): RegExp {
  // Tokenise first so `**` is consumed before `*` can see it — the compounding
  // bug in the previous implementation was a sequential-replace artefact.
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` should also match zero segments, so `**/x` matches bare `x`.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    // Escape everything else. `.` in `release.yml` must be a literal dot.
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

/**
 * Normalises a path for matching: strips a leading `./` or `/`, collapses
 * duplicate slashes, and rewrites Windows separators. Without this a diff that
 * reports `./config/app.toml` slips past a `config/*.toml` rule.
 */
export function normalizePathForMatch(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\//, "");
}

/** True when `path` matches `pattern` under the syntax above. */
export function matchesProtectedPattern(path: string, pattern: string): boolean {
  return compileProtectedPattern(pattern).test(normalizePathForMatch(path));
}

/**
 * The standing deny list.
 *
 * Release and production pipelines are the target: an agent that can edit the
 * workflow which ships code can ship anything, and an agent that can edit a
 * `.toml` can retarget a build, a registry or a dependency pin. Neither is
 * within the remit of a bug-fix agent.
 *
 * Patterns are matched against repository-relative paths.
 */
export const PROTECTED_PATH_RULES: readonly ProtectedPathRule[] = [
  // --- Release and production pipelines -----------------------------------
  {
    pattern: "**/.github/production*",
    reason: "GitHub production pipeline definition",
  },
  {
    pattern: "**/.github/production*/**",
    reason: "file inside a GitHub production pipeline directory",
  },
  {
    pattern: "**/.github/release*",
    reason: "GitHub release pipeline definition",
  },
  {
    pattern: "**/.github/release*/**",
    reason: "file inside a GitHub release pipeline directory",
  },
  {
    pattern: "**/production.yml",
    reason: "production pipeline definition",
  },
  {
    pattern: "**/production.yaml",
    reason: "production pipeline definition",
  },
  {
    pattern: "**/release.yml",
    reason: "release pipeline definition",
  },
  {
    pattern: "**/release.yaml",
    reason: "release pipeline definition",
  },

  // --- Anything named "production" ----------------------------------------
  // "Named production" means the basename is `production`, or is `production`
  // followed by a separator — `.`, `-` or `_`. Stated as separate rules because
  // the pattern syntax above has no character classes on purpose.
  //
  // This deliberately does NOT match a name that merely *contains* the word:
  // `reproduction-policy.ts` and `productionize.ts` are ordinary source files.
  {
    pattern: "**/production",
    reason: "a file or directory named production",
  },
  {
    pattern: "**/production.*",
    reason: "a production-named file",
  },
  {
    pattern: "**/production-*",
    reason: "a production-prefixed file",
  },
  {
    pattern: "**/production_*",
    reason: "a production-prefixed file",
  },
  {
    pattern: "**/production/**",
    reason: "a file inside a production directory",
  },

  // --- TOML ----------------------------------------------------------------
  // Build, toolchain and dependency manifests: Cargo.toml, pyproject.toml,
  // netlify.toml, wrangler.toml, rust-toolchain.toml.
  {
    pattern: "**/*.toml",
    reason: "a TOML manifest (build, toolchain or deployment configuration)",
  },

  // --- YAML ----------------------------------------------------------------
  // Every .yaml and .yml, not just the pipelines named above. YAML is how this
  // estate declares what runs and with what: GitHub Actions workflows and
  // composite actions, Kubernetes manifests, docker-compose, and Flutter's
  // pubspec.yaml — which is the dependency manifest, the exact analogue of
  // Cargo.toml a few lines up.
  //
  // Both extensions, because the split is not meaningful: Actions uses .yml,
  // Maestro and Flutter use .yaml, and a rule covering only one of them leaves
  // every workflow in .github/workflows editable.
  //
  // KNOWN COST, accepted deliberately: the two mobile repos keep their Maestro
  // E2E suites in YAML (~110 files under .maestro/tests in mobile-app,
  // ~92 in p2p-mobile), so an agent fixing a mobile bug can no longer add
  // or update the E2E test that would demonstrate the fix. That was weighed and
  // chosen — one rule with no carve-outs is easier to audit than one with an
  // exception, and a human can still write the test.
  {
    pattern: "**/*.yaml",
    reason: "a YAML file (pipelines, manifests and configuration live here)",
  },
  {
    pattern: "**/*.yml",
    reason: "a YAML file (pipelines, manifests and configuration live here)",
  },

  // --- Pre-existing rules, carried over ------------------------------------
  // These were in config/autofix-policy.yaml. They are restated here so the
  // deny list has one home, and so they finally match what they intended to:
  // under the old matcher a top-level `auth/` directory was never caught.
  { pattern: "**/auth/**", reason: "authentication code" },
  { pattern: "**/payment/**", reason: "payment code" },
  { pattern: "**/kyc/**", reason: "KYC code" },
  { pattern: "**/migrations/**", reason: "a database migration" },
];

/** The outcome of checking one path. */
export interface ProtectedPathHit {
  readonly path: string;
  readonly pattern: string;
  readonly reason: string;
}

/**
 * Returns every protected-path hit across `paths`. Empty array means no path is
 * protected.
 *
 * `extraPatterns` lets a caller layer repo-specific rules (for example from
 * `config/autofix-policy.yaml`) on top of the standing list without editing it.
 */
export function findProtectedPaths(
  paths: readonly string[],
  extraPatterns: readonly string[] = [],
): ProtectedPathHit[] {
  const rules: ProtectedPathRule[] = [
    ...PROTECTED_PATH_RULES,
    ...extraPatterns.map((pattern) => ({ pattern, reason: "a configured forbidden path pattern" })),
  ];
  // Compile once per rule, not once per (path × rule) as the old loop did.
  const compiled = rules.map((rule) => ({ rule, regex: compileProtectedPattern(rule.pattern) }));

  const hits: ProtectedPathHit[] = [];
  for (const raw of paths) {
    const path = normalizePathForMatch(raw);
    if (!path) continue;
    for (const { rule, regex } of compiled) {
      if (regex.test(path)) {
        hits.push({ path: raw, pattern: rule.pattern, reason: rule.reason });
        break; // One reason per path is enough to refuse it.
      }
    }
  }
  return hits;
}

/** Convenience predicate for a single path. */
export function isProtectedPath(path: string, extraPatterns: readonly string[] = []): boolean {
  return findProtectedPaths([path], extraPatterns).length > 0;
}

/**
 * Renders hits as refusal text. Kept next to the rules so the wording stays
 * consistent across the tool layer and the eligibility gate.
 */
export function describeProtectedPaths(hits: readonly ProtectedPathHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map((hit) => `  - ${hit.path} — ${hit.reason} (rule: ${hit.pattern})`);
  return [
    `Refusing: ${hits.length === 1 ? "this path is" : "these paths are"} on the protected list and must be changed by a human.`,
    ...lines,
  ].join("\n");
}
