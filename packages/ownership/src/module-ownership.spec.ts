/**
 * Two-dimensional ownership.
 *
 * Ownership is modelled as (module x platform), not (component). Every
 * routing module — the most specific owning area, not a platform or repo key —
 * has a web person-in-charge and a mobile person-in-charge, and each platform
 * has its own Slack channel and team lead. The old flat
 * `component -> {team, channel}` shape could not express that: it collapsed
 * "who owns payments" into one answer when there are always two.
 *
 * These tests pin the resolution contract the escalation ladder is built on:
 * `(module, platform) -> {pic, channel, teamLead, escalatesTo}`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseOwnershipConfig } from "./load-ownership-config";
import { OwnershipResolver } from "./ownership-resolver";
import type { PersonDirectoryEntry } from "./person-directory";

const CONFIG_DIR = join(__dirname, "..", "..", "..", "examples", "config");

const SAMPLE = `
platforms:
  web:
    team: Web
    channel: "#team-web"
    channelId: C0TEST03
    teamLead: bob
  mobile:
    team: Mobile
    channel: "#team-mobile"
    channelId: C0TEST04
    teamLead: dave
defaultModule: default
defaultPlatform: web
modules:
  payments:
    description: Payments
    web: { pic: carol }
    mobile: { pic: erin }
    keywords: [payments, deposit]
  kyc:
    description: KYC
    web: { pic: grace }
    mobile: { pic: frank }
  default:
    description: Anything not matched
    web: { pic: bob }
    mobile: { pic: dave }
labelMappings:
  "domain:web": web
  "domain:mobile": mobile
`;

/** Minimal directory: identity enrichment + the manager edge for escalation. */
const DIRECTORY: PersonDirectoryEntry[] = [
  { githubLogin: "bob", slackId: "U0TEST02", displayName: "Bob", managerGithub: "alice", teams: ["web"], source: "override" },
  { githubLogin: "dave", slackId: "U0TEST07", displayName: "Dave", managerGithub: "alice", teams: ["mobile"], source: "override" },
  { githubLogin: "carol", slackId: "U0TEST06", displayName: "Carol", managerGithub: "bob", teams: ["web"], source: "override" },
  { githubLogin: "erin", slackId: "U0TEST05", displayName: "Erin", managerGithub: "dave", teams: ["mobile"], source: "override" },
  { githubLogin: "alice", slackId: "U0TEST01", displayName: "Alice Sethi", managerGithub: null, teams: ["web", "mobile"], source: "override" },
];

const config = parseOwnershipConfig(SAMPLE);
const resolver = new OwnershipResolver(config, undefined, { directory: DIRECTORY });

