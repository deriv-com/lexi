import { describe, it, expect } from "vitest";
import { RepoRegistry, type RepoRegistryConfig } from "./repo-registry";
import {
  PLATFORM_PRODUCT_KEY_STATUS,
  describeUnknownPlatform,
  resolvePlatformProductKey,
  resolveReadPlatformProductKey,
} from "./platform-product-key";

/**
 * A registry with THREE platforms, one of which holds no `code` role.
 *
 * Three matters: with only web and mobile, a ternary and a lookup are
 * indistinguishable — every test passes either way. The third platform is what
 * separates "resolved from config" from "guessed by elimination".
 */
const CONFIG: RepoRegistryConfig = {
  version: 1,
  source: { issues: { organization: "acme-internal", repository: "issues", roles: ["issues"] } },
  products: {
    home_web: { organization: "acme", repository: "web-app", platform: "web", roles: ["code", "specs"] },
    home_mobile: { organization: "acme-internal", repository: "mobile-app", platform: "mobile", roles: ["code", "specs"] },
    home_desktop: { organization: "acme", repository: "desktop-app-legacy", platform: "desktop", roles: ["code"] },
    // Registered, declares a platform, but cannot receive code. Resolving it
    // would hand a caller a dispatch target that must then be refused later.
    docs_site: { organization: "acme", repository: "docs", platform: "docs", roles: ["specs"] },
  },
};

const registry = new RepoRegistry(CONFIG);

describe("resolvePlatformProductKey", () => {
  it("resolves each registered code platform to its OWN key", () => {
    for (const [platform, key] of [["web", "home_web"], ["mobile", "home_mobile"], ["desktop", "home_desktop"]]) {
      const result = resolvePlatformProductKey(registry, platform);
      expect(result.status).toBe(PLATFORM_PRODUCT_KEY_STATUS.RESOLVED);
      expect(result.status === PLATFORM_PRODUCT_KEY_STATUS.RESOLVED && result.productKey).toBe(key);
    }
  });

  it("carries the slug, so a caller never has to rebuild one from the key", () => {
    const result = resolvePlatformProductKey(registry, "desktop");
    expect(result.status === PLATFORM_PRODUCT_KEY_STATUS.RESOLVED && result.slug).toBe("acme/desktop-app-legacy");
  });

  it("does NOT resolve a platform whose repo lacks the code role", () => {
    // A dispatch target must be able to receive code. `docs` is registered and
    // spelled correctly, which is exactly why the check cannot be a spelling check.
    const result = resolvePlatformProductKey(registry, "docs");
    expect(result.status).toBe(PLATFORM_PRODUCT_KEY_STATUS.UNKNOWN_PLATFORM);
  });

  describe("an unrecognised platform resolves to nothing at all", () => {
    // Every one of these previously landed on the mobile repo via
    // `platform === "web" ? "home_web" : "home_mobile"`.
    const cases: Array<[string, unknown]> = [
      ["a platform no repo declares", "smart-fridge"],
      ["the empty string", ""],
      ["different casing", "Web"],
      ["a trailing space", "web "],
      ["a leading space", " web"],
      ["undefined (argument omitted)", undefined],
      ["null", null],
      ["a number", 1],
      ["an object", { platform: "web" }],
      ["an array", ["web"]],
      ["a boolean", true],
    ];

    for (const [label, platform] of cases) {
      it(`refuses ${label}`, () => {
        const result = resolvePlatformProductKey(registry, platform);
        expect(result.status).toBe(PLATFORM_PRODUCT_KEY_STATUS.UNKNOWN_PLATFORM);
        // The property the ternary could not have: no key is produced, so no
        // caller can route on one.
        expect(result).not.toHaveProperty("productKey");
      });
    }

    it("never falls back to the mobile repo in particular", () => {
      // Named explicitly because mobile was the silent default: "not web"
      // meant "therefore mobile", for every value in the language.
      for (const [, platform] of cases) {
        const result = resolvePlatformProductKey(registry, platform);
        expect(JSON.stringify(result)).not.toContain("home_mobile");
      }
    });
  });

  it("deliberately does not normalise near-misses", () => {
    // Trimming or lower-casing would be the same defect in a politer form: it
    // decides what the caller meant and never tells them they were wrong.
    expect(resolvePlatformProductKey(registry, "WEB").status).toBe(PLATFORM_PRODUCT_KEY_STATUS.UNKNOWN_PLATFORM);
    expect(resolvePlatformProductKey(registry, " mobile ").status).toBe(PLATFORM_PRODUCT_KEY_STATUS.UNKNOWN_PLATFORM);
  });

  it("reports the platforms that DO resolve, derived from the registry", () => {
    const result = resolvePlatformProductKey(registry, "smart-fridge");
    expect(result.status === PLATFORM_PRODUCT_KEY_STATUS.UNKNOWN_PLATFORM && result.knownPlatforms)
      .toEqual(["web", "mobile", "desktop"]);
  });

  it("tracks the registry rather than a literal when a platform is added", () => {
    // The whole point of the registry: adding a repo is a config change, not a code
    // change. Nothing in the source needed editing for "tablet" to dispatch.
    const extended = new RepoRegistry({
      ...CONFIG,
      products: {
        ...CONFIG.products,
        home_tablet: { organization: "acme", repository: "tablet-app", platform: "tablet", roles: ["code"] },
      },
    });

    const before = resolvePlatformProductKey(registry, "tablet");
    const after = resolvePlatformProductKey(extended, "tablet");

    expect(before.status).toBe(PLATFORM_PRODUCT_KEY_STATUS.UNKNOWN_PLATFORM);
    expect(after.status === PLATFORM_PRODUCT_KEY_STATUS.RESOLVED && after.productKey).toBe("home_tablet");
  });
});

