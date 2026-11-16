import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ThreadState, TurnDigest } from "@lexi/contracts";
import { MemoryFacade, type MemoryLoggerPort } from "./memory-facade.service";
import { ThreadStateService } from "./working/thread-state.service";
import { createCasThreadStateStore, type TestThreadStateStore } from "./working/thread-state.test-store";
import { EpisodicMemoryService, type MemoryEpisodeStore } from "./episodic/episodic-memory.service";
import { HierarchicalBuffer, isSummaryDigest, type DigestSummariser } from "./buffer/hierarchical-buffer";
import { parseMemoryPolicy } from "./load-memory-policy";
import { renderThreadState } from "./working/render-thread-state";

/**
 * Compaction durability, end to end through the store
 *.
 *
 * The unit tests either side of this file prove the parts: the classifier
 * recognises a protected phrase, the buffer partitions, the service does CAS.
 * What is asserted here is the property those parts exist to produce — that a
 * thread which has been compacted many times has not quietly lost the things
 * Lexi would act on.
 *
 * These are written against the facade rather than the buffer because the
 * defect being guarded is a *wiring* defect: every one of these components
 * passed its own tests while `compactThread()` had no callers and the facade's
 * `buffer` was never supplied, so compaction could not run at all.
 */

const policy = {
  ...parseMemoryPolicy(readFileSync(resolve(__dirname, "../../../examples/config/memory-policy.yaml"), "utf-8")),
  enabled: true,
};

function createEpisodeStore(): MemoryEpisodeStore {
  const rows: Array<Record<string, unknown>> = [];
  return {
    memoryEpisode: {
      async create({ data }: { data: Record<string, unknown> }) {
        rows.push(data);
        return data;
      },
      async findMany() {
        return rows;
      },
    },
  } as unknown as MemoryEpisodeStore;
}

interface Harness {
  facade: MemoryFacade;
  threadState: ThreadStateService;
  store: TestThreadStateStore;
  summarise: ReturnType<typeof vi.fn>;
  logger: { warnings: string[]; logs: string[] } & MemoryLoggerPort;
}

function harness(summariser?: DigestSummariser): Harness {
  const store = createCasThreadStateStore();
  const threadState = new ThreadStateService(store);

  const warnings: string[] = [];
  const logs: string[] = [];
  const logger = {
    warnings,
    logs,
    log: (message: string) => void logs.push(message),
    warn: (message: string) => void warnings.push(message),
  };

  // Counts calls and labels the summary with them, so a test can see how many
  // separate compactions a thread went through.
  const summarise = vi.fn(async (digests: TurnDigest[]) => `compacted ${digests.length} earlier turns`);

  const facade = new MemoryFacade({
    policy,
    threadState,
    episodic: new EpisodicMemoryService(createEpisodeStore(), policy),
    buffer: new HierarchicalBuffer(policy, summariser ?? summarise),
    logger,
  });

  return { facade, threadState, store, summarise, logger };
}

/** Everything still visible to the model, protected fields included. */
function liveDigests(state: ThreadState): TurnDigest[] {
  return state.digests.filter((digest) => !digest.superseded);
}

