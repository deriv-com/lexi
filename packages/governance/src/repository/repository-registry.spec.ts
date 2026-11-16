import { describe, it, expect } from "vitest";
import { governanceConfigDir } from "../config/config-dir";
import { RepositoryRegistry } from "./repository-registry";

describe("RepositoryRegistry — repos.yaml from GOVERNANCE_CONFIG_DIR", () => {
  const registry = new RepositoryRegistry(governanceConfigDir());

  it("addresses the issue tracker by its source key", () => {
    expect(registry.getSourceRepository()).toEqual({
      organization: "acme",
      repository: "issues",
      fullName: "acme/issues",
    });
  });

  it("uses a product's declared default branch when it is not main", () => {
    expect(registry.getProduct("p2p_mobile")).toMatchObject({
      productKey: "p2p_mobile",
      fullName: "acme/p2p-mobile",
      defaultBranch: "master",
    });
  });

  it("inherits main for every product that does not declare one", () => {
    expect(registry.getProduct("home_web")?.defaultBranch).toBe("main");
    expect(registry.getProduct("home_mobile")?.defaultBranch).toBe("main");
    expect(registry.getProduct("p2p_web")?.defaultBranch).toBe("main");
  });

  it("keeps placeholders out of the operational list", () => {
    expect(registry.getProduct("web_next")?.placeholder).toBe(true);
    expect(registry.listOperational().map((p) => p.productKey)).not.toContain("web_next");
  });

  it("resolves a team and platform to its repository", () => {
    expect(registry.resolveForTeam("home", "web")?.fullName).toBe("acme/web-app");
    expect(registry.resolveForTeam("nobody")).toBeNull();
  });
});
