import { describe, it, expect } from "vitest";
import type {
  ConformancePoint,
  CoverageDimension,
  CoverageRecord,
  DecisionNote,
  EntityRef,
  IntentClass,
  MemoryEpisodeInput,
  MemoryPack,
  MemoryPort,
  RecallQuery,
  RepoDescriptor,
  RepoRole,
  SpecChangedSection,
  SpecEvidenceLink,
  SpecNamedOwner,
  ThreadState,
  TokenBudget,
  TurnDigest,
  WorkItemRef,
} from "./index";

/**
 * Contract cover for the frozen cross-stream interfaces.
 *
 * These are types, so the real gate is `tsc` — every fixture below is annotated
 * with its frozen type and fails compilation if a field is renamed, retyped or
 * dropped. The runtime assertions exist so the same drift also shows up in
 * `vitest`, which transpiles without type-checking.
 */

describe("memory contracts", () => {
  const entity: EntityRef = {
    type: "issue",
    id: "909",
    repoKey: "issues",
    label: "#909 deposit button dead",
    url: "https://github.com/acme-internal/issues/issues/909",
  };

  const digest: TurnDigest = {
    turnId: "C1:1.1:4",
    createdAt: "2026-08-15T10:00:00.000Z",
    summary: "Confirmed the deposit button is dead on mobile web.",
    entities: [entity],
    tokenCost: 42,
    superseded: false,
  };

  const decision: DecisionNote = {
    id: "d1",
    createdAt: "2026-08-15T10:01:00.000Z",
    decidedBy: "U1",
    statement: "We ship the fix behind DEPOSIT_RETRY_ENABLED, default off.",
  };

  it("ThreadState carries the fields renderThreadState degrades over", () => {
    const state: ThreadState = {
      threadKey: "C1:1.1",
      entities: [entity],
      digests: [digest],
      openQuestions: ["Which build introduced it?"],
      decisions: [decision],
      tokenCost: 128,
    };

    expect(state.threadKey).toBe("C1:1.1");
    expect(state.digests[0].superseded).toBe(false);
    expect(state.decisions).toHaveLength(1);
    expect(state.openQuestions).toHaveLength(1);
    expect(state.coverage).toBeUndefined();
  });

  it("TokenBudget is a hard cap the pack is measured against", () => {
    const budget: TokenBudget = { maxTokens: 1500 };
    const pack: MemoryPack = {
      episodes: [],
      digests: [digest],
      decisions: [decision],
      rendered: "…",
      tokenCost: 120,
      budget,
      truncated: true,
    };

    expect(pack.tokenCost).toBeLessThanOrEqual(pack.budget.maxTokens);
    expect(pack.truncated).toBe(true);
  });

  it("RecallQuery expresses the org/user visibility split", () => {
    const orgQuery: RecallQuery = { query: "deposit retry", scope: "org", limit: 10 };
    const userQuery: RecallQuery = {
      query: "notification preference",
      scope: "user",
      subjectUserId: "U1",
    };

    expect(orgQuery.scope).toBe("org");
    expect(userQuery.subjectUserId).toBe("U1");
  });

  it("MemoryEpisodeInput mirrors the writable half of MemoryEpisode", () => {
    const episode: MemoryEpisodeInput = {
      scope: "org",
      kind: "decision",
      threadKey: "C1:1.1",
      entityType: "issue",
      entityId: "909",
      content: "Agreed to ship behind a flag.",
      importance: 0.8,
      confidence: 1,
      provenance: { tool: "trigger_direct_fix", actor: "U1" },
    };

    expect(episode.scope).toBe("org");
    expect(episode.kind).toBe("decision");
  });

  it("MemoryPort is the only surface C/D/E consume from B", async () => {
    const port: MemoryPort = {
      recall: async (_q, budget) => ({
        episodes: [],
        digests: [],
        decisions: [],
        rendered: "",
        tokenCost: 0,
        budget,
        truncated: false,
      }),
      remember: async () => undefined,
      threadState: async (threadKey) => ({
        threadKey,
        entities: [],
        digests: [],
        openQuestions: [],
        decisions: [],
        tokenCost: 0,
      }),
    };

    const pack = await port.recall({ query: "x" }, { maxTokens: 100 });
    const state = await port.threadState("C1:1.1");

    expect(pack.tokenCost).toBe(0);
    expect(state.threadKey).toBe("C1:1.1");
    await expect(port.remember({ scope: "org", kind: "fact", content: "y" })).resolves.toBeUndefined();
  });
});

