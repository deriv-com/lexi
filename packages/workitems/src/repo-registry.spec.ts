import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RepoRegistry, loadRepoRegistry } from "./repo-registry";

const CONFIG_DIR = resolve(__dirname, "../../../examples/config");

function writeRegistry(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "repos-registry-"));
  writeFileSync(join(dir, "repos.yaml"), yaml, "utf8");
  return dir;
}

/**
 * The registry is roles, not a flat list: role gates every repo-touching
 * capability, and the example `repos.yaml` must carry those roles rather than
 * leave them implicit in call-site knowledge.
 */
describe("RepoRegistry — the example repos.yaml", () => {
  const registry = loadRepoRegistry(CONFIG_DIR);

  it("resolves the issue tracker as the issues-role repo", () => {
    const repo = registry.resolveRepo("issues");
    expect(repo).not.toBeNull();
    expect(repo?.slug).toBe("acme/issues");
    expect(repo?.roles).toEqual(["issues"]);
  });

  it("gives every product app the code and specs roles", () => {
    for (const key of ["home_web", "home_mobile", "p2p_web", "p2p_mobile"]) {
      const repo = registry.resolveRepo(key);
      expect(repo, `${key} must be registered`).not.toBeNull();
      expect(repo?.roles).toContain("code");
      expect(repo?.roles).toContain("specs");
    }
  });

  it("resolves slug, platform and team for each product", () => {
    expect(registry.resolveRepo("home_web")).toMatchObject({
      key: "home_web",
      organization: "acme",
      repository: "web-app",
      slug: "acme/web-app",
      platform: "web",
      team: "home",
    });
    expect(registry.resolveRepo("shared_packages")).toMatchObject({
      key: "shared_packages",
      slug: "acme/mobile-packages",
      platform: "packages",
      roles: ["code"],
    });
    expect(registry.resolveRepo("p2p_mobile")).toMatchObject({
      key: "p2p_mobile",
      slug: "acme/p2p-mobile",
      platform: "p2p_mobile",
      team: "p2p",
      defaultBranch: "master",
    });
  });

  it("inherits defaultBranch main unless a product overrides it", () => {
    expect(registry.resolveRepo("home_web")?.defaultBranch).toBe("main");
    expect(registry.resolveRepo("home_mobile")?.defaultBranch).toBe("main");
    expect(registry.resolveRepo("p2p_web")?.defaultBranch).toBe("main");
    expect(registry.resolveRepo("p2p_mobile")?.defaultBranch).toBe("master");
  });

  it("returns null for an unknown key rather than throwing", () => {
    expect(registry.resolveRepo("no_such_repo")).toBeNull();
  });

  it("reposWithRole('issues') covers the tracker and every product that takes issues", () => {
    expect(registry.reposWithRole("issues").map((r) => r.key)).toEqual([
      "issues",
      "home_web",
      "home_mobile",
      "p2p_web",
      "p2p_mobile",
    ]);
  });

  /**
   * Order is load-bearing: a bare `#N` anchors to `reposWithRole("issues")[0]`.
   * The tracker must stay first, or a bare number starts resolving against a
   * product repo.
   */
  it("keeps the tracker first, so a bare #N still anchors to it", () => {
    expect(registry.reposWithRole("issues")[0]?.slug).toBe("acme/issues");
  });

  it("reposWithRole('code') returns product apps and library repos — never the tracker or a placeholder", () => {
    const code = registry.reposWithRole("code").map((r) => r.key);
    expect([...code].sort()).toEqual([
      "design_system",
      "home_mobile",
      "home_web",
      "p2p_mobile",
      "p2p_web",
      "shared_packages",
    ]);
    expect(code).not.toContain("issues");
    expect(code).not.toContain("web_next");
  });

  it("reposWithRole('specs') never includes the tracker", () => {
    // A spec filed in the tracker would be swept into corpus sync, dedup and
    // triage. The role is the guard.
    const specs = registry.reposWithRole("specs");
    expect(specs.map((r) => r.key)).not.toContain("issues");
    expect(specs.length).toBeGreaterThan(0);
  });

  it("hasRole answers the gate question directly", () => {
    expect(registry.hasRole("home_web", "code")).toBe(true);
    expect(registry.hasRole("home_web", "issues")).toBe(true);
    expect(registry.hasRole("issues", "specs")).toBe(false);
    expect(registry.hasRole("issues", "code")).toBe(false);
    expect(registry.hasRole("no_such_repo", "code")).toBe(false);
  });

  it("resolves a repo by slug for reverse lookups", () => {
    expect(registry.resolveBySlug("acme/web-app")?.key).toBe("home_web");
    expect(registry.resolveBySlug("acme/issues")?.key).toBe("issues");
    expect(registry.resolveBySlug("acme/mobile-packages")?.key).toBe("shared_packages");
    expect(registry.resolveBySlug("someone/else")).toBeNull();
  });

  it("resolves a code repo by platform, so 'web' is data not a literal", () => {
    expect(registry.resolveByPlatform("web")?.key).toBe("home_web");
    expect(registry.resolveByPlatform("mobile")?.key).toBe("home_mobile");
    expect(registry.resolveByPlatform("packages")?.key).toBe("shared_packages");
    expect(registry.resolveByPlatform("design_system")?.key).toBe("design_system");
    expect(registry.resolveByPlatform("desktop")).toBeNull();
    // A placeholder is readable but never a dispatch target.
    expect(registry.resolveByPlatform("web_next")).toBeNull();
    expect(registry.resolveReadableByPlatform("web_next")?.key).toBe("web_next");
  });

  it("exposes the platform keys the tool schemas must be built from", () => {
    expect(registry.platformKeys()).toEqual(["web", "mobile", "p2p_web", "p2p_mobile", "packages", "design_system"]);
    expect(registry.readablePlatformKeys()).toContain("web_next");
  });

  it("registers every product, library and placeholder repo", () => {
    expect(registry.listRepos().map((r) => r.key).sort()).toEqual([
      "acme_web_rebuild",
      "design_system",
      "home_mobile",
      "home_web",
      "issues",
      "p2p_mobile",
      "p2p_web",
      "shared_packages",
      "web_next",
    ]);
  });
});

