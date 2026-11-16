import { describe, it, expect, beforeEach } from "vitest";
import type { MemoryEpisodeInput, MemoryEpisodeKind, MemoryScope, RecallQuery } from "@lexi/contracts";
import {
  EpisodicMemoryService,
  authorityOf,
  selectQueryTerms,
  termOverlap,
  type MemoryEpisodeStore,
} from "./episodic-memory.service";
import { parseMemoryPolicy } from "../load-memory-policy";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Episodic memory.
 *
 * The load-bearing property here is visibility. Work facts are org-shared;
 * anything derived from a DM or stated as a personal preference is private to
 * its subject. A leak in this direction is not a degraded answer, it is one
 * user reading another user's DM content, so it is tested from both sides:
 * the query the service builds, and a defensive filter over what comes back.
 */

const policy = parseMemoryPolicy(
  readFileSync(resolve(__dirname, "../../../../examples/config/memory-policy.yaml"), "utf-8"),
);

interface Row {
  id: string;
  scope: string;
  subjectUserId: string | null;
  kind: string;
  threadKey: string | null;
  entityType: string | null;
  entityId: string | null;
  content: string;
  importance: number;
  confidence: number;
  provenance: unknown;
  expiresAt: Date | null;
  createdAt: Date;
  supersededById: string | null;
  supersededAt: Date | null;
  validFrom: Date | null;
  validUntil: Date | null;
}

/**
 * In-memory stand-in for `memory_episodes`, honouring the where-clause.
 *
 * `orderBy`, `take` and `contains` are all implemented rather than ignored,
 * and that is load-bearing rather than thoroughness. Candidate retrieval is
 * now two bounded passes — one term-filtered, one newest-first — and a double
 * that returned every row regardless of arguments would make the window tests
 * pass no matter what the service did, including under the newest-200 bug they
 * exist to catch.
 */
