import { describe, expect, it } from "vitest";

import {
  compileProtectedPattern,
  describeProtectedPaths,
  findProtectedPaths,
  isProtectedPath,
  matchesProtectedPattern,
  normalizePathForMatch,
  PROTECTED_PATH_RULES,
} from "./protected-paths";

describe("compileProtectedPattern", () => {
  it("treats ** as a full globstar spanning many segments", () => {
    // The old matcher compiled `**` to `.[^/]*`, which could not cross more
    // than one slash. This is the regression that made deep paths slip past.
    expect(matchesProtectedPattern("a/b/c/d/release.yml", "**/release.yml")).toBe(true);
  });

  it("matches **/x against a bare top-level x", () => {
    // Old behaviour: `**` required at least one character, so a repo with a
    // top-level auth/ directory was entirely unprotected.
    expect(matchesProtectedPattern("auth/login.ts", "**/auth/**")).toBe(true);
    expect(matchesProtectedPattern("release.yml", "**/release.yml")).toBe(true);
  });

  it("escapes regex metacharacters so . is a literal dot", () => {
    // Old behaviour: `release.yml` matched `releaseXyml`.
    expect(matchesProtectedPattern("releaseXyml", "**/release.yml")).toBe(false);
    expect(matchesProtectedPattern("release.yml", "**/release.yml")).toBe(true);
  });

  it("anchors the pattern at both ends", () => {
    // Old behaviour was an unanchored substring test, so a decoy prefix passed.
    expect(matchesProtectedPattern("not-release.yml", "**/release.yml")).toBe(false);
    expect(matchesProtectedPattern("release.yml.bak", "**/release.yml")).toBe(false);
  });

  it("does not let a single * cross a path separator", () => {
    expect(matchesProtectedPattern("config/nested/app.toml", "config/*.toml")).toBe(false);
    expect(matchesProtectedPattern("config/app.toml", "config/*.toml")).toBe(true);
  });

  it("matches ? as exactly one non-separator character", () => {
    expect(matchesProtectedPattern("ab.toml", "a?.toml")).toBe(true);
    expect(matchesProtectedPattern("abc.toml", "a?.toml")).toBe(false);
    expect(matchesProtectedPattern("a/b.toml", "a?b.toml")).toBe(false);
  });

  it("is case-insensitive", () => {
    // An agent on a case-insensitive filesystem can write either spelling.
    expect(matchesProtectedPattern("Production.yml", "**/production.yml")).toBe(true);
    expect(matchesProtectedPattern("PRODUCTION.YML", "**/production.yml")).toBe(true);
    expect(matchesProtectedPattern(".GitHub/Release.yml", "**/.github/release*")).toBe(true);
  });

  it("compiles every shipped rule without throwing", () => {
    // The old matcher had no try/catch: an unbalanced bracket in a pattern
    // threw a SyntaxError out of the whole eligibility evaluation.
    for (const rule of PROTECTED_PATH_RULES) {
      expect(() => compileProtectedPattern(rule.pattern)).not.toThrow();
    }
  });
});

describe("normalizePathForMatch", () => {
  it("strips leading ./ and /", () => {
    expect(normalizePathForMatch("./config/app.toml")).toBe("config/app.toml");
    expect(normalizePathForMatch("/config/app.toml")).toBe("config/app.toml");
  });

  it("rewrites backslashes and collapses duplicate slashes", () => {
    expect(normalizePathForMatch("config\\app.toml")).toBe("config/app.toml");
    expect(normalizePathForMatch("config//app.toml")).toBe("config/app.toml");
  });

  it("still matches a rule after normalisation", () => {
    expect(isProtectedPath("./config/app.toml")).toBe(true);
    expect(isProtectedPath("config\\deploy\\production.yml")).toBe(true);
  });
});

describe("the requested deny list", () => {
  const blocked = [
    // .github/production*
    ".github/production.yml",
    ".github/production-deploy.yml",
    ".github/production/deploy.yml",
    "sub/repo/.github/production.yaml",
    // .github/release
    ".github/release.yml",
    ".github/release/steps.yml",
    ".github/release-please.yml",
    // production.yml / release.yml anywhere
    "deploy/production.yml",
    "a/b/c/release.yml",
    "release.yaml",
    // anything named production
    "production",
    "production.tf",
    "production_build.yml",
    "production-secrets.json",
    "infra/production/main.tf",
    "envs/production",
    // .toml
    "Cargo.toml",
    "pyproject.toml",
    "netlify.toml",
    "deep/nested/wrangler.toml",
    "rust-toolchain.toml",
    // .yaml / .yml — everything, not just the pipelines named by rule above.
    "pubspec.yaml", // Flutter's dependency manifest: the analogue of Cargo.toml
    ".github/workflows/ci.yml",
    ".github/workflows/pr-check.yml",
    ".github/actions/setup/action.yml",
    "kubernetes/deployment.yaml",
    "docker-compose.yml",
    "config/app.yaml",
    "deep/nested/anything.yaml",
    // Accepted cost of the no-carve-outs rule: Maestro E2E suites are YAML.
    ".maestro/tests/onboarding/login_test.yaml",
  ];

  it.each(blocked)("blocks %s", (path) => {
    expect(isProtectedPath(path)).toBe(true);
  });

  const allowed = [
    "src/app.ts",
    "README.md",
    "package.json",
    "src/components/Button.tsx",
    // Near-misses that must NOT trip the rules.
    "src/reproduction.ts", // contains "production", but is not named production
    "src/productionize.ts", // prefix without a separator is an ordinary name
    "src/tomlParser.ts", // not a .toml file
    "releases.md", // not release.yml
    "src/yamlParser.ts", // code ABOUT yaml is not yaml
    "docs/workflows.md", // documentation about pipelines is not a pipeline
  ];

  it.each(allowed)("allows %s", (path) => {
    expect(isProtectedPath(path)).toBe(false);
  });

  it("does not block a file merely containing the word production", () => {
    // `reproduction/` is a real directory name in this codebase's vocabulary.
    expect(isProtectedPath("packages/repro/src/reproduction-policy.ts")).toBe(false);
  });
});