describe("RepoRegistry — role semantics are config-driven, not hard-coded", () => {
  it("picks up a fourth repo and a new platform without a code change", () => {
    const dir = writeRegistry(`
version: 1
source:
  issues:
    organization: acme-internal
    repository: issues
    roles: [issues]
products:
  home_web:
    organization: acme
    repository: web-app
    platform: web
    team: home
    roles: [code, specs]
  home_desktop:
    organization: acme
    repository: desktop-app
    platform: desktop
    team: home
    roles: [code]
`);

    const registry = loadRepoRegistry(dir);
    expect(registry.platformKeys()).toEqual(["web", "desktop"]);
    expect(registry.resolveRepo("home_desktop")?.roles).toEqual(["code"]);
    // Declared code but not specs — the role gate must respect that.
    expect(registry.hasRole("home_desktop", "specs")).toBe(false);
    expect(registry.reposWithRole("specs").map((r) => r.key)).toEqual(["home_web"]);
  });

  it("defaults roles when a product omits them, so an un-migrated file still loads", () => {
    const dir = writeRegistry(`
version: 1
source:
  issues:
    organization: acme-internal
    repository: issues
products:
  home_web:
    organization: acme
    repository: web-app
    platform: web
    team: home
`);

    const registry = loadRepoRegistry(dir);
    expect(registry.resolveRepo("issues")?.roles).toEqual(["issues"]);
    expect(registry.resolveRepo("home_web")?.roles).toEqual(["code", "specs"]);
  });

  it("rejects an unknown role rather than silently ignoring it", () => {
    const dir = writeRegistry(`
version: 1
source:
  issues:
    organization: acme-internal
    repository: issues
    roles: [issues]
products:
  home_web:
    organization: acme
    repository: web-app
    platform: web
    team: home
    roles: [code, deploy]
`);

    expect(() => loadRepoRegistry(dir)).toThrow();
  });

  it("excludes placeholder repos from role queries but still resolves them by key", () => {
    const dir = writeRegistry(`
version: 1
source:
  issues:
    organization: acme-internal
    repository: issues
    roles: [issues]
products:
  home_web:
    organization: acme
    repository: web-app
    platform: web
    team: home
    roles: [code, specs]
  future_app:
    organization: acme
    repository: not-real-yet
    platform: tv
    team: home
    roles: [code, specs]
    placeholder: true
`);

    const registry = loadRepoRegistry(dir);
    expect(registry.resolveRepo("future_app")).not.toBeNull();
    expect(registry.reposWithRole("code").map((r) => r.key)).toEqual(["home_web"]);
    expect(registry.platformKeys()).toEqual(["web"]);

    // ...and still offers it for reading. The exclusion is a write gate.
    expect(registry.readableRepos().map((r) => r.key)).toEqual(["home_web", "future_app"]);
    expect(registry.readablePlatformKeys()).toEqual(["web", "tv"]);
    expect(registry.resolveReadableByPlatform("tv")?.key).toBe("future_app");
  });

  it("throws a useful error when repos.yaml is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "repos-empty-"));
    expect(() => loadRepoRegistry(dir)).toThrow(/repos\.yaml/);
  });

  it("can be constructed from an already-parsed config for tests and callers that cache", () => {
    const registry = new RepoRegistry({
      version: 1,
      source: {
        issues: {
          organization: "acme-internal",
          repository: "issues",
          roles: ["issues"],
        },
      },
      products: {
        home_web: {
          organization: "acme",
          repository: "web-app",
          platform: "web",
          team: "home",
          roles: ["code", "specs"],
          placeholder: false,
        },
      },
    });

    expect(registry.resolveRepo("home_web")?.slug).toBe("acme/web-app");
  });
});