describe("describeUnknownPlatform", () => {
  it("returns null for a resolution that succeeded", () => {
    expect(describeUnknownPlatform(resolvePlatformProductKey(registry, "web"))).toBeNull();
  });

  it("names the rejected value and the platforms that would work", () => {
    const message = describeUnknownPlatform(resolvePlatformProductKey(registry, "smart-fridge"));
    expect(message).toContain("smart-fridge");
    expect(message).toContain("config/repos.yaml");
    for (const platform of ["web", "mobile", "desktop"]) expect(message).toContain(`"${platform}"`);
  });

  it("renders a non-string value without pretending it was a string", () => {
    expect(describeUnknownPlatform(resolvePlatformProductKey(registry, undefined))).toContain("undefined");
    expect(describeUnknownPlatform(resolvePlatformProductKey(registry, null))).toContain("null");
  });

  it("says so plainly when no code repo declares a platform at all", () => {
    const bare = new RepoRegistry({
      version: 1,
      source: { issues: { organization: "acme-internal", repository: "issues", roles: ["issues"] } },
      products: {},
    });
    expect(describeUnknownPlatform(resolvePlatformProductKey(bare, "web"))).toContain("none");
  });
});

/**
 * The read counterpart. A placeholder repo is withheld from DISPATCH, and
 * resolving it for a read is not the same widening.
 *
 * When the two shared one resolver, `acme-labs/web-app` — a repo the GitHub
 * App reads and had already filed an issue in — could not be reached by
 * `get_file_contents`. Lexi reported that as the repo being unregistered and
 * the App being uninstalled; neither was true.
 */
const READ_CONFIG: RepoRegistryConfig = {
  version: 1,
  source: { issues: { organization: "acme-internal", repository: "issues", roles: ["issues"] } },
  products: {
    home_web: { organization: "acme", repository: "web-app", platform: "web", roles: ["code", "specs"] },
    // Registered, real, readable — and deliberately not a dispatch target.
    rebuild: {
      organization: "acme-labs",
      repository: "web-app-agent",
      platform: "web_ai",
      roles: ["code", "specs", "issues"],
      placeholder: true,
    },
    // Placeholder AND role-less for code: must stay unreadable, so the widening
    // is proven to be about `placeholder` and not about dropping the role gate.
    docs_site: { organization: "acme", repository: "docs", platform: "docs", roles: ["specs"], placeholder: true },
  },
};

const readRegistry = new RepoRegistry(READ_CONFIG);

describe("resolveReadPlatformProductKey", () => {
  it("resolves a placeholder repo that the dispatch resolver refuses", () => {
    const read = resolveReadPlatformProductKey(readRegistry, "web_ai");
    expect(read.status).toBe(PLATFORM_PRODUCT_KEY_STATUS.RESOLVED);
    expect(read.status === PLATFORM_PRODUCT_KEY_STATUS.RESOLVED && read.productKey).toBe("rebuild");
    expect(read.status === PLATFORM_PRODUCT_KEY_STATUS.RESOLVED && read.slug).toBe("acme-labs/web-app-agent");

    expect(resolvePlatformProductKey(readRegistry, "web_ai").status).toBe(
      PLATFORM_PRODUCT_KEY_STATUS.UNKNOWN_PLATFORM,
    );
  });

  it("still resolves the ordinary dispatchable platforms", () => {
    const read = resolveReadPlatformProductKey(readRegistry, "web");
    expect(read.status === PLATFORM_PRODUCT_KEY_STATUS.RESOLVED && read.productKey).toBe("home_web");
  });

  it("keeps the role gate — a specs-only repo is not readable code", () => {
    expect(resolveReadPlatformProductKey(readRegistry, "docs").status).toBe(
      PLATFORM_PRODUCT_KEY_STATUS.UNKNOWN_PLATFORM,
    );
  });

  it("rejects a non-string exactly as the dispatch resolver does", () => {
    for (const bad of [undefined, null, "", 7]) {
      expect(resolveReadPlatformProductKey(readRegistry, bad).status).toBe(
        PLATFORM_PRODUCT_KEY_STATUS.UNKNOWN_PLATFORM,
      );
    }
  });

  it("names the READ platforms when it refuses, not the narrower dispatch list", () => {
    // Telling a reader to pick from a list this tool never offered is how a
    // governance boundary gets mistaken for a typo.
    const message = describeUnknownPlatform(resolveReadPlatformProductKey(readRegistry, "smart-fridge"));
    expect(message).toContain("smart-fridge");
    expect(message).toContain('"web_ai"');
  });
});