describe("YAML is blocked wholesale, not by pipeline name", () => {
  it("blocks both extensions, since the split is not meaningful", () => {
    // Actions uses .yml, Maestro and Flutter use .yaml. A rule covering one
    // leaves every workflow in .github/workflows editable.
    expect(isProtectedPath("anything.yml")).toBe(true);
    expect(isProtectedPath("anything.yaml")).toBe(true);
  });

  it("blocks a workflow that is not named production or release", () => {
    // This is the widening: before, only production.yml and release.yml were
    // caught by name, so ci.yml and every other workflow was editable.
    expect(isProtectedPath(".github/workflows/ci.yml")).toBe(true);
  });

  it("blocks pubspec.yaml, the Flutter analogue of Cargo.toml", () => {
    expect(isProtectedPath("pubspec.yaml")).toBe(true);
    expect(isProtectedPath("packages/foo/pubspec.yaml")).toBe(true);
  });

  it("blocks Maestro E2E tests — the accepted cost of having no carve-outs", () => {
    // ~110 such files in mobile-app, ~92 in p2p-mobile. An agent
    // fixing a mobile bug cannot add the E2E test that demonstrates the fix.
    // Deliberate: one rule with no exceptions is easier to audit than one with.
    expect(isProtectedPath(".maestro/tests/cfd/open_position_test.yaml")).toBe(true);
  });

  it("does not block source code that merely handles YAML", () => {
    expect(isProtectedPath("src/yamlParser.ts")).toBe(false);
    expect(isProtectedPath("packages/config/src/load-yaml.ts")).toBe(false);
  });

  it("is case-insensitive like every other rule", () => {
    expect(isProtectedPath("Deployment.YAML")).toBe(true);
    expect(isProtectedPath(".github/workflows/CI.YML")).toBe(true);
  });
});

describe("the carried-over autofix rules", () => {
  it("now catches a top-level auth directory the old matcher missed", () => {
    expect(isProtectedPath("auth/session.ts")).toBe(true);
  });

  it.each([
    "src/auth/login.ts",
    "packages/x/payment/charge.ts",
    "lib/kyc/verify.ts",
    "db/migrations/001_init.sql",
  ])("blocks %s", (path) => {
    expect(isProtectedPath(path)).toBe(true);
  });
});

describe("findProtectedPaths", () => {
  it("returns one hit per protected path and skips clean ones", () => {
    const hits = findProtectedPaths(["src/app.ts", "Cargo.toml", "README.md", "production.yml"]);
    expect(hits.map((h) => h.path)).toEqual(["Cargo.toml", "production.yml"]);
  });

  it("reports only one reason per path even when several rules match", () => {
    // `.github/production.yml` matches the .github rule and the production.yml
    // rule; the refusal should not repeat itself.
    const hits = findProtectedPaths([".github/production.yml"]);
    expect(hits).toHaveLength(1);
  });

  it("returns an empty array for an empty input", () => {
    expect(findProtectedPaths([])).toEqual([]);
  });

  it("ignores blank and whitespace-only entries", () => {
    expect(findProtectedPaths(["", "   "])).toEqual([]);
  });

  it("layers extra configured patterns on top of the standing list", () => {
    expect(findProtectedPaths(["infra/secret.tfvars"])).toEqual([]);
    const hits = findProtectedPaths(["infra/secret.tfvars"], ["**/*.tfvars"]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.pattern).toBe("**/*.tfvars");
  });

  it("preserves the caller's original spelling in the hit", () => {
    // The refusal should echo what the agent actually asked for.
    const hits = findProtectedPaths(["./Cargo.toml"]);
    expect(hits[0]?.path).toBe("./Cargo.toml");
  });
});

describe("describeProtectedPaths", () => {
  it("is empty when nothing matched", () => {
    expect(describeProtectedPaths([])).toBe("");
  });

  it("names the path, the reason and the rule", () => {
    const text = describeProtectedPaths(findProtectedPaths(["production.yml"]));
    expect(text).toContain("production.yml");
    expect(text).toContain("must be changed by a human");
    expect(text).toContain("**/production.yml");
  });
});