/**
 * `products.<key>.project` carries the board a product's issues sit on, and now
 * the column a shipped quick fix moves the card to.
 *
 * The column lives in config rather than a `.ts` constant because the two live
 * boards have different vocabularies — web has an `In Review` column, mobile
 * does not and uses `In progress`, lowercase `p`. A hard-coded string could only
 * ever be right for one of them.
 *
 * These assert the exact spelling survives the loader. The schema is a zod
 * object, which STRIPS unknown keys: a `shippedStatus` the schema does not
 * declare is silently dropped, leaving the key configurable and unreadable —
 * exactly how `project` itself was once broken.
 */
describe("RepoRegistry — the board's shipped column is config, verbatim", () => {
  it("carries organization, projectNumber and shippedStatus through to the descriptor", () => {
    const dir = writeRegistry(`
version: 1
source:
  issues:
    organization: acme-internal
    repository: issues
    roles: [issues]
products:
  home_web:
    organization: acme
    repository: web-app
    platform: web
    roles: [code, specs, issues]
    project:
      organization: acme
      projectNumber: 7
      shippedStatus: "In Review"
  home_mobile:
    organization: acme-internal
    repository: mobile-app
    platform: mobile
    roles: [code, specs, issues]
    project:
      organization: acme-internal
      projectNumber: 16
      shippedStatus: "In progress"
`);

    const registry = loadRepoRegistry(dir);

    expect(registry.resolveRepo("home_web")?.project).toEqual({
      organization: "acme",
      projectNumber: 7,
      shippedStatus: "In Review",
    });

    // Mobile's own vocabulary, lowercase `p`, never web's.
    const mobile = registry.resolveRepo("home_mobile")?.project;
    expect(mobile?.shippedStatus).toBe("In progress");
    expect(mobile?.shippedStatus).not.toBe("In Review");
    expect(mobile?.shippedStatus).not.toBe("In Progress");
    expect(mobile?.projectNumber).toBe(16);
  });

  it("resolves the board by repo SLUG, which is how the quick-fix poller reaches it", () => {
    // The poller holds `row.repository` ("owner/repo"), not a config key, so
    // this is the lookup that actually runs in production.
    const dir = writeRegistry(`
version: 1
source:
  issues:
    organization: acme-internal
    repository: issues
products:
  home_mobile:
    organization: acme-internal
    repository: mobile-app
    platform: mobile
    project:
      organization: acme-internal
      projectNumber: 16
      shippedStatus: "In progress"
`);

    const registry = loadRepoRegistry(dir);
    const board = registry.resolveBySlug("acme-internal/mobile-app")?.project;
    expect(board?.projectNumber).toBe(16);
    expect(board?.shippedStatus).toBe("In progress");
    // The bug corpus has no board — a shipped fix must never resolve one there.
    expect(registry.resolveBySlug("acme-internal/issues")?.project).toBeUndefined();
  });

  it("leaves shippedStatus absent when the board declares no column, rather than inventing one", () => {
    const dir = writeRegistry(`
version: 1
source:
  issues:
    organization: acme-internal
    repository: issues
products:
  home_web:
    organization: acme
    repository: web-app
    platform: web
    project:
      organization: acme
      projectNumber: 7
`);

    const registry = loadRepoRegistry(dir);
    expect(registry.resolveRepo("home_web")?.project?.projectNumber).toBe(7);
    expect(registry.resolveRepo("home_web")?.project?.shippedStatus).toBeUndefined();
  });
});

/**
 * One repository holding two apps, in `web/` and `mobile/`. So `slug` stops being a unique identity, and `workdir` is
 * the only field telling the two keys apart. These tests pin both halves:
 * that the descriptor carries the directory, and that a slug lookup admits
 * the plurality instead of answering with whichever entry sorted first.
 */
