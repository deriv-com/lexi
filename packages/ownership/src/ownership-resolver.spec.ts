import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import { loadOwnershipConfig, parseOwnershipConfig } from "./load-ownership-config";
import { OwnershipResolver } from "./ownership-resolver";
import { OwnershipConfig } from "./ownership-config.schema";

const SAMPLE_YAML = `
components:
  web:
    team: Web
    channel: web-bug-triage
    owners: [alice-web, ben-web]
  mobile:
    team: Mobile
    channel: mobile-bug-triage
    owners: [dara-mobile]
  performance:
    team: Platform
    channel: platform-bug-triage
    owners: [liam-platform]
  unassigned:
    team: Triage
    channel: bug-triage-general
    owners: [triage-oncall]
labelMappings:
  "domain:web": web
  "domain:mobile": mobile
  "category:performance": performance
priorityLabels:
  - "priority:P1"
statusLabels:
  toDo: "status:to_do"
  inProgress: "status:in_progress"
`;

describe("OwnershipResolver", () => {
  let config: OwnershipConfig;
  let resolver: OwnershipResolver;

  beforeAll(() => {
    config = parseOwnershipConfig(SAMPLE_YAML);
    resolver = new OwnershipResolver(config);
  });

  it("resolves a component from a domain label", () => {
    const resolution = resolver.resolve(["bug", "domain:web", "priority:P2"]);
    expect(resolution.component).toBe("web");
    expect(resolution.team).toBe("Web");
    expect(resolution.channel).toBe("web-bug-triage");
    expect(resolution.matchedLabel).toBe("domain:web");
  });

  it("prioritizes domain labels over category labels when both are present", () => {
    const resolution = resolver.resolve(["bug", "domain:web", "category:performance"]);
    expect(resolution.component).toBe("web");
  });

  it("falls back to the AI-suggested component when no label matches", () => {
    const resolution = resolver.resolve(["bug"], "performance");
    expect(resolution.component).toBe("performance");
    expect(resolution.team).toBe("Platform");
  });

  it("falls back to unassigned when nothing matches", () => {
    const resolution = resolver.resolve(["bug"]);
    expect(resolution.component).toBe("unassigned");
    expect(resolution.team).toBe("Triage");
  });

  it("round-robins owners across successive resolutions for the same component", () => {
    const first = resolver.nextOwner("web");
    const second = resolver.nextOwner("web");
    const third = resolver.nextOwner("web");
    expect(first).toBe("alice-web");
    expect(second).toBe("ben-web");
    expect(third).toBe("alice-web");
  });

  it("returns undefined when a component has no configured owners", () => {
    const emptyConfig = parseOwnershipConfig(`
components:
  empty:
    team: Empty
    channel: empty-channel
    owners: []
labelMappings: {}
`);
    const emptyResolver = new OwnershipResolver(emptyConfig);
    expect(emptyResolver.nextOwner("empty")).toBeUndefined();
  });

  it("rejects invalid YAML missing required fields", () => {
    expect(() => parseOwnershipConfig("components: { web: { team: Web } }")).toThrowError(/Invalid ownership configuration/);
  });
});

describe("loadOwnershipConfig against the example ownership.yaml", () => {
  it("loads and validates the example ownership configuration file", () => {
    const configPath = path.resolve(__dirname, "../../../examples/config/ownership.yaml");
    const realConfig = loadOwnershipConfig(configPath);
    const resolver = new OwnershipResolver(realConfig);

    // The legacy `component` surface still answers, with the platform channels.
    const webResolution = resolver.resolve(["bug", "domain:web", "priority:P1"]);
    expect(webResolution.component).toBe("web");
    expect(webResolution.channel).toBe("#acme-web");

    const mobileResolution = resolver.resolve(["bug", "domain:mobile", "category:functional"]);
    expect(mobileResolution.component).toBe("mobile");
    expect(mobileResolution.team).toBe("Mobile");
    expect(mobileResolution.channel).toBe("#acme-mobile");

    expect(resolver.getStatusLabels()).toEqual({ toDo: "status:to_do", inProgress: "status:in_progress" });
    expect(resolver.getPriorityLabels()).toContain("priority:P1");
  });

  it("synthesises the legacy component map from platforms, declaring each channel once", () => {
    const configPath = path.resolve(__dirname, "../../../examples/config/ownership.yaml");
    const resolver = new OwnershipResolver(loadOwnershipConfig(configPath));

    expect(resolver.listComponents().sort()).toEqual(["mobile", "unassigned", "web"]);
    // Unmatched issues still resolve to something dereferenceable rather than
    // crashing the callers that read `.team`/`.channel` directly.
    const fallback = resolver.resolve(["bug"]);
    expect(fallback.component).toBe("unassigned");
    expect(fallback.team).toBe("Triage");
    expect(fallback.channel).toBeTruthy();
  });
});