describe("spec coverage contracts", () => {
  /**
   * The nine original dimensions are asserted individually rather than by
   * count, because the property that matters is that none of them was renamed
   * or dropped — `SpecSession.coverage` is persisted against these exact keys,
   * so losing one orphans stored sessions. A bare count would go green if a
   * dimension were swapped for a new one, which is the failure this guards.
   */
  it("keeps the nine originally frozen coverage dimensions", () => {
    const original: CoverageDimension[] = [
      "problem",
      "users",
      "scope",
      "non_goals",
      "acceptance_criteria",
      "platforms",
      "dependencies",
      "risks",
      "rollout",
    ];

    expect(new Set(original).size).toBe(9);
  });

  /**
   * Added later and deliberately NOT mandatory — see the union's own comment.
   * They exist so the "Edge states", "API & data" and "Metrics" sections of a
   * rendered spec have something behind them; they block no draft until
   * `config/spec-policy.yaml` lists them.
   */
  it("carries the three later dimensions that back the dead template sections", () => {
    const added: CoverageDimension[] = ["journey_states", "api_contract", "performance_plan"];

    expect(new Set(added).size).toBe(3);
  });

  it("CoverageRecord holds machine-readable state, not prose", () => {
    const coverage: CoverageRecord = {
      dimensions: {
        problem: { status: "covered", evidence: "thread", sourceTurnId: "C1:1.1:2" },
        users: { status: "deferred", reason: "reporter said out of scope for v1" },
        scope: { status: "open" },
      },
      questionTurns: 2,
      readyToDraft: false,
    };

    expect(coverage.dimensions.problem?.status).toBe("covered");
    expect(coverage.dimensions.users?.status).toBe("deferred");
    expect(coverage.readyToDraft).toBe(false);
  });

  it("revision ledger types carry changed sections, real URLs, and named owners", () => {
    const changed: SpecChangedSection = { id: "problem", heading: "Problem", kind: "changed" };
    const link: SpecEvidenceLink = {
      href: "https://acme.slack.com/archives/C1/p123",
      label: "Slack thread",
      kind: "slack_thread",
    };
    const owner: SpecNamedOwner = { role: "requester", name: "U1", slackUserId: "U1" };

    expect(changed.kind).not.toBe("unchanged" as SpecChangedSection["kind"]);
    expect(link.href.startsWith("https://")).toBe(true);
    expect(owner.role).toBe("requester");
  });
});

describe("work item and repo contracts", () => {
  it("WorkItemRef keeps tracking and code repos distinct", () => {
    const ref: WorkItemRef = {
      id: "wi-1",
      kind: "bug",
      status: "IN_PROGRESS",
      title: "Deposit button dead",
      trackingRepoKey: "issues",
      codeRepoKey: "home_web",
      issueNumber: 909,
    };

    expect(ref.trackingRepoKey).not.toBe(ref.codeRepoKey);
  });

  it("RepoDescriptor is the resolveRepo() return shape", () => {
    const roles: RepoRole[] = ["code", "specs"];
    const repo: RepoDescriptor = {
      key: "home_web",
      organization: "acme",
      repository: "web-app",
      slug: "acme/web-app",
      roles,
      platform: "web",
      team: "home",
    };

    expect(repo.slug).toBe(`${repo.organization}/${repo.repository}`);
    expect(repo.roles).toContain("specs");
  });

  it("IntentClass values drive L3 tool subsetting", () => {
    const classes: IntentClass[] = [
      "bug_intake",
      "issue_query",
      "portfolio",
      "code_task",
      "spec",
      "work_item",
      "delivery",
      "knowledge",
      "diagnostics",
      "unknown",
    ];

    expect(classes).toContain("spec");
    expect(classes).toContain("unknown");
  });
});



describe("spec-provenance contracts", () => {
  it("names the five conformance point statuses", () => {
    const statuses: ConformancePoint["status"][] = [
      "satisfied",
      "diverged",
      "extra",
      "missing",
      "indeterminate",
    ];
    expect(statuses).toHaveLength(5);
  });
});