describe("RepoRegistry — a repo holding more than one app", () => {
  // An inline fixture: the two apps share a slug, next to the production
  // apps they must not shadow.
  const registry = loadRepoRegistry(
    writeRegistry(`
version: 1
source:
  issues:
    organization: acme-internal
    repository: issues
    roles: [issues]
products:
  home_web:
    organization: acme
    repository: web-app
    platform: web
    team: home
    roles: [code, specs, issues]
  home_mobile:
    organization: acme-internal
    repository: mobile-app
    platform: mobile
    team: home
    roles: [code, specs, issues]
  static_site_ai:
    organization: acme
    repository: static-site-ai
    platform: static_ai
    roles: [code, specs, issues]
    placeholder: true
  home_web_ai:
    organization: acme-labs
    repository: web-app-next
    workdir: app/web
    platform: web_ai
    roles: [code, specs, issues]
    placeholder: false
  home_mobile_ai:
    organization: acme-labs
    repository: web-app-next
    workdir: app/mobile
    platform: mobile_ai
    roles: [code, specs, issues]
    placeholder: true
`),
  );

  it("carries workdir onto each rebuild's descriptor", () => {
    // Shaped like the retired rebuild repo's layout (app/web, app/mobile).
    // A stale shipped workdir fails every dispatch with "workdir 'web' does
    // not exist in this checkout", so a real entry must track its repo.
    expect(registry.resolveRepo("home_web_ai")?.workdir).toBe("app/web");
    expect(registry.resolveRepo("home_mobile_ai")?.workdir).toBe("app/mobile");
    // Same repository, different directory — the whole point.
    expect(registry.resolveRepo("home_web_ai")?.slug).toBe("acme-labs/web-app-next");
    expect(registry.resolveRepo("home_mobile_ai")?.slug).toBe("acme-labs/web-app-next");
  });

  it("leaves workdir ABSENT for a repo that builds at its root", () => {
    // Absent, not undefined-valued: `"workdir" in descriptor` is how a caller
    // tells "root" from a descriptor written before the field existed.
    const home = registry.resolveRepo("home_web")!;
    expect("workdir" in home).toBe(false);
    expect(registry.resolveRepo("static_site_ai")?.workdir).toBeUndefined();
  });

  it("resolveAllBySlug returns BOTH apps, distinguishable by workdir", () => {
    const all = registry.resolveAllBySlug("acme-labs/web-app-next");
    expect(all).toHaveLength(2);
    expect(all.map((repo) => repo.key)).toEqual(["home_web_ai", "home_mobile_ai"]);
    expect(all.map((repo) => repo.workdir)).toEqual(["app/web", "app/mobile"]);
    expect(all.map((repo) => repo.platform)).toEqual(["web_ai", "mobile_ai"]);
  });

  it("isSlugAmbiguous is true only for the shared slug", () => {
    expect(registry.isSlugAmbiguous("acme-labs/web-app-next")).toBe(true);
    // The PRODUCTION home app is a DIFFERENT org, so it is untouched — this
    // is the regression that matters most: adding the rebuild entries must
    // not shadow the repo Lexi triages bugs in.
    expect(registry.isSlugAmbiguous("acme/web-app")).toBe(false);
    expect(registry.isSlugAmbiguous("nobody/nothing")).toBe(false);
  });

  it("does not shadow the production repos the rebuilds are modelled on", () => {
    expect(registry.resolveBySlug("acme/web-app")?.key).toBe("home_web");
    expect(registry.resolveBySlug("acme-internal/mobile-app")?.key).toBe("home_mobile");
    expect(registry.resolveByPlatform("web")?.key).toBe("home_web");
    expect(registry.resolveByPlatform("mobile")?.key).toBe("home_mobile");
  });

  it("offers web_ai to the dispatch enums and keeps mobile_ai out", () => {
    // `placeholder: true` no longer means "does not exist" — the repository
    // is real. It means "not offered as a dispatch target". In this fixture
    // the web rebuild is open to direct fixes; mobile is not.
    expect(registry.platformKeys()).toContain("web_ai");
    expect(registry.platformKeys()).not.toContain("mobile_ai");
    expect(registry.resolveByPlatform("web_ai")?.key).toBe("home_web_ai");
    expect(registry.resolveByPlatform("mobile_ai")).toBeNull();
  });

  /**
   * `placeholder: true` keeps a repo out of the dispatch enums only. It must
   * not strip the entry from the enum the READ tools are built from, or the
   * agent cannot name a repo it can already read.
   */
  it("lets the rebuild repos be READ whether or not they can be dispatched to", () => {
    expect(registry.readablePlatformKeys()).toContain("web_ai");
    expect(registry.readablePlatformKeys()).toContain("mobile_ai");

    expect(registry.resolveReadableByPlatform("web_ai")).toMatchObject({
      key: "home_web_ai",
      slug: "acme-labs/web-app-next",
    });
    expect(registry.resolveReadableByPlatform("mobile_ai")).toMatchObject({
      key: "home_mobile_ai",
      slug: "acme-labs/web-app-next",
    });

    // The write surface is separate — that separation is the whole fix. Only
    // web_ai has since been opened to it; mobile_ai is readable, not writable.
    expect(registry.platformKeys()).not.toContain("mobile_ai");
    expect(registry.resolveByPlatform("mobile_ai")).toBeNull();
  });

  it("offers every dispatchable platform for reading too", () => {
    // The read surface is a strict superset. A repo you may write to but not
    // read would be the same defect wearing the other shoe.
    for (const platform of registry.platformKeys()) {
      expect(registry.readablePlatformKeys()).toContain(platform);
    }
  });

  it("never offers a non-code repo for reading, placeholder or not", () => {
    // `readableRepos` widens the placeholder rule, not the ROLE rule. The bug
    // tracker holds `issues` alone and must stay off a code-read enum.
    expect(registry.readableRepos().map((r) => r.key)).not.toContain("issues");
    for (const repo of registry.readableRepos()) {
      expect(repo.roles).toContain("code");
    }
  });


  it("resolveAllBySlug is empty, not null, for an unknown slug", () => {
    expect(registry.resolveAllBySlug("nobody/nothing")).toEqual([]);
  });

  it.each([
    ["a leading slash", "/web"],
    ["a trailing slash", "web/"],
    ["parent traversal", "../web"],
    ["traversal in the middle", "web/../mobile"],
    ["an empty string", ""],
  ])("refuses %s in workdir at boot rather than at dispatch", (_label, workdir) => {
    // The same shapes lexi-build.yml's own guard refuses. Failing the parse
    // means a bad value can never reach a dispatch, where the symptom would
    // be four checks recorded as "skipped" and an auto-merge gate satisfied
    // by a run that built nothing.
    const dir = writeRegistry(`
version: 1
source:
  issues:
    organization: acme-internal
    repository: issues
products:
  home_web_ai:
    organization: acme-labs
    repository: web-app
    workdir: "${workdir}"
`);
    expect(() => loadRepoRegistry(dir)).toThrow();
  });

  it("accepts a nested workdir", () => {
    const dir = writeRegistry(`
version: 1
source:
  issues:
    organization: acme-internal
    repository: issues
products:
  nested:
    organization: acme-labs
    repository: web-app
    workdir: apps/web
`);
    expect(loadRepoRegistry(dir).resolveRepo("nested")?.workdir).toBe("apps/web");
  });
});

