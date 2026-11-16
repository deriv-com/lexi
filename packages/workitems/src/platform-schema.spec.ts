import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { RepoRegistry, loadRepoRegistry } from "./repo-registry";
import {
  buildPlatformSchemaProperty,
  defaultRepoRegistry,
  describePlatformRouting,
  platformEnumValues,
  platformSchemaProperty,
  readPlatformEnumValues,
  readPlatformSchemaProperty,
} from "./platform-schema";

const CONFIG_DIR = resolve(__dirname, "../../../examples/config");
const registry = loadRepoRegistry(CONFIG_DIR);

/**
 * A hard-coded `platform: {enum: ["web","mobile"]}` used to be baked into
 * several tool schemas plus their descriptions. These tests pin the replacement: the enum and
 * the prose are both *derived* from the registry, so adding a repo is a config
 * change rather than a code change.
 */
describe("platformEnumValues", () => {
  it("returns the registry's code-repo platform keys", () => {
    expect(platformEnumValues(registry)).toEqual(["web", "mobile", "p2p_web", "p2p_mobile", "packages", "design_system"]);
  });

  it("only offers platforms whose repo actually holds the code role", () => {
    // A platform you cannot dispatch code to must never appear in a
    // code-dispatch tool's enum.
    for (const platform of platformEnumValues(registry)) {
      const repo = registry.resolveByPlatform(platform);
      expect(repo, `${platform} must resolve`).not.toBeNull();
      expect(repo?.roles).toContain("code");
    }
  });
});

describe("buildPlatformSchemaProperty", () => {
  it("produces a JSON-Schema string property with the derived enum", () => {
    const property = buildPlatformSchemaProperty(registry, "Which repo to search");
    expect(property.type).toBe("string");
    expect(property.enum).toEqual(["web", "mobile", "p2p_web", "p2p_mobile", "packages", "design_system"]);
  });

  it("keeps the caller's sentence and appends the routing facts", () => {
    const property = buildPlatformSchemaProperty(registry, "Which repo to search");
    expect(property.description.startsWith("Which repo to search")).toBe(true);
    expect(property.description).toContain("web-app");
    expect(property.description).toContain("mobile-app");
    expect(property.description).toContain("config/repos.yaml");
  });

  it("names each platform next to the repo it routes to", () => {
    const description = describePlatformRouting(registry);
    expect(description).toContain("web (acme/web-app)");
    expect(description).toContain("mobile (acme/mobile-app)");
    expect(description).toContain("p2p_web (acme/p2p-web)");
    expect(description).toContain("p2p_mobile (acme/p2p-mobile)");
    expect(description).toContain("packages (acme/mobile-packages)");
    expect(description).toContain("design_system (acme/design-system)");
  });

  it("grows the enum and the prose together when a repo is added", () => {
    const extended = new RepoRegistry({
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
        home_desktop: {
          organization: "acme",
          repository: "desktop-app",
          platform: "desktop",
          team: "home",
          roles: ["code"],
          placeholder: false,
        },
      },
    });

    const property = buildPlatformSchemaProperty(extended, "Which repo");
    expect(property.enum).toEqual(["web", "desktop"]);
    expect(property.description).toContain("desktop (acme/desktop-app)");
  });
});

/**
 * The six call sites are plain object literals with no registry in scope, so
 * they need a zero-argument accessor to stay one-line edits rather than a
 * restructure of files three other streams are also touching.
 */
describe("default registry accessor", () => {
  it("reads config/repos.yaml using the same GOVERNANCE_CONFIG_DIR convention as RepositoryRegistry", () => {
    expect(defaultRepoRegistry().resolveRepo("home_web")?.slug).toBe("acme/web-app");
  });

  it("memoizes, so six tool-schema sites do not read the file six times per turn", () => {
    expect(defaultRepoRegistry()).toBe(defaultRepoRegistry());
  });

  it("platformSchemaProperty builds the property straight from that registry", () => {
    const property = platformSchemaProperty("Which repo to search");
    expect(property.enum).toEqual(["web", "mobile", "p2p_web", "p2p_mobile", "packages", "design_system"]);
    expect(property.description).toContain("config/repos.yaml");
  });
});

/**
 * The read surface: placeholder repos are readable, so a read tool's enum is
 * built from the readable list rather than the dispatch list.
 */
describe("readPlatformEnumValues", () => {
  it("offers the placeholder platforms the dispatch enum withholds", () => {
    expect(readPlatformEnumValues(registry)).toContain("web_next");
    expect(platformEnumValues(registry)).not.toContain("web_next");
  });

  it("is a strict superset of the dispatch enum", () => {
    const read = readPlatformEnumValues(registry);
    for (const platform of platformEnumValues(registry)) expect(read).toContain(platform);
    expect(read.length).toBeGreaterThan(platformEnumValues(registry).length);
  });

  it("still requires the code role", () => {
    for (const platform of readPlatformEnumValues(registry)) {
      const repo = registry.resolveReadableByPlatform(platform);
      expect(repo, `${platform} must resolve`).not.toBeNull();
      expect(repo?.roles).toContain("code");
    }
  });
});

describe("readPlatformSchemaProperty", () => {
  it("carries the wider enum and names the repo each platform reads", () => {
    const prop = readPlatformSchemaProperty("Which repo to read");
    expect(prop.enum).toContain("web_next");
    expect(prop.description).toContain("Which repo to read");
    expect(prop.description).toContain("acme/web-app-next");
  });

  it("warns that a readable platform is not necessarily a dispatchable one", () => {
    // Without this the model would read a file in a repo and then reasonably
    // assume it could file an issue there too.
    expect(readPlatformSchemaProperty("Which repo to read").description).toContain("Read-only");
  });
});