describe("compaction durability — a long thread", () => {
  it("keeps every commitment and correction across a 100-turn thread with multiple compactions", async () => {
    const { facade, threadState, summarise } = harness();
    const threadKey = "C1:1.0";

    // The facts that must still be there at turn 100. Each is planted early
    // enough to be compacted away several times over.
    const planted = [
      { turn: 3, summary: "asked: ship it — did: approved the direct fix for #101" },
      { turn: 9, summary: "asked: can we close #101 — did: awaiting approval from the issue owner" },
      { turn: 17, summary: "asked: actually it's Android — did: correction on #101: the platform is Android, not iOS" },
      { turn: 24, summary: "asked: hold off — did: kept #101 open: still reproducing on 1.14" },
      { turn: 41, summary: "asked: is it out — did: PR #203 merged" },
      { turn: 58, summary: "asked: revert please — did: reverted the cache change" },
    ];
    const plantedAt = new Map(planted.map((entry) => [entry.turn, entry.summary]));

    for (let turn = 1; turn <= 100; turn += 1) {
      await facade.recordTurnState(threadKey, {
        turnId: `t${turn}`,
        actorUserId: "U0TEST09",
        summary:
          plantedAt.get(turn) ??
          `asked: what about case ${turn} — did: read the issue and reported the current status`,
      });

      // Exactly where the app calls it: after the turn's own write.
      await facade.compactThread(threadKey);
    }

    // The thread really was compacted repeatedly, not once.
    expect(summarise.mock.calls.length).toBeGreaterThan(2);

    const final = await threadState.load(threadKey);

    // Every planted fact is still recoverable from working memory — either
    // promoted into a protected field or still live as a verbatim digest.
    const recoverable = [
      ...final.decisions.map((decision) => decision.statement),
      ...final.openQuestions,
      ...liveDigests(final).map((digest) => digest.summary),
    ].join("\n");

    for (const { summary } of planted) {
      // Compare on the distinguishing clause rather than the whole line: a
      // promoted statement has had its `(U…)` attribution prefix consumed.
      const claim = summary.split(" — did: ")[1];
      expect(recoverable, `lost: ${claim}`).toContain(claim);
    }

    // And the ordinary chatter genuinely was compressed — otherwise this test
    // would pass by never having compacted anything.
    expect(final.digests.some((digest) => digest.superseded)).toBe(true);
    expect(liveDigests(final).length).toBeLessThan(100);
  });

  it("keeps the protected facts visible in the rendered block, not merely in the row", async () => {
    // Surviving in Postgres is not the same as reaching the model. The
    // renderer may shed digests to stay under budget, so a fact that survived
    // only as a live digest can still be invisible at the moment it matters.
    const { facade, threadState } = harness();
    const threadKey = "C1:1.0";

    await facade.recordTurnState(threadKey, {
      turnId: "t1",
      actorUserId: "U0TEST09",
      summary: "asked: ship it — did: approved the direct fix for #101",
    });
    await facade.recordTurnState(threadKey, {
      turnId: "t2",
      actorUserId: "U0TEST09",
      summary: "asked: can we close #101 — did: awaiting approval from the issue owner",
    });

    for (let turn = 3; turn <= 60; turn += 1) {
      await facade.recordTurnState(threadKey, {
        turnId: `t${turn}`,
        actorUserId: "U0TEST09",
        summary: `asked: case ${turn} — did: read the issue and reported a fairly verbose current status`,
      });
      await facade.compactThread(threadKey);
    }

    const rendered = renderThreadState(await threadState.load(threadKey), {
      maxTokens: policy.budgets.maxThreadStateTokens,
    });

    expect(rendered.text).toContain("approved the direct fix for #101");
    expect(rendered.text).toContain("awaiting approval from the issue owner");
  });
});

describe("compaction durability — a failing summariser", () => {
  it("leaves the source digests and the last good projection intact", async () => {
    const threadKey = "C1:1.0";
    const { facade, threadState, store } = harness(async () => {
      throw new Error("gateway 503");
    });

    for (let turn = 1; turn <= 40; turn += 1) {
      await facade.recordTurnState(threadKey, {
        turnId: `t${turn}`,
        summary: `asked: case ${turn} — did: read the issue and reported the current status`,
      });
    }

    const before = await threadState.load(threadKey);
    const writesBefore = store.writes;

    const compacted = await facade.compactThread(threadKey);

    expect(compacted).toBe(false);
    // Nothing was written at all: not a partial supersede, not a promotion.
    expect(store.writes).toBe(writesBefore);

    const after = await threadState.load(threadKey);
    expect(after.digests).toHaveLength(before.digests.length);
    expect(after.digests.every((digest) => !digest.superseded)).toBe(true);
    expect(after.decisions).toEqual(before.decisions);
    expect(after.openQuestions).toEqual(before.openQuestions);
  });

  it("preserves a projection produced by an earlier, working summariser", async () => {
    // The dangerous version of the failure: the thread already holds a good
    // summary digest, and a later broken call must not damage it.
    const threadKey = "C1:1.0";
    let broken = false;
    const { facade, threadState } = harness(async (digests) => {
      if (broken) throw new Error("gateway 503");
      return `compacted ${digests.length} earlier turns`;
    });

    for (let turn = 1; turn <= 40; turn += 1) {
      await facade.recordTurnState(threadKey, {
        turnId: `t${turn}`,
        summary: `asked: case ${turn} — did: read the issue and reported the current status`,
      });
      await facade.compactThread(threadKey);
    }

    const good = (await threadState.load(threadKey)).digests.filter((digest) =>
      isSummaryDigest(digest),
    );
    expect(good.length).toBeGreaterThan(0);

    broken = true;
    for (let turn = 41; turn <= 60; turn += 1) {
      await facade.recordTurnState(threadKey, {
        turnId: `t${turn}`,
        summary: `asked: case ${turn} — did: read the issue and reported the current status`,
      });
      await facade.compactThread(threadKey);
    }

    const still = (await threadState.load(threadKey)).digests.filter((digest) =>
      isSummaryDigest(digest),
    );
    expect(still.map((digest) => digest.summary)).toEqual(expect.arrayContaining(good.map((d) => d.summary)));
  });

  it("reports the failure rather than degrading silently", async () => {
    const { facade, logger, threadState } = harness();
    // A store that cannot be read at all — a missing table, a closed pool.
    vi.spyOn(threadState, "loadProjection").mockRejectedValue(new Error("relation \"thread_states\" does not exist"));

    expect(await facade.compactThread("C1:1.0")).toBe(false);
    expect(logger.warnings.join("\n")).toContain("thread_states");
  });
});