function createStore(seed: Partial<Row>[] = []) {
  const rows: Row[] = seed.map((r, i) => ({
    id: r.id ?? `e${i}`,
    scope: r.scope ?? "org",
    subjectUserId: r.subjectUserId ?? null,
    kind: r.kind ?? "fact",
    threadKey: r.threadKey ?? null,
    entityType: r.entityType ?? null,
    entityId: r.entityId ?? null,
    content: r.content ?? "",
    importance: r.importance ?? 0.5,
    confidence: r.confidence ?? 1,
    provenance: r.provenance ?? {},
    expiresAt: r.expiresAt ?? null,
    createdAt: r.createdAt ?? new Date(),
    supersededById: r.supersededById ?? null,
    supersededAt: r.supersededAt ?? null,
    validFrom: r.validFrom ?? null,
    validUntil: r.validUntil ?? null,
  }));

  const store: MemoryEpisodeStore & {
    rows: Row[];
    lastWhere: unknown;
    /** Every findMany the service issued, so the passes can be asserted. */
    reads: Array<{ where?: Record<string, unknown>; take?: number }>;
  } = {
    rows,
    lastWhere: undefined,
    reads: [],
    memoryEpisode: {
      async create({ data }) {
        rows.push({ ...(data as unknown as Row) });
        return data;
      },
      async deleteMany({ where }) {
        store.lastWhere = where;
        const doomed = rows.filter((row) => matchWhere(row, where as Record<string, unknown>));
        for (const row of doomed) rows.splice(rows.indexOf(row), 1);
        return { count: doomed.length };
      },
      async updateMany({ where, data }) {
        store.lastWhere = where;
        const hit = rows.filter((row) => matchWhere(row, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
      async findMany(args) {
        store.lastWhere = args?.where;
        store.reads.push({ where: args?.where, take: args?.take });

        const where = (args?.where ?? {}) as Record<string, unknown>;
        const matched = rows.filter((row) => matchWhere(row, where));

        const direction = (args?.orderBy as Record<string, string> | undefined)?.createdAt;
        if (direction) {
          matched.sort((a, b) =>
            direction === "asc"
              ? a.createdAt.getTime() - b.createdAt.getTime()
              : b.createdAt.getTime() - a.createdAt.getTime(),
          );
        }

        const limited = typeof args?.take === "number" ? matched.slice(0, args.take) : matched;
        return limited as unknown as Array<Record<string, unknown>>;
      },
    },
  };
  return store;
}

/**
 * Recursive where matcher covering the operators the service actually emits:
 * nested `AND`/`OR`, scalar and `null` equality, `{ in }`, `{ contains, mode }`
 * and Prisma's JSON `{ path, equals }`.
 *
 * Anything unrecognised returns false rather than true, so a clause this
 * double does not understand fails the test loudly instead of being silently
 * treated as satisfied.
 */
function matchWhere(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      if (!(condition as Array<Record<string, unknown>>).some((clause) => matchWhere(row, clause))) return false;
      continue;
    }
    if (key === "AND") {
      if (!(condition as Array<Record<string, unknown>>).every((clause) => matchWhere(row, clause))) return false;
      continue;
    }
    if (!matchField(row, key, condition)) return false;
  }
  return true;
}

function matchField(row: Row, field: string, condition: unknown): boolean {
  const actual = (row as unknown as Record<string, unknown>)[field];

  if (condition !== null && typeof condition === "object") {
    const op = condition as Record<string, unknown>;

    if ("path" in op) {
      const at = (op.path as string[]).reduce<unknown>(
        (acc, key) => (acc as Record<string, unknown> | undefined)?.[key],
        (actual ?? {}) as Record<string, unknown>,
      );
      return at === op.equals;
    }
    if ("in" in op) return (op.in as unknown[]).includes(actual);
    if ("contains" in op) {
      const needle = String(op.contains);
      const haystack = String(actual ?? "");
      return op.mode === "insensitive"
        ? haystack.toLowerCase().includes(needle.toLowerCase())
        : haystack.includes(needle);
    }
    if ("equals" in op) return actual === op.equals;
    return false;
  }

  // Plain equality, including the `null` case — `{ threadKey: null }` and
  // `{ supersededById: null }` are explicit "is null" clauses, not clauses to
  // skip because the value is falsy.
  return actual === condition;
}

describe("EpisodicMemoryService — visibility", () => {
  it("never returns another user's private episode", async () => {
    const store = createStore([
      { id: "org1", scope: "org", kind: "decision", content: "team agreed to ship the deposit fix" },
      { id: "u1", scope: "user", subjectUserId: "U1", kind: "preference", content: "U1 prefers brief answers" },
      { id: "u2", scope: "user", subjectUserId: "U2", kind: "preference", content: "U2 prefers detailed answers" },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    const forU1 = await service.recall({ query: "prefers", subjectUserId: "U1" });
    const ids = forU1.map((e) => e.id);

    expect(ids).toContain("u1");
    expect(ids).not.toContain("u2");
  });

  it("returns only org-scoped episodes when no subject is supplied", async () => {
    const store = createStore([
      { id: "org1", scope: "org", kind: "decision", content: "agreed to ship" },
      { id: "u1", scope: "user", subjectUserId: "U1", kind: "preference", content: "prefers brief" },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    const results = await service.recall({ query: "prefers" });
    expect(results.map((e) => e.id)).toEqual(["org1"]);
  });

  it("returns a user's own private episode alongside org facts", async () => {
    const store = createStore([
      { id: "org1", scope: "org", kind: "decision", content: "agreed to ship the deposit fix" },
      { id: "u1", scope: "user", subjectUserId: "U1", kind: "preference", content: "U1 prefers deposit summaries brief" },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    const ids = (await service.recall({ query: "deposit", subjectUserId: "U1" })).map((e) => e.id);
    expect(ids).toContain("org1");
    expect(ids).toContain("u1");
  });

  it("scope:'user' narrows to that subject's private episodes only", async () => {
    const store = createStore([
      { id: "org1", scope: "org", kind: "decision", content: "deposit decision" },
      { id: "u1", scope: "user", subjectUserId: "U1", kind: "preference", content: "deposit preference" },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    const ids = (await service.recall({ query: "deposit", scope: "user", subjectUserId: "U1" })).map((e) => e.id);
    expect(ids).toEqual(["u1"]);
  });

  it("refuses a user-scoped recall with no subject rather than widening it", async () => {
    // Silently falling back to org scope here would turn a private query into
    // a shared one; failing loudly is the only safe direction.
    const service = new EpisodicMemoryService(createStore(), policy);
    await expect(service.recall({ query: "x", scope: "user" })).rejects.toThrow(/subjectUserId/i);
  });

  it("filters a leaked row defensively even if the store ignores the where-clause", async () => {
    // Defence in depth: the store is a port another stream wires up. A bug
    // there must not become a cross-user disclosure here.
    const store = createStore();
    store.memoryEpisode.findMany = async () =>
      [
        { id: "u2", scope: "user", subjectUserId: "U2", kind: "preference", content: "U2 secret", importance: 0.9, confidence: 1, provenance: {}, threadKey: null, entityType: null, entityId: null, expiresAt: null, createdAt: new Date() },
      ] as never;
    const service = new EpisodicMemoryService(store, policy);

    const results = await service.recall({ query: "secret", subjectUserId: "U1" });
    expect(results).toEqual([]);
  });
});

describe("EpisodicMemoryService — writes", () => {
  let store: ReturnType<typeof createStore>;
  let service: EpisodicMemoryService;

  beforeEach(() => {
    store = createStore();
    service = new EpisodicMemoryService(store, policy);
  });

  it("persists an org-scoped work fact", async () => {
    await service.remember({ scope: "org", kind: "decision", content: "agreed to ship behind a flag" });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].scope).toBe("org");
  });

  it("rejects a user-scoped episode with no subject", async () => {
    await expect(
      service.remember({ scope: "user", kind: "preference", content: "prefers brief" } as MemoryEpisodeInput),
    ).rejects.toThrow(/subjectUserId/i);
  });

  it("forces a preference to user scope even when the caller says org", async () => {
    // Policy `visibility.userKinds`: a stated personal preference is
    // private by classification, not by the caller remembering to say so.
    await service.remember({ scope: "org", kind: "preference", subjectUserId: "U1", content: "prefers brief" });
    expect(store.rows[0].scope).toBe("user");
    expect(store.rows[0].subjectUserId).toBe("U1");
  });

  it("forces DM-derived content to user scope whatever its kind", async () => {
    // policy `visibility.dmDerivedIsUserScoped`.
    await service.remember({
      scope: "org",
      kind: "fact",
      subjectUserId: "U1",
      content: "said in a DM that the release slips",
      provenance: { source: "dm" },
    });
    expect(store.rows[0].scope).toBe("user");
  });

  it("refuses to force user scope when it has no subject to attach it to", async () => {
    await expect(
      service.remember({ scope: "org", kind: "preference", content: "prefers brief" }),
    ).rejects.toThrow(/subjectUserId/i);
  });

  it("defaults importance and confidence rather than storing nulls", async () => {
    await service.remember({ scope: "org", kind: "fact", content: "deposit uses the balance cache" });
    expect(store.rows[0].importance).toBeCloseTo(0.5);
    expect(store.rows[0].confidence).toBeCloseTo(1);
  });
});

describe("EpisodicMemoryService — ranking", () => {
  it("ranks a relevant, recent, important episode above an irrelevant old one", async () => {
    const old = new Date(Date.now() - 60 * 24 * 3600 * 1000);
    const store = createStore([
      { id: "stale", scope: "org", kind: "fact", content: "unrelated routing note", importance: 0.2, createdAt: old },
      { id: "hot", scope: "org", kind: "decision", content: "deposit button fix agreed", importance: 0.9, createdAt: new Date() },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    const results = await service.recall({ query: "deposit button" });
    expect(results[0].id).toBe("hot");
  });

  it("caps results at the policy's maxEpisodesPerRecall", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `e${i}`,
      scope: "org",
      kind: "fact",
      content: `deposit note ${i}`,
    }));
    const service = new EpisodicMemoryService(createStore(many), policy);

    const results = await service.recall({ query: "deposit" });
    expect(results.length).toBeLessThanOrEqual(policy.budgets.maxEpisodesPerRecall);
  });

  it("honours an explicit limit below the policy cap", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, scope: "org", kind: "fact", content: `deposit ${i}` }));
    const service = new EpisodicMemoryService(createStore(many), policy);

    expect(await service.recall({ query: "deposit", limit: 3 })).toHaveLength(3);
  });

  it("drops expired episodes", async () => {
    const store = createStore([
      { id: "gone", scope: "org", kind: "fact", content: "deposit note", expiresAt: new Date(Date.now() - 1000) },
      { id: "live", scope: "org", kind: "fact", content: "deposit note", expiresAt: new Date(Date.now() + 100000) },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    expect((await service.recall({ query: "deposit" })).map((e) => e.id)).toEqual(["live"]);
  });
});

/**
 * Revocation of stated preferences.
 *
 * `remember_preference` records a fact a person volunteered about themselves,
 * and the 90-day retention window is expiry rather than revocation — so a
 * person must be able to withdraw one. The load-bearing property is the same
 * one recall has: no argument combination may reach org memory, another
 * person's private memory, or a kind other than `preference`.
 */
describe("EpisodicMemoryService.forgetOwnPreferences", () => {
  const seed = () => [
    { id: "mine-1", scope: "user", subjectUserId: "U1", kind: "preference", content: "I mean P2P mobile" },
    { id: "mine-2", scope: "user", subjectUserId: "U1", kind: "preference", content: "Always check quill first" },
    { id: "theirs", scope: "user", subjectUserId: "U2", kind: "preference", content: "I mean Home web" },
    { id: "org-fact", scope: "org", subjectUserId: null, kind: "fact", content: "I mean P2P mobile" },
    { id: "my-decision", scope: "user", subjectUserId: "U1", kind: "decision", content: "Dispatch it anyway" },
  ];

  it("forgets only that person's stated preferences", async () => {
    const store = createStore(seed());
    const service = new EpisodicMemoryService(store, policy);

    expect(await service.forgetOwnPreferences("U1")).toBe(2);
    expect(store.rows.map((r) => r.id).sort()).toEqual(["my-decision", "org-fact", "theirs"]);
  });

  it("never reaches another person's private memory", async () => {
    const store = createStore(seed());
    const service = new EpisodicMemoryService(store, policy);

    await service.forgetOwnPreferences("U1");
    expect(store.rows.some((r) => r.id === "theirs")).toBe(true);
  });

  it("never reaches org memory, even on identical content", async () => {
    // "I mean P2P mobile" exists at both scopes. A delete that matched on
    // content alone would take the shared fact with the private one.
    const store = createStore(seed());
    const service = new EpisodicMemoryService(store, policy);

    await service.forgetOwnPreferences("U1", "P2P mobile");
    expect(store.rows.some((r) => r.id === "org-fact")).toBe(true);
    expect(store.rows.some((r) => r.id === "mine-1")).toBe(false);
  });

  it("leaves the person's own non-preference episodes alone", async () => {
    // A recorded correction or decision is not a preference and is not the
    // person's to withdraw — it is how the org explains a past action.
    const store = createStore(seed());
    const service = new EpisodicMemoryService(store, policy);

    await service.forgetOwnPreferences("U1");
    expect(store.rows.some((r) => r.id === "my-decision")).toBe(true);
  });

  it("matches `contains` case-insensitively and scopes the query", async () => {
    const store = createStore(seed());
    const service = new EpisodicMemoryService(store, policy);

    expect(await service.forgetOwnPreferences("U1", "p2p MOBILE")).toBe(1);
    expect(store.lastWhere).toMatchObject({
      scope: "user",
      subjectUserId: "U1",
      kind: "preference",
    });
  });

  it("reports zero rather than failing when nothing matches", async () => {
    const store = createStore(seed());
    const service = new EpisodicMemoryService(store, policy);

    expect(await service.forgetOwnPreferences("U1", "nothing like this")).toBe(0);
  });

  it("refuses an unowned delete", async () => {
    const store = createStore(seed());
    const service = new EpisodicMemoryService(store, policy);

    await expect(service.forgetOwnPreferences("")).rejects.toThrow(/without a subjectUserId/);
    expect(store.rows).toHaveLength(5);
  });
});

/**
 * Team conventions are org-scoped and shared, so their revocation has a
 * different blast radius from a personal preference: it must reach every
 * convention and nothing else. In particular it must not reach a `decision`
 * the deterministic extractor derived from a tool outcome — an org record of
 * what actually happened is not someone's to retract.
 */
describe("EpisodicMemoryService.forgetTeamConventions", () => {
  const CONVENTION_TOOL = "remember_team_convention";
  const seed = () => [
    {
      id: "conv-1",
      scope: "org",
      kind: "decision",
      content: "Tag the requester as Author",
      provenance: { tool: CONVENTION_TOOL, actor: "U1" },
    },
    {
      id: "conv-2",
      scope: "org",
      kind: "decision",
      content: "Use the four-link row",
      provenance: { tool: CONVENTION_TOOL, actor: "U2" },
    },
    {
      id: "extracted",
      scope: "org",
      kind: "decision",
      content: "Tag the requester as Author",
      provenance: { tool: "trigger_direct_fix", actor: "U1" },
    },
    {
      id: "mine",
      scope: "user",
      subjectUserId: "U1",
      kind: "preference",
      content: "Tag the requester as Author",
      provenance: { tool: "remember_preference" },
    },
  ];

  it("removes every recorded convention when no filter is given", async () => {
    const store = createStore(seed());
    const service = new EpisodicMemoryService(store, policy);

    expect(await service.forgetTeamConventions()).toBe(2);
    expect(store.rows.map((r) => r.id).sort()).toEqual(["extracted", "mine"]);
  });

  it("never removes a decision the extractor derived from a tool outcome", async () => {
    // Identical content, different provenance. Matching on content or kind
    // alone would delete the record of what actually happened.
    const store = createStore(seed());
    const service = new EpisodicMemoryService(store, policy);

    await service.forgetTeamConventions("Tag the requester");
    expect(store.rows.some((r) => r.id === "extracted")).toBe(true);
    expect(store.rows.some((r) => r.id === "conv-1")).toBe(false);
  });

  it("never reaches a personal preference, even on identical content", async () => {
    const store = createStore(seed());
    const service = new EpisodicMemoryService(store, policy);

    await service.forgetTeamConventions("Tag the requester");
    expect(store.rows.some((r) => r.id === "mine")).toBe(true);
  });

  it("scopes the delete to org decisions written by the convention tool", async () => {
    const store = createStore(seed());
    const service = new EpisodicMemoryService(store, policy);

    await service.forgetTeamConventions();
    expect(store.lastWhere).toMatchObject({
      scope: "org",
      kind: "decision",
      provenance: { path: ["tool"], equals: CONVENTION_TOOL },
    });
  });

  it("reports zero rather than failing when nothing matches", async () => {
    const store = createStore(seed());
    const service = new EpisodicMemoryService(store, policy);

    expect(await service.forgetTeamConventions("nothing like this")).toBe(0);
  });
});

/**
 * A standing fact belongs to no thread, so it must be recallable from every
 * thread.
 *
 * `threadKey` used to be a hard equality in the recall query, while both
 * explicit writers — `remember_team_convention` and `remember_preference` —
 * record with no thread key at all. A `null` column never equals a concrete
 * key, so every convention and preference a human deliberately taught Lexi was
 * accepted, acknowledged, and then filtered out of every subsequent recall.
 * A set of rules taught in one thread was acknowledged as recorded and could
 * never come back.
 *
 * The inversion is what made it hard to see — the deterministic extractor DOES
 * set a thread key, so facts Lexi inferred from tool outcomes recalled
 * normally, and only the ones she was told failed.
 *
 * Both directions are asserted here: thread-independent rows come back, and a
 * thread-scoped row from a DIFFERENT thread still does not, so the narrowing
 * is fixed rather than removed.
 */
describe("EpisodicMemoryService.recall — thread-independent facts", () => {
  const HERE = "C0TEST04:1788512739.298299";
  const ELSEWHERE = "C0OTHER:1788000000.000000";

  it("recalls an org convention that was recorded with no thread key", async () => {
    const store = createStore([
      {
        id: "conv",
        scope: "org",
        kind: "decision",
        threadKey: null,
        content: "Release integration branches use a hyphen, not a slash",
        importance: 0.9,
      },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    const found = await service.recall({
      threadKey: HERE,
      query: "release candidate branch naming",
      subjectUserId: "U0TEST07",
    } as Parameters<EpisodicMemoryService["recall"]>[0]);

    expect(found.map((e) => e.id)).toContain("conv");
  });

  it("recalls the caller's own preference recorded with no thread key", async () => {
    const store = createStore([
      {
        id: "pref",
        scope: "user",
        subjectUserId: "U0TEST07",
        kind: "preference",
        threadKey: null,
        content: "Keep replies short and use hyperlinks for PR numbers",
      },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    const found = await service.recall({
      threadKey: HERE,
      query: "reply length hyperlinks",
      subjectUserId: "U0TEST07",
    } as Parameters<EpisodicMemoryService["recall"]>[0]);

    expect(found.map((e) => e.id)).toContain("pref");
  });

  /**
   * This assertion used to read `not.toContain("other-thread")`, and that was
   * the second half of the same mistake.
   *
   * The comment above says a thread is about RELEVANCE and not permission, and
   * the fix that rescued thread-independent facts still enforced the opposite:
   * it kept "this thread plus threadless", so an episode recorded against
   * another thread was excluded outright. Anything Lexi learned while working
   * one thread was unavailable in the next, and every thread started over —
   * which is not a scope rule, it is amnesia with a scope rule's shape.
   *
   * So the narrowing moved into the ranking. Other threads' episodes are
   * candidates and rank below local material (`CROSS_THREAD_FACTOR`); nothing
   * about who may see what changed, because that is `scope`/`subjectUserId`
   * and those are still enforced three times over.
   *
   * The original exclusion is asserted immediately below, under the
   * `sameThreadOnly` flag that now carries it.
   */
  it("makes another thread's episode available, not hidden", async () => {
    const store = createStore([
      {
        id: "other-thread",
        scope: "org",
        kind: "fact",
        threadKey: ELSEWHERE,
        content: "Release integration branches use a hyphen, not a slash",
      },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    const found = await service.recall({
      threadKey: HERE,
      query: "release candidate branch naming",
      subjectUserId: "U0TEST07",
    } as Parameters<EpisodicMemoryService["recall"]>[0]);

    expect(found.map((e) => e.id)).toContain("other-thread");
  });

  it("hides another thread's episode when the caller asks for sameThreadOnly", async () => {
    // The pre-cross-thread behaviour, preserved verbatim for the caller that
    // genuinely wants one thread's view — a replay, or reproducing what a
    // single thread could see. Never a privacy control.
    const store = createStore([
      {
        id: "other-thread",
        scope: "org",
        kind: "fact",
        threadKey: ELSEWHERE,
        content: "Release integration branches use a hyphen, not a slash",
      },
      {
        id: "standing",
        scope: "org",
        kind: "decision",
        threadKey: null,
        content: "Release integration branches are reported with a link",
      },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    const ids = (
      await service.recall({
        threadKey: HERE,
        query: "release candidate branch naming",
        subjectUserId: "U0TEST07",
        sameThreadOnly: true,
      } as Parameters<EpisodicMemoryService["recall"]>[0])
    ).map((e) => e.id);

    expect(ids).not.toContain("other-thread");
    // Thread-INDEPENDENT facts must survive even the strict narrowing — that
    // is the standing-facts lesson above, and `sameThreadOnly` must not
    // reintroduce it.
    expect(ids).toContain("standing");
  });

  it("ranks this thread's own and thread-independent episodes above another thread's", async () => {
    const store = createStore([
      { id: "mine-here", scope: "org", kind: "fact", threadKey: HERE, content: "dispatched the integration run" },
      { id: "standing", scope: "org", kind: "decision", threadKey: null, content: "dispatched runs are reported with a link" },
      { id: "not-mine", scope: "org", kind: "fact", threadKey: ELSEWHERE, content: "dispatched something unrelated" },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    const ids = (
      await service.recall({
        threadKey: HERE,
        query: "dispatched",
        subjectUserId: "U0TEST07",
      } as Parameters<EpisodicMemoryService["recall"]>[0])
    ).map((e) => e.id);

    expect(ids).toContain("mine-here");
    expect(ids).toContain("standing");
    // Available, but last: all three match the query equally, so the only
    // thing separating them is the cross-thread demotion.
    expect(ids).toContain("not-mine");
    expect(ids.indexOf("not-mine")).toBeGreaterThan(ids.indexOf("mine-here"));
    expect(ids.indexOf("not-mine")).toBeGreaterThan(ids.indexOf("standing"));
  });
});

/**
 * Candidate retrieval must search the whole authorized corpus, not its newest
 * slice.
 *
 * Recall used to take the newest 200 eligible rows by `createdAt desc` and
 * rank those. The ranking was right; the window was chosen by recency alone,
 * so once a fact fell past row 200 it could not be CONSIDERED however relevant
 * it was. The store still held it, `forgetTeamConventions` still counted it,
 * and recall could never return it — and because a plausible answer still came
 * back from whatever was recent, nothing in the reply said the corpus had been
 * truncated. On a busy deployment a convention taught in March was unreachable
 * by April.
 *
 * The test seeds enough newer noise to bury the target well past any fixed
 * window, and asserts that it IS buried before asserting that it comes back —
 * so this cannot rot into a tautology if the window ever returns.
 */
describe("EpisodicMemoryService.recall — candidate retrieval over the whole corpus", () => {
  const NOISE = 3000;

  /** Newest-first noise, with one old relevant fact underneath all of it. */
  function buryATarget() {
    const now = Date.now();
    const rows = Array.from({ length: NOISE }, (_, i) => ({
      id: `noise-${i}`,
      scope: "org",
      kind: "fact" as const,
      content: `routing note ${i} for an unrelated area`,
      importance: 0.5,
      // Newest first: noise-0 is the most recent.
      createdAt: new Date(now - i * 60_000),
    }));

    rows.push({
      id: "buried",
      scope: "org",
      kind: "fact" as const,
      content: "the deposit retry ledger is keyed by transaction id",
      importance: 0.5,
      createdAt: new Date(now - (NOISE + 1) * 60_000),
    });

    return rows;
  }

  it("retrieves a relevant fact buried behind thousands of newer irrelevant ones", async () => {
    const store = createStore(buryATarget());
    const service = new EpisodicMemoryService(store, policy);

    // The premise, asserted rather than assumed: in recency order the target
    // sits far past any plausible fixed window, so a newest-N read cannot see
    // it. If this assertion ever fails the test below has stopped proving
    // anything.
    const byRecency = [...store.rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    expect(byRecency.findIndex((row) => row.id === "buried")).toBeGreaterThan(1000);

    const ids = (await service.recall({ query: "deposit retry ledger" })).map((e) => e.id);

    expect(ids).toContain("buried");
    expect(ids[0]).toBe("buried");
  });

  it("finds it by pushing the query's terms into the read, not by reading everything", async () => {
    const store = createStore(buryATarget());
    const service = new EpisodicMemoryService(store, policy);

    await service.recall({ query: "deposit retry ledger" });

    // Two bounded passes, and neither is unbounded. If this ever becomes one
    // pass with no `take`, the corpus size is the read size.
    expect(store.reads.length).toBe(2);
    for (const read of store.reads) {
      expect(typeof read.take).toBe("number");
      expect(read.take).toBeLessThanOrEqual(400);
    }

    // Which pass did which job, asserted so this stays a proof.
    //
    // The recency pass takes the old window's 200 rows; the target sits at row
    // ~3000 in recency order, so it CANNOT have come from there — it can only
    // have been reached by the term-filtered pass. That is the whole
    // difference from the newest-200 read, and it is why the test above is not
    // luck. Verified by disabling the term pass, at which point that test
    // returns `['noise-0', 'noise-1', …]` and fails.
    const termRead = store.reads.find((read) => JSON.stringify(read.where ?? {}).includes("contains"));
    const recencyRead = store.reads.find((read) => !JSON.stringify(read.where ?? {}).includes("contains"));

    // The recency pass is the previous behaviour kept as a floor, so its
    // window must not shrink: nothing that used to be a candidate may stop
    // being one.
    expect(recencyRead?.take).toBe(200);
    expect(termRead?.take).toBe(400);
    expect(JSON.stringify(termRead?.where)).toContain("deposit");
  });

  it("still recalls something when the query has no usable terms", async () => {
    // The recency pass is a floor, not a leftover. A query that tokenizes to
    // nothing ("?", "any update") must not return an empty pack just because
    // there is no term to filter on.
    const store = createStore([
      { id: "recent", scope: "org", kind: "fact", content: "dispatched the integration run", importance: 0.9 },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    expect((await service.recall({ query: "?" })).map((e) => e.id)).toEqual(["recent"]);
    expect(store.reads.length).toBe(1);
  });

  it("caps the terms it sends to the database, without dropping them from ranking", () => {
    // A 2000-character investigation request tokenizes to hundreds of words,
    // and one ILIKE per word is a worse query than the scan it replaced.
    const many = Array.from({ length: 60 }, (_, i) => `distinctterm${i}`).join(" ");
    expect(selectQueryTerms(many)).toHaveLength(12);

    // Retrieval and ranking are allowed to disagree: `termOverlap` still
    // scores over every term, so a dropped term costs precision in the read
    // and nothing in the ordering.
    expect(termOverlap("alpha beta gamma", "gamma only")).toBeCloseTo(1 / 3);
  });

  it("drops stopwords and prefers the most selective terms", () => {
    // "the" as an ILIKE matches most of the table and turns the term pass back
    // into the scan it replaced. Numeric tokens go first because in this
    // corpus they identify one thing rather than a topic.
    const terms = selectQueryTerms("why did the deposit fail on #101 for the release");
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("why");
    expect(terms[0]).toBe("#101");
    expect(terms).toContain("deposit");
  });
});

/**
 * Experience earned in one thread must be usable in the next.
 *
 * This is the other half of the standing-facts lesson. Rescuing thread-independent
 * facts fixed the writers that record no thread key at all, but the
 * deterministic extractor DOES set one — so everything Lexi worked out for
 * herself stayed locked to the thread she worked it out in, and each new thread
 * started from nothing. A thread is a unit of relevance, so that belongs in the
 * ranking and not in the where-clause.
 */
describe("EpisodicMemoryService.recall — cross-thread recall", () => {
  const THREAD_A = "C0TEST04:1788512739.298299";
  const THREAD_B = "C0TEST04:1788999999.111111";

  it("retrieves in thread B a fact learned in thread A", async () => {
    const store = createStore([
      {
        id: "learned-in-a",
        scope: "org",
        kind: "fact",
        threadKey: THREAD_A,
        content: "the staging dispatch needs the workdir input or every check records as skipped",
      },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    const ids = (
      await service.recall({
        threadKey: THREAD_B,
        query: "staging dispatch workdir input",
        subjectUserId: "U0TEST07",
      } as Parameters<EpisodicMemoryService["recall"]>[0])
    ).map((e) => e.id);

    expect(ids).toContain("learned-in-a");
  });

  it("lets a markedly more relevant cross-thread fact outrank local noise", async () => {
    // The demotion is a rank and not a veto, which is the whole point: a
    // thread's own irrelevant chatter must not beat another thread's answer.
    const store = createStore([
      { id: "local-noise", scope: "org", kind: "fact", threadKey: THREAD_B, content: "acknowledged the ping" },
      {
        id: "elsewhere-relevant",
        scope: "org",
        kind: "fact",
        threadKey: THREAD_A,
        content: "the workdir input must be set or the auto-merge gate reads a skipped check as present",
      },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    const ids = (
      await service.recall({
        threadKey: THREAD_B,
        query: "workdir input skipped check auto-merge gate",
      } as Parameters<EpisodicMemoryService["recall"]>[0])
    ).map((e) => e.id);

    expect(ids[0]).toBe("elsewhere-relevant");
  });

  it("does not demote anything when the query names no thread", async () => {
    // A threadless recall has nothing to be "cross" to; every episode competes
    // on the same terms.
    const store = createStore([
      { id: "a", scope: "org", kind: "fact", threadKey: THREAD_A, content: "deposit retry ledger" },
      { id: "b", scope: "org", kind: "fact", threadKey: THREAD_B, content: "deposit retry ledger" },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    const results = await service.recall({ query: "deposit retry ledger" });
    expect(results).toHaveLength(2);
  });
});

/**
 * Temporal facts.
 *
 * "Use branch A", then "use branch B": B is what currently holds, A is what
 * used to, and A is not deleted — "we used to branch off `release/old-*`
 * and it stopped working" answers a question B cannot. So both come back, the
 * replacement leads, and `temporalStatus` says which is which so a language
 * model cannot present history as present tense.
 */
describe("EpisodicMemoryService — supersession", () => {
  const ACTOR = "U0TEST07";

  async function recordThenReplace() {
    const store = createStore();
    const service = new EpisodicMemoryService(store, policy);

    const firstId = await service.remember({
      scope: "org",
      kind: "decision",
      content: "release candidate branches are cut as release/candidate-x",
      importance: 0.9,
      provenance: { tool: "remember_team_convention", actor: ACTOR, source: "stated" },
    });

    const secondId = await service.remember({
      scope: "org",
      kind: "decision",
      content: "release candidate branches are cut as release-candidate-x",
      importance: 0.9,
      provenance: { tool: "remember_team_convention", actor: "U0OTHER", source: "stated" },
      supersedes: [firstId],
    });

    return { store, service, firstId, secondId };
  }

  it("returns the replacement as current and the replaced as historical", async () => {
    const { service, firstId, secondId } = await recordThenReplace();

    const results = await service.recall({ query: "release candidate branches cut" });
    const byId = new Map(results.map((e) => [e.id, e]));

    expect(byId.get(secondId)?.temporalStatus).toBe("current");
    expect(byId.get(firstId)?.temporalStatus).toBe("historical");
  });

  it("keeps the superseded fact recallable rather than deleting it", async () => {
    const { store, service, firstId } = await recordThenReplace();

    expect(store.rows.some((row) => row.id === firstId)).toBe(true);
    const ids = (await service.recall({ query: "release candidate branches cut" })).map((e) => e.id);
    expect(ids).toContain(firstId);
  });

  it("ranks the current fact above the one it replaced", async () => {
    const { service, firstId, secondId } = await recordThenReplace();

    const ids = (await service.recall({ query: "release candidate branches cut" })).map((e) => e.id);
    expect(ids.indexOf(secondId)).toBeLessThan(ids.indexOf(firstId));
  });

  it("carries the dates and the attribution the history needs", async () => {
    const { service, firstId, secondId } = await recordThenReplace();

    const results = await service.recall({ query: "release candidate branches cut" });
    const historical = results.find((e) => e.id === firstId);

    // Which fact replaced it, when it stopped holding, and when it started.
    expect(historical?.supersededById).toBe(secondId);
    expect(historical?.supersededAt).toBeTruthy();
    expect(historical?.validUntil).toBe(historical?.supersededAt);
    expect(historical?.validFrom).toBeTruthy();
    // Attribution survives on both sides — who stated the old rule, and (via
    // `supersededById`) who stated the one that replaced it.
    expect(historical?.provenance.actor).toBe(ACTOR);
    expect(results.find((e) => e.id === secondId)?.provenance.actor).toBe("U0OTHER");
  });

  it("honours an explicit validFrom for a rule that starts later", async () => {
    const store = createStore();
    const service = new EpisodicMemoryService(store, policy);

    await service.remember({
      scope: "org",
      kind: "decision",
      content: "from Monday the release candidate branch is cut from develop",
      validFrom: "2026-09-14T00:00:00.000Z",
    });

    const results = await service.recall({ query: "release candidate branch cut from" });
    expect(results[0].validFrom).toBe("2026-09-14T00:00:00.000Z");
  });

  it("drops history when the caller asks for currentOnly", async () => {
    const { service, firstId, secondId } = await recordThenReplace();

    const ids = (
      await service.recall({
        query: "release candidate branches cut",
        currentOnly: true,
      } as Parameters<EpisodicMemoryService["recall"]>[0])
    ).map((e) => e.id);

    expect(ids).toContain(secondId);
    expect(ids).not.toContain(firstId);
  });

  it("keeps an unresolved conflict visible from both sides", async () => {
    // Two people say different things and nobody has resolved it. Neither is
    // superseded, so both are current and both come back — auto-superseding on
    // similarity would let one statement silently erase the other.
    const store = createStore([
      {
        id: "says-hyphen",
        scope: "org",
        kind: "decision",
        content: "release candidate branches use a hyphen",
        provenance: { tool: "remember_team_convention", actor: "U1" },
      },
      {
        id: "says-slash",
        scope: "org",
        kind: "decision",
        content: "release candidate branches use a slash",
        provenance: { tool: "remember_team_convention", actor: "U2" },
      },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    const results = await service.recall({ query: "release candidate branches use" });
    expect(results.map((e) => e.id).sort()).toEqual(["says-hyphen", "says-slash"]);
    expect(results.every((e) => e.temporalStatus === "current")).toBe(true);
  });

  it("prefers a stated convention over a newer inference", async () => {
    // Recency alone must not override a more authoritative source. Equal
    // relevance and equal importance; the taught fact is a month older and
    // must still lead.
    const store = createStore([
      {
        id: "taught",
        scope: "org",
        kind: "decision",
        content: "branch naming uses a hyphen",
        importance: 0.5,
        confidence: 1,
        provenance: { tool: "remember_team_convention", actor: "U9", source: "stated" },
        createdAt: new Date(Date.now() - 30 * 24 * 3600 * 1000),
      },
      {
        id: "inferred",
        scope: "org",
        kind: "decision",
        content: "branch naming uses a slash",
        importance: 0.5,
        confidence: 1,
        provenance: { tool: "trigger_direct_fix", actor: "U9" },
        createdAt: new Date(),
      },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    const ids = (await service.recall({ query: "branch naming" })).map((e) => e.id);
    expect(ids[0]).toBe("taught");
  });

  it("scores a stated convention above an observed one, and both above an inference", () => {
    // `remember_team_convention` writes confidence 0.7 for `observed` and 1
    // for `stated`, and authority is scaled by it.
    const stated = { provenance: { tool: "remember_team_convention", actor: "U1" }, confidence: 1 };
    const observed = { provenance: { tool: "remember_team_convention", actor: "U1" }, confidence: 0.7 };
    const derived = { provenance: { tool: "trigger_direct_fix", actor: "U1" }, confidence: 1 };
    const anonymous = { provenance: {}, confidence: 1 };

    expect(authorityOf(stated)).toBeGreaterThan(authorityOf(observed));
    expect(authorityOf(observed)).toBeGreaterThan(authorityOf(derived));
    expect(authorityOf(derived)).toBeGreaterThan(authorityOf(anonymous));
  });

  it("refuses to supersede another person's private episode", async () => {
    // The read path is protected three times over; this is the same rule on
    // the write side. `supersedes` is a model-supplied id list, so without a
    // scope-matched update it would point at any row in the table.
    const store = createStore([
      { id: "theirs", scope: "user", subjectUserId: "U2", kind: "preference", content: "U2 prefers detail" },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    await service.remember({
      scope: "user",
      subjectUserId: "U1",
      kind: "preference",
      content: "U1 prefers brief",
      supersedes: ["theirs"],
    });

    expect(store.rows.find((row) => row.id === "theirs")?.supersededById).toBeNull();
  });

  it("refuses to let a personal preference retract an org convention", async () => {
    const store = createStore([
      {
        id: "convention",
        scope: "org",
        kind: "decision",
        content: "tag the requester as Author",
        provenance: { tool: "remember_team_convention", actor: "U1" },
      },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    await service.remember({
      scope: "user",
      subjectUserId: "U1",
      kind: "preference",
      content: "do not tag me as Author",
      supersedes: ["convention"],
    });

    expect(store.rows.find((row) => row.id === "convention")?.supersededById).toBeNull();
  });

  it("reports how many rows it actually superseded", async () => {
    const store = createStore([{ id: "real", scope: "org", kind: "decision", content: "old rule" }]);
    const service = new EpisodicMemoryService(store, policy);

    // Lower than the id count, because one id does not exist. A caller that
    // says "noted, the old rule no longer applies" needs the difference.
    expect(await service.supersede(["real", "does-not-exist"], "replacement", { scope: "org" })).toBe(1);
  });

  it("does not re-date a fact something already replaced", async () => {
    // The first supersession is when the fact stopped holding. Moving that
    // boundary on a later write would lose the actual history.
    const first = new Date("2026-09-01T00:00:00.000Z");
    const store = createStore([
      {
        id: "already",
        scope: "org",
        kind: "decision",
        content: "old rule",
        supersededById: "second",
        supersededAt: first,
        validUntil: first,
      },
    ]);
    const service = new EpisodicMemoryService(store, policy);

    expect(await service.supersede(["already"], "third", { scope: "org" })).toBe(0);
    expect(store.rows[0].supersededById).toBe("second");
    expect(store.rows[0].supersededAt).toBe(first);
  });

  it("throws rather than silently skipping when the store cannot update", async () => {
    // A replacement recorded while the old fact still reads as current is the
    // exact failure supersession exists to prevent, and it would be invisible
    // from the caller's side.
    const store = createStore([{ id: "old", scope: "org", kind: "decision", content: "old rule" }]);
    delete (store.memoryEpisode as { updateMany?: unknown }).updateMany;
    const service = new EpisodicMemoryService(store, policy);

    await expect(service.supersede(["old"], "new", { scope: "org" })).rejects.toThrow(/updateMany/);
  });

  it("ignores an attempt to supersede itself", async () => {
    const store = createStore([{ id: "self", scope: "org", kind: "decision", content: "a rule" }]);
    const service = new EpisodicMemoryService(store, policy);

    expect(await service.supersede(["self"], "self", { scope: "org" })).toBe(0);
    expect(store.rows[0].supersededById).toBeNull();
  });
});

/**
 * The disclosure guarantee, swept over the argument space.
 *
 * Everything above widened what recall CONSIDERS: other threads' episodes,
 * term-selected candidates from anywhere in history, superseded rows. None of
 * it may widen what recall SHOWS by a single row. This enumerates the
 * combinations rather than sampling them, because the failure mode is one user
 * reading another user's DM content and a spot check is not a proof.
 */
describe("EpisodicMemoryService.recall — no leakage under any argument combination", () => {
  const THREAD = "C1:1.0";
  const OTHER_THREAD = "C2:2.0";

  const seed = () => [
    { id: "org-threadless", scope: "org", kind: "decision", threadKey: null, content: "deposit retry is shared" },
    { id: "org-here", scope: "org", kind: "fact", threadKey: THREAD, content: "deposit retry dispatched here" },
    { id: "org-elsewhere", scope: "org", kind: "fact", threadKey: OTHER_THREAD, content: "deposit retry dispatched elsewhere" },
    { id: "u1-pref", scope: "user", subjectUserId: "U1", kind: "preference", content: "U1 deposit retry brief" },
    { id: "u1-dm", scope: "user", subjectUserId: "U1", kind: "fact", threadKey: OTHER_THREAD, content: "U1 said in a DM the deposit retry slips" },
    { id: "u2-pref", scope: "user", subjectUserId: "U2", kind: "preference", content: "U2 deposit retry detailed" },
    { id: "u2-dm", scope: "user", subjectUserId: "U2", kind: "fact", threadKey: THREAD, content: "U2 said in a DM the deposit retry slips" },
    {
      id: "u2-superseded",
      scope: "user",
      subjectUserId: "U2",
      kind: "preference",
      content: "U2 deposit retry old",
      supersededById: "u2-pref",
    },
  ];

  const U2_IDS = ["u2-pref", "u2-dm", "u2-superseded"];
  const ORG_IDS = ["org-threadless", "org-here", "org-elsewhere"];

  /** Every combination of the arguments that touch narrowing. */
  function combinations(): RecallQuery[] {
    const scopes: Array<MemoryScope | undefined> = [undefined, "org", "user"];
    const kindSets: Array<MemoryEpisodeKind[] | undefined> = [
      undefined,
      ["preference"],
      ["fact", "decision"],
    ];

    const out: RecallQuery[] = [];
    for (const scope of scopes) {
      for (const subjectUserId of [undefined, "U1"]) {
        for (const threadKey of [undefined, THREAD, OTHER_THREAD]) {
          for (const sameThreadOnly of [undefined, false, true]) {
            for (const currentOnly of [undefined, false, true]) {
              for (const kinds of kindSets) {
                // `scope: "user"` with no subject is refused outright, and
                // that refusal has its own spec above.
                if (scope === "user" && !subjectUserId) continue;
                out.push({
                  query: "deposit retry",
                  ...(scope ? { scope } : {}),
                  ...(subjectUserId ? { subjectUserId } : {}),
                  ...(threadKey ? { threadKey } : {}),
                  ...(sameThreadOnly === undefined ? {} : { sameThreadOnly }),
                  ...(currentOnly === undefined ? {} : { currentOnly }),
                  ...(kinds ? { kinds } : {}),
                  limit: 50,
                });
              }
            }
          }
        }
      }
    }
    return out;
  }

  it("never returns another user's episode, under any combination", async () => {
    const service = new EpisodicMemoryService(createStore(seed()), policy);
    const args = combinations();
    // Guard against the sweep silently collapsing to a handful of cases.
    expect(args.length).toBeGreaterThan(100);

    for (const query of args) {
      const ids = (await service.recall(query)).map((e) => e.id);
      for (const leaked of U2_IDS) {
        expect(ids, `leaked ${leaked} for ${JSON.stringify(query)}`).not.toContain(leaked);
      }
    }
  });

  it("never returns an org episode to a user-scoped recall, under any combination", async () => {
    const service = new EpisodicMemoryService(createStore(seed()), policy);

    for (const query of combinations().filter((q) => q.scope === "user")) {
      const ids = (await service.recall(query)).map((e) => e.id);
      for (const shared of ORG_IDS) {
        expect(ids, `leaked ${shared} for ${JSON.stringify(query)}`).not.toContain(shared);
      }
    }
  });

  it("never returns a private episode when no subject is supplied, under any combination", async () => {
    const service = new EpisodicMemoryService(createStore(seed()), policy);

    for (const query of combinations().filter((q) => !q.subjectUserId)) {
      const results = await service.recall(query);
      for (const episode of results) {
        expect(episode.scope, `leaked ${episode.id} for ${JSON.stringify(query)}`).toBe("org");
      }
    }
  });

  it("constrains the query itself, not only the filter over its results", async () => {
    // The where-clause is the first of the three layers and must carry the
    // scope on BOTH candidate passes. A store that honoured the clause and a
    // service that relied only on the defensive filter look identical from
    // outside, so the emitted clause is asserted directly.
    const store = createStore(seed());
    const service = new EpisodicMemoryService(store, policy);

    await service.recall({ query: "deposit retry", subjectUserId: "U1", threadKey: THREAD });

    expect(store.reads.length).toBe(2);
    for (const read of store.reads) {
      expect(read.where?.OR).toEqual([{ scope: "org" }, { scope: "user", subjectUserId: "U1" }]);
    }
  });

  it("still returns the caller's own private episodes across every thread", async () => {
    // The mirror of the leakage assertions: the sweep must not be passing
    // because recall returns nothing at all.
    const service = new EpisodicMemoryService(createStore(seed()), policy);

    const ids = (
      await service.recall({
        query: "deposit retry",
        subjectUserId: "U1",
        threadKey: THREAD,
        limit: 50,
      } as Parameters<EpisodicMemoryService["recall"]>[0])
    ).map((e) => e.id);

    expect(ids).toContain("u1-pref");
    // Recorded against another thread, and still the caller's own.
    expect(ids).toContain("u1-dm");
    expect(ids).toContain("org-threadless");
  });
});