/**
 * `autonomyTier` is what a merge carve-out keys on, so the default matters
 * more than the opt-in: every un-annotated repo must read as `standard`, and a
 * typo must refuse to load rather than mint a tier.
 */
describe("RepoRegistry — autonomyTier", () => {
  it("defaults every un-annotated product to standard, never autonomous", () => {
    const registry = loadRepoRegistry(CONFIG_DIR);
    for (const key of ["home_web", "home_mobile", "p2p_web", "p2p_mobile"]) {
      expect(registry.resolveRepo(key)?.autonomyTier).toBe("standard");
      expect(registry.isAutonomous(key)).toBe(false);
    }
  });

  it("reads the example rebuild repo as autonomous, and never offers it by role while it is a placeholder", () => {
    const registry = loadRepoRegistry(CONFIG_DIR);
    const repo = registry.resolveRepo("acme_web_rebuild");
    expect(repo).not.toBeNull();
    expect(repo?.autonomyTier).toBe("autonomous");
    expect(registry.isAutonomous("acme_web_rebuild")).toBe(true);
    expect(registry.reposWithRole("code").map((r) => r.key)).not.toContain("acme_web_rebuild");
  });

  it("isAutonomous is false for unknown keys", () => {
    expect(loadRepoRegistry(CONFIG_DIR).isAutonomous("ghost")).toBe(false);
  });

  it("refuses a tier outside the enum rather than reading it as a third value", () => {
    const dir = writeRegistry(`
version: 1
source:
  issues:
    organization: acme
    repository: issues
products:
  home_web:
    organization: acme
    repository: web-app
    autonomyTier: unrestricted
`);
    expect(() => loadRepoRegistry(dir)).toThrow();
  });
});