describe("compaction durability — what the summariser is never shown", () => {
  it("never passes authorization or pending-approval content to the model", async () => {
    const seen: string[] = [];
    const threadKey = "C1:1.0";
    const { facade } = harness(async (digests) => {
      for (const digest of digests) seen.push(digest.summary);
      return "compacted earlier turns";
    });

    await facade.recordTurnState(threadKey, {
      turnId: "auth",
      actorUserId: "U0TEST09",
      summary: "asked: ship it — did: approved the force-push to the release branch",
    });
    await facade.recordTurnState(threadKey, {
      turnId: "pending",
      actorUserId: "U0TEST09",
      summary: "asked: clean up — did: awaiting sign-off before we delete the branch",
    });

    for (let turn = 1; turn <= 60; turn += 1) {
      await facade.recordTurnState(threadKey, {
        turnId: `t${turn}`,
        summary: `asked: case ${turn} — did: read the issue and reported the current status`,
      });
      await facade.compactThread(threadKey);
    }

    // This is the guarantee: the lossy prose for these facts is never
    // produced, because the model is never given the input to produce it from.
    expect(seen.join("\n")).not.toContain("approved the force-push");
    expect(seen.join("\n")).not.toContain("awaiting sign-off");
    // And the summariser was doing real work meanwhile.
    expect(seen.length).toBeGreaterThan(0);
  });

  it("does not drop a decision or an open question that predates the thread", async () => {
    // Content already in the protected fields — the state a spec session or an
    // earlier deployment left behind — must survive compaction untouched.
    const { facade, threadState } = harness();
    const threadKey = "C1:1.0";

    await threadState.save({
      threadKey,
      entities: [],
      digests: [],
      decisions: [
        { id: "d1", createdAt: "2026-08-01T00:00:00.000Z", decidedBy: "U0TEST09", statement: "pinned: ship behind a flag" },
      ],
      openQuestions: ["pending: may we drop the legacy column?"],
      tokenCost: 0,
    });

    for (let turn = 1; turn <= 60; turn += 1) {
      await facade.recordTurnState(threadKey, {
        turnId: `t${turn}`,
        summary: `asked: case ${turn} — did: read the issue and reported the current status`,
      });
      await facade.compactThread(threadKey);
    }

    const final = await threadState.load(threadKey);
    expect(final.decisions.map((d) => d.statement)).toContain("pinned: ship behind a flag");
    expect(final.openQuestions).toContain("pending: may we drop the legacy column?");
  });

  it("compacts a run of purely protected digests without calling the model at all", async () => {
    // All-guarded is the degenerate case. It must still reduce the live
    // buffer, and it must cost nothing: paying for a summary of content the
    // summariser is not allowed to see would be the worst of both.
    const { facade, threadState, summarise } = harness();
    const threadKey = "C1:1.0";

    for (let turn = 1; turn <= policy.budgets.maxDigestsBeforeCompaction + 5; turn += 1) {
      await facade.recordTurnState(threadKey, {
        turnId: `t${turn}`,
        actorUserId: "U0TEST09",
        summary: `asked: is #${turn} out — did: PR #${turn} merged`,
      });
    }

    expect(await facade.compactThread(threadKey)).toBe(true);
    expect(summarise).not.toHaveBeenCalled();

    const final = await threadState.load(threadKey);
    expect(liveDigests(final).length).toBeLessThanOrEqual(policy.budgets.maxDigestsBeforeCompaction);
    // Nothing was destroyed — every merge is now a promoted decision.
    expect(final.decisions.length).toBeGreaterThan(0);
  });
});