describe("resolveModuleOwnership — the (module, platform) contract", () => {
  it("resolves the web PIC, channel and team lead for a module", () => {
    const resolution = resolver.resolveModuleOwnership("payments", "web");
    expect(resolution.module).toBe("payments");
    expect(resolution.platform).toBe("web");
    expect(resolution.pic.githubLogin).toBe("carol");
    expect(resolution.pic.slackId).toBe("U0TEST06");
    expect(resolution.channel).toBe("#team-web");
    expect(resolution.channelId).toBe("C0TEST03");
    expect(resolution.team).toBe("Web");
    expect(resolution.teamLead.githubLogin).toBe("bob");
  });

  it("resolves a different PIC for the same module on mobile", () => {
    const resolution = resolver.resolveModuleOwnership("payments", "mobile");
    expect(resolution.pic.githubLogin).toBe("erin");
    expect(resolution.channel).toBe("#team-mobile");
    expect(resolution.teamLead.githubLogin).toBe("dave");
  });

  it("builds the escalation ladder pic -> team lead -> senior manager", () => {
    const resolution = resolver.resolveModuleOwnership("payments", "web");
    expect(resolution.escalatesTo.map((p) => p.githubLogin)).toEqual(["bob", "alice"]);
  });

  it("does not repeat the PIC on the ladder when the PIC is the team lead", () => {
    // Bob owns `default` on web AND leads web. The ladder must not say
    // "escalate to Bob" to a person who is already the assignee.
    const resolution = resolver.resolveModuleOwnership("default", "web");
    expect(resolution.pic.githubLogin).toBe("bob");
    expect(resolution.escalatesTo.map((p) => p.githubLogin)).toEqual(["alice"]);
  });

  it("falls back to the default module and says so, rather than guessing one", () => {
    const resolution = resolver.resolveModuleOwnership("no-such-module", "mobile");
    expect(resolution.module).toBe("default");
    expect(resolution.isDefaultModule).toBe(true);
    expect(resolution.pic.githubLogin).toBe("dave");
  });

  it("flags a genuine match as not-a-fallback", () => {
    expect(resolver.resolveModuleOwnership("kyc", "web").isDefaultModule).toBe(false);
  });

  it("resolves without a directory, degrading to logins only", () => {
    const bare = new OwnershipResolver(config);
    const resolution = bare.resolveModuleOwnership("kyc", "mobile");
    expect(resolution.pic.githubLogin).toBe("frank");
    expect(resolution.pic.slackId).toBeUndefined();
    // No directory means no manager edge — the ladder honestly stops at lead.
    expect(resolution.escalatesTo.map((p) => p.githubLogin)).toEqual(["dave"]);
  });

  it("throws a named error when the config has no platforms block", () => {
    const legacy = parseOwnershipConfig("components:\n  web:\n    team: Web\n    channel: c\n");
    expect(() => new OwnershipResolver(legacy).resolveModuleOwnership("payments", "web")).toThrow(/platforms/i);
  });

  it("lists modules and exposes the configured default", () => {
    expect(resolver.listModules().sort()).toEqual(["default", "kyc", "payments"]);
    expect(resolver.getDefaultModule()).toBe("default");
  });
});

describe("the example ownership.yaml encodes a module x platform table", () => {
  const realConfig = parseOwnershipConfig(readFileSync(join(CONFIG_DIR, "ownership.yaml"), "utf-8"));
  const realResolver = new OwnershipResolver(realConfig);

  const EXPECTED: Array<[string, string, string]> = [
    ["payments", "carol", "dave"],
    ["auth", "erin", "frank"],
    ["notifications", "carol", "dave"],
  ];

  it.each(EXPECTED)("routes %s to %s on web and %s on mobile", (moduleKey, webPic, mobilePic) => {
    expect(realResolver.resolveModuleOwnership(moduleKey, "web").pic.githubLogin).toBe(webPic);
    expect(realResolver.resolveModuleOwnership(moduleKey, "mobile").pic.githubLogin).toBe(mobilePic);
  });

  it("routes anything unmatched to the default module owned by the two leads", () => {
    const web = realResolver.resolveModuleOwnership("something-invented", "web");
    const mobile = realResolver.resolveModuleOwnership("something-invented", "mobile");
    expect(web.isDefaultModule).toBe(true);
    expect(web.pic.githubLogin).toBe("alice");
    expect(mobile.pic.githubLogin).toBe("bob");
  });

  it("carries both platform channels", () => {
    expect(realResolver.getPlatformConfig("web").channelId).toBe("C0TEST01");
    expect(realResolver.getPlatformConfig("mobile").channelId).toBe("C0TEST02");
  });

  it("names every module PIC as a real person in people-overrides.yaml", () => {
    // A PIC login that is not in the directory cannot be paged: it has no
    // Slack ID, so it fails here rather than at 2am.
    const overrides = readFileSync(join(CONFIG_DIR, "people-overrides.yaml"), "utf-8");
    for (const moduleKey of realResolver.listModules()) {
      for (const platform of ["web", "mobile"] as const) {
        const login = realResolver.resolveModuleOwnership(moduleKey, platform).pic.githubLogin;
        expect(overrides, `${moduleKey}/${platform} PIC ${login}`).toContain(`githubLogin: ${login}`);
      }
    }
  });
});
