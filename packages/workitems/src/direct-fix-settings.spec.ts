import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { RepoRegistry, loadRepoRegistry } from "./repo-registry";
import {
  DEFAULT_DIRECT_FIX_WORKFLOW_FILE,
  directFixWorkflowForSlug,
  previewLinkForSlug,
  previewLinkSlugs,
  resolveDirectFixSettings,
} from "./direct-fix-settings";

const CONFIG_DIR = resolve(__dirname, "../../../examples/config");

function registryWith(products: Record<string, Record<string, unknown>>) {
  return new RepoRegistry({
    version: 1,
    source: { issues: { organization: "acme-internal", repository: "issues" } },
    products: products as never,
  });
}

/**
 * A retired web rebuild's entries (acme-labs/web-app-next), kept as a
 * fixture: no shipped repo sets `directFix` or
 * `previewLink` any more, but both mechanisms remain for a future entry.
 */
const REBUILD_PAIR = {
  home_web: { organization: "acme", repository: "web-app", platform: "web", roles: ["code", "specs", "issues"] },
  home_web_ai: {
    organization: "acme-labs",
    repository: "web-app-next",
    workdir: "app/web",
    platform: "web_ai",
    roles: ["code", "specs", "issues"],
    directFix: { workflow: "common-direct-fix.yml", targetPlatform: "web" },
    previewLink: { hosts: ["dev.example.com", "preview.example.dev"] },
  },
  home_mobile_ai: {
    organization: "acme-labs",
    repository: "web-app-next",
    workdir: "app/mobile",
    platform: "mobile_ai",
    roles: ["code", "specs", "issues"],
    placeholder: true,
  },
};

describe("resolveDirectFixSettings — shipped config", () => {
  const registry = loadRepoRegistry(CONFIG_DIR);

  it("leaves every original product repo on today's dispatch", () => {
    for (const [key, ref] of [["home_web", "main"], ["home_mobile", "main"], ["p2p_web", "main"], ["p2p_mobile", "master"]]) {
      expect(resolveDirectFixSettings(registry, key, ref), key).toEqual({
        workflow: DEFAULT_DIRECT_FIX_WORKFLOW_FILE,
        ref,
        refIsWorkingBranch: false,
      });
    }
  });

  it("sends every registered repo to the default workflow since the web rebuild was retired (2026-10-09)", () => {
    for (const repo of registry.listRepos()) {
      expect(directFixWorkflowForSlug(registry, repo.slug), repo.key).toBe(DEFAULT_DIRECT_FIX_WORKFLOW_FILE);
    }
    expect(directFixWorkflowForSlug(registry, "acme-labs/web-app-next")).toBe("direct-fix.yml");
  });
});

describe("resolveDirectFixSettings — a repo with its own workflow", () => {
  const registry = registryWith(REBUILD_PAIR);

  it("sends the web rebuild to its own workflow, on main", () => {
    expect(resolveDirectFixSettings(registry, "home_web_ai", "main")).toEqual({
      workflow: "common-direct-fix.yml",
      ref: "main",
      refIsWorkingBranch: false,
      targetPlatform: "web",
    });
  });

  it("does not move the web rebuild's defaultBranch, which other callers read", () => {
    expect(registry.resolveRepo("home_web_ai")?.defaultBranch).toBe("main");
  });

  it("polls the rebuild slug under the rebuild's workflow, whichever of its two apps asks", () => {
    expect(directFixWorkflowForSlug(registry, "acme-labs/web-app-next")).toBe("common-direct-fix.yml");
    expect(directFixWorkflowForSlug(registry, "acme/web-app")).toBe("direct-fix.yml");
    expect(directFixWorkflowForSlug(registry, "nobody/nothing")).toBe("direct-fix.yml");
  });
});

describe("resolveDirectFixSettings — edges", () => {
  it("degrades an unknown key to the caller's fallback, never to another repo's settings", () => {
    const registry = registryWith({});
    expect(resolveDirectFixSettings(registry, "ghost", "master")).toEqual({
      workflow: "direct-fix.yml",
      ref: "master",
      refIsWorkingBranch: false,
    });
    expect(resolveDirectFixSettings(registry, undefined, undefined).ref).toBe("main");
  });

  it("does not stamp a base branch when directFix.ref is the default branch anyway", () => {
    const registry = registryWith({
      app: { organization: "o", repository: "r", directFix: { workflow: "x.yml", ref: "main" } },
    });
    expect(resolveDirectFixSettings(registry, "app", "main").refIsWorkingBranch).toBe(false);
  });

  it("rejects a workflow value that is not a bare file name", () => {
    expect(() =>
      registryWith({ app: { organization: "o", repository: "r", directFix: { workflow: ".github/workflows/x.yml" } } }),
    ).toThrow(/bare \.yml/);
  });

  it("rejects a misspelt key rather than silently dispatching the default workflow", () => {
    expect(() =>
      registryWith({ app: { organization: "o", repository: "r", directFix: { workflow: "x.yml", targetPlatfrom: "web" } } }),
    ).toThrow();
  });
});

describe("previewLinkForSlug", () => {
  it("gives an opted-in repo its preview domains, and no umbrella when its PRs target main", () => {
    const registry = registryWith(REBUILD_PAIR);
    expect(previewLinkForSlug(registry, "acme-labs/web-app-next")).toEqual({
      hosts: ["dev.example.com", "preview.example.dev"],
    });
    expect(previewLinkSlugs(registry)).toEqual(["acme-labs/web-app-next"]);
  });

  it("opts no shipped repo in since the web rebuild was retired (2026-10-09)", () => {
    expect(previewLinkSlugs(loadRepoRegistry(CONFIG_DIR))).toEqual([]);
  });

  it("is null for every repo that did not opt in", () => {
    const registry = loadRepoRegistry(CONFIG_DIR);
    for (const slug of ["acme/web-app", "acme-internal/mobile-app"]) {
      expect(previewLinkForSlug(registry, slug), slug).toBeNull();
    }
  });

  it("rejects a host that is not a bare domain, and a misspelt key", () => {
    const base = { organization: "o", repository: "r", roles: ["code"] };
    expect(() => registryWith({ x: { ...base, previewLink: { hosts: ["https://example.com/"] } } })).toThrow();
    expect(() => registryWith({ x: { ...base, previewLink: { hosts: ["example.com"], umbrela: {} } } })).toThrow();
    expect(() => registryWith({ x: { ...base, previewLink: { hosts: ["example.com"], umbrella: { prNumber: 130 } } } })).toThrow();
    expect(() => registryWith({ x: { ...base, previewLink: { hosts: [] } } })).toThrow();
  });
});