describe("compaction durability — concurrency", () => {
  it("discards its own compaction rather than overwriting a concurrent turn", async () => {
    const threadKey = "C1:1.0";
    const { facade, threadState, store, logger } = harness();

    for (let turn = 1; turn <= 40; turn += 1) {
      await facade.recordTurnState(threadKey, {
        turnId: `t${turn}`,
        summary: `asked: case ${turn} — did: read the issue and reported the current status`,
      });
    }

    // Another turn commits while the summariser is running.
    const real = store.threadStateRecord.updateMany!;
    let fired = false;
    store.threadStateRecord.updateMany = async (args) => {
      if (!fired) {
        fired = true;
        const current = store.rows.get(args.where.threadKey)!.state as ThreadState;
        await store.threadStateRecord.upsert({
          where: { threadKey: args.where.threadKey },
          create: { id: "x", threadKey: args.where.threadKey, state: current, tokenCost: 1 },
          update: {
            state: {
              ...current,
              decisions: [
                ...current.decisions,
                { id: "theirs", createdAt: "2026-08-15T00:00:00.000Z", decidedBy: "U0TEST09", statement: "theirs" },
              ],
            },
            tokenCost: 1,
          },
        });
      }
      return real(args);
    };

    expect(await facade.compactThread(threadKey)).toBe(false);

    // The other writer's decision is intact; the compaction simply did not
    // land, and said so.
    const final = await threadState.load(threadKey);
    expect(final.decisions.map((d) => d.statement)).toContain("theirs");
    expect(final.digests.every((digest) => !digest.superseded)).toBe(true);
    expect(logger.warnings.join("\n")).toContain("discarded on a concurrent write");
  });

  it("does not retry a lost compaction, so a contended thread cannot loop on model calls", async () => {
    const threadKey = "C1:1.0";
    const { facade, summarise, store } = harness();

    for (let turn = 1; turn <= 40; turn += 1) {
      await facade.recordTurnState(threadKey, {
        turnId: `t${turn}`,
        summary: `asked: case ${turn} — did: read the issue and reported the current status`,
      });
    }

    summarise.mockClear();
    store.threadStateRecord.updateMany = async () => ({ count: 0 });

    await facade.compactThread(threadKey);

    // One summary produced, one attempt to store it, then stop.
    expect(summarise).toHaveBeenCalledTimes(1);
  });
});

describe("compaction durability — the turn-end writer", () => {
  it("reports a write it could not persist instead of returning success", async () => {
    const { facade, store } = harness();
    store.threadStateRecord.updateMany = async () => ({ count: 0 });
    store.threadStateRecord.create = async () => {
      throw new Error("Unique constraint failed on the fields: (`threadKey`)");
    };

    const result = await facade.recordTurnState("C1:1.0", { turnId: "t1", summary: "asked: anything" });

    expect(result).toMatchObject({ persisted: false, reason: "conflict" });
  });

  it("reports a store outage as an error, not as an empty thread", async () => {
    const { facade, threadState, logger } = harness();
    vi.spyOn(threadState, "recordTurnState").mockRejectedValue(new Error("connection pool destroyed"));

    const result = await facade.recordTurnState("C1:1.0", { turnId: "t1", summary: "asked: anything" });

    expect(result).toMatchObject({ persisted: false, reason: "error" });
    expect(logger.warnings.join("\n")).toContain("connection pool destroyed");
  });

  it("is a no-op that says so while memory is disabled", async () => {
    const { threadState, store } = harness();
    const dark = new MemoryFacade({
      policy: { ...policy, enabled: false },
      threadState,
      episodic: new EpisodicMemoryService(createEpisodeStore(), policy),
    });

    const result = await dark.recordTurnState("C1:1.0", { turnId: "t1", summary: "asked: anything" });

    expect(result).toMatchObject({ persisted: false, reason: "disabled" });
    // A dark feature must not accumulate writes it was never certified to make.
    expect(store.writes).toBe(0);
  });

  it("skips the fast path, which policy keeps free of memory writes", async () => {
    const { facade, store } = harness();

    const result = await facade.recordTurnFromOutcome(
      { threadKey: "C1:1.0", actorUserId: "U0TEST09", isDirectMessage: false, isFastPath: true, toolCalls: [] },
      { turnId: "t1", userText: "status?" },
    );

    expect(result).toMatchObject({ persisted: false, reason: "skipped" });
    expect(store.writes).toBe(0);
  });

  it("derives the digest, entities and decisions from a turn outcome", async () => {
    const { facade, threadState } = harness();

    await facade.recordTurnFromOutcome(
      {
        threadKey: "C1:1.0",
        actorUserId: "U0TEST09",
        isDirectMessage: false,
        decisions: [{ decidedBy: "U0TEST09", statement: "we ship behind a flag" }],
        toolCalls: [
          { name: "trigger_direct_fix", arguments: { issueNumber: 101 }, ok: true },
          // A failed call is an attempt, not a fact, and must not appear.
          { name: "create_pull_request", arguments: { pullNumber: 203 }, ok: false },
        ],
      },
      { turnId: "t1", userText: "please fix the deposit\nbutton" },
    );

    const state = await threadState.load("C1:1.0");

    expect(state.digests[0].summary).toContain("asked: please fix the deposit button");
    expect(state.digests[0].summary).toContain("dispatched a direct fix for #101");
    expect(state.digests[0].summary).not.toContain("203");
    expect(state.entities).toEqual([{ type: "issue", id: "101" }]);
    expect(state.decisions.map((d) => d.statement)).toContain("we ship behind a flag");
  });
});
