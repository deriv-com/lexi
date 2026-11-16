/**
 * Person directory.
 *
 * Ownership data is **derived**: GitHub CODEOWNERS plus the Slack
 * directory, reconciled with the two hand-maintained YAML files that each
 * held half an answer — `config/ownership.yaml` (components -> teams, GitHub
 * logins) and `config/quick-fix-owners.yaml` (categories -> Slack IDs). One
 * model, `PersonDirectory`, replaces both as the identity source.
 *
 * The hard requirement: **startup validation fails
 * loudly on placeholder data.** `config/ownership.yaml` shipped with every
 * component owned by `alice`, marked TEMP, since the first commit.
 * Placeholder ownership is worse than none — it routes real bugs to a real
 * person who is not responsible for them, and it does so silently.
 *
 * Manager edges are deferred: `managerGithub` is populated from
 * overrides when present but nothing in this build consumes it, and an empty
 * overrides file is a valid, expected state.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseCodeowners,
  codeownersLogins,
  parsePeopleOverrides,
  loadPeopleOverrides,
  buildPersonDirectory,
  assertNoPlaceholderPeople,
  PlaceholderDataError,
  DEFAULT_PLACEHOLDER_LOGINS,
  parseOwnershipConfig,
  assertOwnershipConfigHasNoPlaceholders,
  OwnershipResolver,
} from "./index";

const CONFIG_DIR = join(__dirname, "..", "..", "..", "examples", "config");

// ---------------------------------------------------------------------------
// CODEOWNERS
// ---------------------------------------------------------------------------

describe("parseCodeowners", () => {
  const SAMPLE = [
    "# Default owners",
    "*                       @acme/web-site",
    "",
    "/src/payments/**        @alice @bob",
    "/src/kyc/               @carol",
    "docs/*.md               @dave  # trailing comment",
  ].join("\n");

  it("skips comments and blank lines", () => {
    const rules = parseCodeowners(SAMPLE);
    expect(rules).toHaveLength(4);
  });

  it("captures the pattern and its owners", () => {
    const rules = parseCodeowners(SAMPLE);
    expect(rules[1]).toEqual({ pattern: "/src/payments/**", owners: ["alice", "bob"] });
  });

  it("strips the leading @ from every owner", () => {
    const logins = codeownersLogins(parseCodeowners(SAMPLE));
    expect(logins).not.toContain("@alice");
    expect(logins).toContain("alice");
  });

  it("keeps team handles distinguishable from individuals", () => {
    // `@org/team` is a team, not a person. Writing it into PersonDirectory as
    // a githubLogin would create a "person" nobody can DM.
    const rules = parseCodeowners(SAMPLE);
    expect(rules[0].owners).toEqual(["acme/web-site"]);
    expect(codeownersLogins(rules)).not.toContain("acme/web-site");
  });

  it("drops an inline trailing comment rather than treating it as an owner", () => {
    const rules = parseCodeowners(SAMPLE);
    expect(rules[3].owners).toEqual(["dave"]);
  });

  it("returns nothing for an empty or comment-only file", () => {
    expect(parseCodeowners("")).toEqual([]);
    expect(parseCodeowners("# nothing here\n\n")).toEqual([]);
  });

  it("deduplicates logins that own several paths", () => {
    const logins = codeownersLogins(parseCodeowners("/a @alice\n/b @alice\n"));
    expect(logins).toEqual(["alice"]);
  });
});

// ---------------------------------------------------------------------------
// people-overrides.yaml
// ---------------------------------------------------------------------------

describe("people-overrides.yaml", () => {
  it("accepts an empty overrides file — managers are deferred, not required", () => {
    // The ladder tops out at team lead in this build. An empty file must
    // be a valid state, or the deferral becomes a startup failure.
    expect(parsePeopleOverrides("people: []").people).toEqual([]);
    expect(parsePeopleOverrides("").people).toEqual([]);
  });

  it("maps a github login to a slack id", () => {
    const parsed = parsePeopleOverrides(
      ["people:", "  - githubLogin: alice", "    slackId: U123", "    displayName: Alice"].join("\n"),
    );
    expect(parsed.people[0]).toMatchObject({ githubLogin: "alice", slackId: "U123", displayName: "Alice" });
  });

  it("carries a manager edge when one is supplied", () => {
    const parsed = parsePeopleOverrides(
      ["people:", "  - githubLogin: alice", "    managerGithub: bob"].join("\n"),
    );
    expect(parsed.people[0].managerGithub).toBe("bob");
  });

  it("rejects an entry with no githubLogin — the model is keyed on it", () => {
    expect(() => parsePeopleOverrides(["people:", "  - slackId: U123"].join("\n"))).toThrow(/githubLogin/i);
  });

  it("loads the example file", () => {
    const overrides = loadPeopleOverrides(CONFIG_DIR);
    expect(Array.isArray(overrides.people)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

describe("buildPersonDirectory", () => {
  const codeowners = [
    { repoKey: "home_web", team: "home", content: "/src/pay/** @alice\n/src/kyc/ @carol\n" },
  ];

  it("derives an entry per individual CODEOWNERS login", () => {
    const { entries } = buildPersonDirectory({ codeowners, slackDirectory: [], overrides: { people: [] } });
    expect(entries.map((e) => e.githubLogin).sort()).toEqual(["alice", "carol"]);
    expect(entries[0].source).toBe("derived");
  });

  it("attaches the team the owning repo belongs to", () => {
    const { entries } = buildPersonDirectory({ codeowners, slackDirectory: [], overrides: { people: [] } });
    expect(entries.find((e) => e.githubLogin === "alice")!.teams).toEqual(["home"]);
  });

  it("merges a person who owns paths in two repos into one entry", () => {
    const { entries } = buildPersonDirectory({
      codeowners: [
        { repoKey: "home_web", team: "home", content: "/a @alice\n" },
        { repoKey: "home_mobile", team: "mobile", content: "/b @alice\n" },
      ],
      slackDirectory: [],
      overrides: { people: [] },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].teams.sort()).toEqual(["home", "mobile"]);
  });

  it("links a slack id supplied by an override", () => {
    const { entries } = buildPersonDirectory({
      codeowners,
      slackDirectory: [],
      overrides: { people: [{ githubLogin: "alice", slackId: "U_ALICE", displayName: "Alice A" }] },
    });
    const alice = entries.find((e) => e.githubLogin === "alice")!;
    expect(alice.slackId).toBe("U_ALICE");
    expect(alice.source).toBe("override");
  });

  it("lets an override win over a derived slack match", () => {
    const { entries } = buildPersonDirectory({
      codeowners,
      slackDirectory: [{ slackId: "U_WRONG", displayName: "alice", githubLogin: "alice" }],
      overrides: { people: [{ githubLogin: "alice", slackId: "U_RIGHT" }] },
    });
    expect(entries.find((e) => e.githubLogin === "alice")!.slackId).toBe("U_RIGHT");
  });

  it("keeps a manager edge without requiring anything to consume it", () => {
    const { entries } = buildPersonDirectory({
      codeowners,
      slackDirectory: [],
      overrides: { people: [{ githubLogin: "alice", managerGithub: "bob" }] },
    });
    expect(entries.find((e) => e.githubLogin === "alice")!.managerGithub).toBe("bob");
  });

  it("adds an override-only person who owns no CODEOWNERS path", () => {
    const { entries } = buildPersonDirectory({
      codeowners: [],
      slackDirectory: [],
      overrides: { people: [{ githubLogin: "dana", slackId: "U_DANA" }] },
    });
    expect(entries.map((e) => e.githubLogin)).toEqual(["dana"]);
  });

  it("reports slack users it could not map rather than inventing a github login", () => {
    const { unmatchedSlackIds } = buildPersonDirectory({
      codeowners,
      slackDirectory: [{ slackId: "U_GHOST", displayName: "Ghost" }],
      overrides: { people: [] },
    });
    expect(unmatchedSlackIds).toContain("U_GHOST");
  });

  it("produces a stable order so a re-sync is a no-op", () => {
    const input = { codeowners, slackDirectory: [], overrides: { people: [] } };
    expect(buildPersonDirectory(input).entries).toEqual(buildPersonDirectory(input).entries);
  });

  it("folds quick-fix owner Slack IDs in as team membership", () => {
    // config/quick-fix-owners.yaml is the one file that already holds real
    // Slack IDs. Reconciling it here is what makes this "one model" rather
    // than a third source of truth.
    const { entries } = buildPersonDirectory({
      codeowners,
      slackDirectory: [],
      overrides: { people: [{ githubLogin: "alice", slackId: "U_ALICE" }] },
      quickFixOwners: {
        mergeReviewers: { web: "U_LEAD", mobile: "U_MOBILE_LEAD" },
        categories: { portfolio: { web: "U_ALICE", mobile: "U_OTHER" } },
      },
    });
    expect(entries.find((e) => e.githubLogin === "alice")!.teams).toContain("portfolio");
  });
});

// ---------------------------------------------------------------------------
// Placeholder validation — the hard requirement
// ---------------------------------------------------------------------------

describe("assertNoPlaceholderPeople", () => {
  // A deployment-specific placeholder: a real-looking login no pattern catches.
  const PLACEHOLDERS = { additionalPlaceholders: ["mallory"] };

  it("ships no built-in placeholder login; deployments name their own", () => {
    expect(DEFAULT_PLACEHOLDER_LOGINS).toEqual([]);
  });

  it("throws when a placeholder login reaches the directory", () => {
    expect(() =>
      assertNoPlaceholderPeople([
        { githubLogin: "mallory", slackId: null, displayName: null, managerGithub: null, teams: ["web"], source: "derived" },
      ], PLACEHOLDERS),
    ).toThrow(PlaceholderDataError);
  });

  it("names the offending login and where it came from", () => {
    // A validation failure at boot is only useful if it says what to fix.
    try {
      assertNoPlaceholderPeople(
        [{ githubLogin: "mallory", slackId: null, displayName: null, managerGithub: null, teams: ["web"], source: "derived" }],
        { ...PLACEHOLDERS, sourceDescription: "config/ownership.yaml" },
      );
      throw new Error("expected a throw");
    } catch (err) {
      expect(String((err as Error).message)).toContain("mallory");
      expect(String((err as Error).message)).toContain("config/ownership.yaml");
    }
  });

  it("catches generic placeholder shapes, not just the one login we know about", () => {
    for (const login of ["TODO", "changeme", "your-github-login", "placeholder-user"]) {
      expect(() =>
        assertNoPlaceholderPeople([
          { githubLogin: login, slackId: null, displayName: null, managerGithub: null, teams: [], source: "derived" },
        ]),
      ).toThrow(PlaceholderDataError);
    }
  });

  it("accepts a directory of real people", () => {
    expect(() =>
      assertNoPlaceholderPeople([
        { githubLogin: "alice", slackId: "U1", displayName: "Alice", managerGithub: null, teams: ["home"], source: "derived" },
      ]),
    ).not.toThrow();
  });

  it("accepts an empty directory — nothing derived yet is not placeholder data", () => {
    // An empty directory means the sync has not run. That is a different (and
    // recoverable) condition from wrong data, and must not block boot.
    expect(() => assertNoPlaceholderPeople([])).not.toThrow();
  });

  it("is case-insensitive — Mallory is the same placeholder", () => {
    expect(() =>
      assertNoPlaceholderPeople([
        { githubLogin: "Mallory", slackId: null, displayName: null, managerGithub: null, teams: [], source: "derived" },
      ], PLACEHOLDERS),
    ).toThrow(PlaceholderDataError);
  });
});

describe("the example ownership.yaml", () => {
  it("parses", () => {
    const config = parseOwnershipConfig(readFileSync(join(CONFIG_DIR, "ownership.yaml"), "utf-8"));
    // The file is (module x platform); `components` is synthesised from
    // `platforms` by the resolver rather than written out.
    expect(Object.keys(config.modules).length).toBeGreaterThan(0);
    expect(config.platforms?.web.channelId).toBeTruthy();
    expect(config.platforms?.mobile.channelId).toBeTruthy();
  });

  it("contains no placeholder owner login", () => {
    const raw = readFileSync(join(CONFIG_DIR, "ownership.yaml"), "utf-8");
    const config = parseOwnershipConfig(raw);
    expect(() => assertOwnershipConfigHasNoPlaceholders(config)).not.toThrow();
  });

  it("still resolves components, teams, and channels", () => {
    // Removing the fake owners must not cost the routing that actually works.
    const config = parseOwnershipConfig(readFileSync(join(CONFIG_DIR, "ownership.yaml"), "utf-8"));
    const resolver = new OwnershipResolver(config);
    const resolution = resolver.resolve(["domain:web"]);
    expect(resolution.component).toBe("web");
    expect(resolution.team).toBe("Web");
    expect(resolution.channel).toBeTruthy();
  });
});

describe("assertOwnershipConfigHasNoPlaceholders", () => {
  it("throws when a component still lists a placeholder owner", () => {
    const config = parseOwnershipConfig(
      ["components:", "  web:", "    team: Web", "    channel: c", "    owners:", "      - TODO"].join("\n"),
    );
    expect(() => assertOwnershipConfigHasNoPlaceholders(config)).toThrow(PlaceholderDataError);
  });

  it("allows a component with no owners — the directory supplies them", () => {
    const config = parseOwnershipConfig(["components:", "  web:", "    team: Web", "    channel: c"].join("\n"));
    expect(() => assertOwnershipConfigHasNoPlaceholders(config)).not.toThrow();
  });

  // ---- The same guard, on the two-dimensional shape ----------------------
  // A placeholder that moved from `components[].owners` to `modules[].pic`
  // is the identical failure wearing the new schema, so the guard has to
  // follow it there rather than pass a config it no longer understands.

  const TWO_D = (picLogin: string, teamLead = "bob"): string =>
    [
      "platforms:",
      "  web:",
      "    team: Web",
      '    channel: "#w"',
      `    teamLead: ${teamLead}`,
      "  mobile:",
      "    team: Mobile",
      '    channel: "#m"',
      "    teamLead: dave",
      "defaultModule: payments",
      "modules:",
      "  payments:",
      `    web: { pic: ${picLogin} }`,
      "    mobile: { pic: erin }",
    ].join("\n");

  it("throws when a module PIC is a placeholder login", () => {
    const config = parseOwnershipConfig(TWO_D("placeholder-owner"));
    expect(() => assertOwnershipConfigHasNoPlaceholders(config)).toThrow(PlaceholderDataError);
  });

  it("throws when a platform team lead is a placeholder login", () => {
    const config = parseOwnershipConfig(TWO_D("carol", "TBD"));
    expect(() => assertOwnershipConfigHasNoPlaceholders(config)).toThrow(PlaceholderDataError);
  });

  it("names the offending login so the operator knows what to fix", () => {
    const config = parseOwnershipConfig(TWO_D("changeme"));
    expect(() => assertOwnershipConfigHasNoPlaceholders(config)).toThrow(/changeme/);
  });

  it("accepts a two-dimensional config whose PICs are all real", () => {
    const config = parseOwnershipConfig(TWO_D("carol"));
    expect(() => assertOwnershipConfigHasNoPlaceholders(config)).not.toThrow();
  });

  it("does not crash on a config that has no legacy components map at all", () => {
    // The regression this file's `parses` test caught: the guard read
    // `config.components` unconditionally and threw a TypeError on the new
    // shape — i.e. the boot guard failed open on exactly the file it guards.
    const config = parseOwnershipConfig(readFileSync(join(CONFIG_DIR, "ownership.yaml"), "utf-8"));
    expect(config.components).toBeUndefined();
    expect(() => assertOwnershipConfigHasNoPlaceholders(config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Resolver integration
// ---------------------------------------------------------------------------

describe("OwnershipResolver backed by the directory", () => {
  const config = parseOwnershipConfig(
    [
      "components:",
      "  web:",
      "    team: Web",
      "    channel: web-bug-triage",
      "labelMappings:",
      '  "domain:web": web',
    ].join("\n"),
  );

  it("falls back to the directory for owners when the config lists none", () => {
    const directory = [
      { githubLogin: "alice", slackId: "U1", displayName: null, managerGithub: null, teams: ["Web"], source: "derived" as const },
    ];
    const resolver = new OwnershipResolver(config, undefined, { directory });
    expect(resolver.resolve(["domain:web"]).owner).toBe("alice");
  });

  it("returns no owner rather than a wrong one when the directory is empty", () => {
    const resolver = new OwnershipResolver(config, undefined, { directory: [] });
    expect(resolver.resolve(["domain:web"]).owner).toBeUndefined();
  });

  it("still works with no directory at all — back-compat with existing callers", () => {
    const resolver = new OwnershipResolver(config);
    expect(resolver.resolve(["domain:web"]).owner).toBeUndefined();
    expect(resolver.resolve(["domain:web"]).team).toBe("Web");
  });

  it("round-robins across directory owners for the team", () => {
    const directory = [
      { githubLogin: "alice", slackId: null, displayName: null, managerGithub: null, teams: ["Web"], source: "derived" as const },
      { githubLogin: "bob", slackId: null, displayName: null, managerGithub: null, teams: ["Web"], source: "derived" as const },
    ];
    const resolver = new OwnershipResolver(config, undefined, { directory });
    expect([resolver.nextOwner("web"), resolver.nextOwner("web"), resolver.nextOwner("web")]).toEqual([
      "alice",
      "bob",
      "alice",
    ]);
  });

  it("matches the team case-insensitively — config says Web, CODEOWNERS says web", () => {
    const directory = [
      { githubLogin: "alice", slackId: null, displayName: null, managerGithub: null, teams: ["web"], source: "derived" as const },
    ];
    const resolver = new OwnershipResolver(config, undefined, { directory });
    expect(resolver.resolve(["domain:web"]).owner).toBe("alice");
  });
});
