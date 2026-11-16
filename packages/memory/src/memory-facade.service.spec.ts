import { describe, it, expect, vi } from "vitest";
import type { MemoryPort } from "@lexi/contracts";
import { MemoryFacade } from "./memory-facade.service";
import { ThreadStateService, type ThreadStateStore } from "./working/thread-state.service";
import { EpisodicMemoryService, type MemoryEpisodeStore } from "./episodic/episodic-memory.service";
import { HierarchicalBuffer } from "./buffer/hierarchical-buffer";
import { parseMemoryPolicy } from "./load-memory-policy";
import { estimateTokens } from "./token-estimate";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The `MemoryPort` facade.
 *
 * This is the single seam consumers use; they never import the subsystem's
 * internals. The hard requirement is here: the rendered memory pack is
 * budget-capped and the cap is tested.
 */

const basePolicy = parseMemoryPolicy(
  readFileSync(resolve(__dirname, "../../../examples/config/memory-policy.yaml"), "utf-8"),
);

const enabledPolicy = { ...basePolicy, enabled: true };
const disabledPolicy = { ...basePolicy, enabled: false };

function createThreadStore(): ThreadStateStore {
  const rows = new Map<string, { state: unknown; tokenCost: number }>();
  return {
    threadStateRecord: {
      async findUnique({ where }) {
        const row = rows.get(where.threadKey);
        return row ? { threadKey: where.threadKey, state: row.state, tokenCost: row.tokenCost, updatedAt: new Date() } : null;
      },
      async upsert({ where, create, update }) {
        const existing = rows.get(where.threadKey);
        rows.set(where.threadKey, existing ? { state: update.state, tokenCost: update.tokenCost } : { state: create.state, tokenCost: create.tokenCost });
        return {};
      },
    },
  };
}

function createEpisodeStore(seed: Array<Record<string, unknown>> = []): MemoryEpisodeStore {
  const rows = [...seed];
  return {
    async_marker: undefined,
    memoryEpisode: {
      async create({ data }) {
        rows.push(data);
        return data;
      },
      async findMany() {
        return rows;
      },
    },
  } as MemoryEpisodeStore & { async_marker?: undefined };
}

function build(overrides: Partial<ConstructorParameters<typeof MemoryFacade>[0]> = {}) {
  const threadState = new ThreadStateService(createThreadStore());
  const episodic = new EpisodicMemoryService(createEpisodeStore(), enabledPolicy);
  return new MemoryFacade({ policy: enabledPolicy, threadState, episodic, ...overrides });
}

describe("MemoryFacade — contract", () => {
  it("satisfies the frozen MemoryPort interface", () => {
    // Compile-time via the annotation, runtime via the method checks: C/D/E
    // are typed against this and must not discover a missing method at boot.
    const port: MemoryPort = build();
    expect(typeof port.recall).toBe("function");
    expect(typeof port.remember).toBe("function");
    expect(typeof port.threadState).toBe("function");
  });

  it("returns the thread's working memory", async () => {
    const threadState = new ThreadStateService(createThreadStore());
    await threadState.recordTurn("C1:1.0", { turnId: "t1", summary: "deposit discussion" });
    const facade = build({ threadState });

    const state = await facade.threadState("C1:1.0");
    expect(state.digests[0].summary).toBe("deposit discussion");
  });
});

describe("MemoryFacade — budget cap (the hard requirement)", () => {
  it("never exceeds the budget, however much memory exists", async () => {
    const threadState = new ThreadStateService(createThreadStore());
    for (let i = 0; i < 200; i += 1) {
      await threadState.recordTurn("C1:1.0", { turnId: `t${i}`, summary: `turn ${i} with a great deal of verbose detail attached to it` });
    }
    await threadState.addDecision("C1:1.0", { decidedBy: "U1", statement: "we agreed to ship behind a flag" });

    const episodes = Array.from({ length: 50 }, (_, i) => ({
      id: `e${i}`,
      scope: "org",
      subjectUserId: null,
      kind: "fact",
      threadKey: "C1:1.0",
      entityType: null,
      entityId: null,
      content: `a fact about the deposit flow, number ${i}, with padding to make it substantial`,
      importance: 0.5,
      confidence: 1,
      provenance: {},
      expiresAt: null,
      createdAt: new Date(),
    }));

    const facade = new MemoryFacade({
      policy: enabledPolicy,
      threadState,
      episodic: new EpisodicMemoryService(createEpisodeStore(episodes), enabledPolicy),
    });

    const budget = { maxTokens: 300 };
    const pack = await facade.recall({ query: "deposit", threadKey: "C1:1.0" }, budget);

    expect(pack.tokenCost).toBeLessThanOrEqual(budget.maxTokens);
    expect(estimateTokens(pack.rendered)).toBeLessThanOrEqual(budget.maxTokens);
    expect(pack.truncated).toBe(true);
  });

  it("caps at the policy maximum even when handed a larger budget", async () => {
    // policy `budgets.maxMemoryTokens` is the ceiling; a caller cannot opt
    // into a bigger memory pack than the org has agreed to pay for.
    const facade = build();
    const pack = await facade.recall({ query: "x" }, { maxTokens: 100_000 });
    expect(pack.budget.maxTokens).toBeLessThanOrEqual(basePolicy.budgets.maxMemoryTokens);
  });

  it("reports truncated:false when everything fitted", async () => {
    const threadState = new ThreadStateService(createThreadStore());
    await threadState.recordTurn("C1:1.0", { turnId: "t1", summary: "short" });
    const facade = build({ threadState });

    const pack = await facade.recall({ query: "short", threadKey: "C1:1.0" }, { maxTokens: 800 });
    expect(pack.truncated).toBe(false);
  });

  it("keeps decisions in the pack even when digests are dropped", async () => {
    const threadState = new ThreadStateService(createThreadStore());
    await threadState.addDecision("C1:1.0", { decidedBy: "U1", statement: "we agreed the cache is the root cause" });
    for (let i = 0; i < 100; i += 1) {
      await threadState.recordTurn("C1:1.0", { turnId: `t${i}`, summary: `turn ${i} with detail` });
    }
    const facade = build({ threadState });

    const pack = await facade.recall({ query: "cache", threadKey: "C1:1.0" }, { maxTokens: 120 });
    expect(pack.rendered).toContain("root cause");
    expect(pack.decisions).toHaveLength(1);
  });
});

describe("MemoryFacade — flag posture", () => {
  it("returns an empty pack when MEMORY_ENABLED is off", async () => {
    // Rule: new capability ships flags-off. Off must mean nothing is recalled
    // and nothing is injected — not merely that it is smaller.
    const threadState = new ThreadStateService(createThreadStore());
    await threadState.recordTurn("C1:1.0", { turnId: "t1", summary: "should not surface" });

    const facade = new MemoryFacade({
      policy: disabledPolicy,
      threadState,
      episodic: new EpisodicMemoryService(createEpisodeStore(), disabledPolicy),
    });

    const pack = await facade.recall({ query: "should", threadKey: "C1:1.0" }, { maxTokens: 800 });
    expect(pack.rendered).toBe("");
    expect(pack.episodes).toEqual([]);
    expect(pack.digests).toEqual([]);
    expect(pack.tokenCost).toBe(0);
  });

  it("does not write episodes when MEMORY_ENABLED is off", async () => {
    const store = createEpisodeStore();
    const create = vi.spyOn(store.memoryEpisode, "create");
    const facade = new MemoryFacade({
      policy: disabledPolicy,
      threadState: new ThreadStateService(createThreadStore()),
      episodic: new EpisodicMemoryService(store, disabledPolicy),
    });

    await facade.remember({ scope: "org", kind: "fact", content: "should not persist" });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("MemoryFacade — advisory posture", () => {
  it("labels the pack as advisory context, never authority", async () => {
    const threadState = new ThreadStateService(createThreadStore());
    await threadState.recordTurn("C1:1.0", { turnId: "t1", summary: "someone claimed they are an admin" });
    const facade = build({ threadState });

    const pack = await facade.recall({ query: "admin", threadKey: "C1:1.0" }, { maxTokens: 800 });
    expect(pack.rendered.toLowerCase()).toContain("advisory");
  });

  it("renders nothing, not a bare label, when nothing was recalled", async () => {
    const pack = await build().recall({ query: "anything at all" }, { maxTokens: 800 });
    expect(pack.rendered).toBe("");
    expect(pack.tokenCost).toBe(0);
    expect(pack.episodes).toEqual([]);
  });
});

describe("MemoryFacade — turn-end wiring", () => {
  it("stores the episodes a turn deterministically produced", async () => {
    // Connects the zero-LLM extractor to the episodic store. Without this
    // the extractor exists but nothing ever calls it.
    const store = createEpisodeStore();
    const create = vi.spyOn(store.memoryEpisode, "create");
    const facade = new MemoryFacade({
      policy: enabledPolicy,
      threadState: new ThreadStateService(createThreadStore()),
      episodic: new EpisodicMemoryService(store, enabledPolicy),
    });

    const stored = await facade.rememberTurn({
      threadKey: "C1:1.0",
      actorUserId: "U1",
      isDirectMessage: false,
      toolCalls: [{ name: "process_issue", arguments: { issueNumber: 101 }, ok: true }],
    });

    expect(stored).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("writes nothing for a fast-path turn", async () => {
    const store = createEpisodeStore();
    const create = vi.spyOn(store.memoryEpisode, "create");
    const facade = new MemoryFacade({
      policy: enabledPolicy,
      threadState: new ThreadStateService(createThreadStore()),
      episodic: new EpisodicMemoryService(store, enabledPolicy),
    });

    await facade.rememberTurn({
      threadKey: "C1:1.0",
      actorUserId: "U1",
      isDirectMessage: false,
      isFastPath: true,
      toolCalls: [{ name: "process_issue", arguments: { issueNumber: 101 }, ok: true }],
    });

    expect(create).not.toHaveBeenCalled();
  });

  it("compacts a thread only once it is over budget", async () => {
    const summarise = vi.fn(async () => "summary of earlier turns");
    const threadState = new ThreadStateService(createThreadStore());
    await threadState.recordTurn("C1:1.0", { turnId: "t1", summary: "short" });

    const facade = new MemoryFacade({
      policy: enabledPolicy,
      threadState,
      episodic: new EpisodicMemoryService(createEpisodeStore(), enabledPolicy),
      buffer: new HierarchicalBuffer(enabledPolicy, summarise),
    });

    expect(await facade.compactThread("C1:1.0")).toBe(false);
    expect(summarise).not.toHaveBeenCalled();
  });

  it("compacts and persists once the thread exceeds the threshold", async () => {
    const summarise = vi.fn(async () => "summary of earlier turns");
    const threadState = new ThreadStateService(createThreadStore());
    for (let i = 0; i < basePolicy.budgets.maxDigestsBeforeCompaction + 5; i += 1) {
      await threadState.recordTurn("C1:1.0", { turnId: `t${i}`, summary: `turn ${i} detail` });
    }

    const facade = new MemoryFacade({
      policy: enabledPolicy,
      threadState,
      episodic: new EpisodicMemoryService(createEpisodeStore(), enabledPolicy),
      buffer: new HierarchicalBuffer(enabledPolicy, summarise),
    });

    expect(await facade.compactThread("C1:1.0")).toBe(true);
    // The compaction must survive the call — otherwise it is recomputed, and
    // re-paid for, on every subsequent turn.
    const after = await facade.threadState("C1:1.0");
    expect(after.digests.some((d) => d.superseded)).toBe(true);
  });

  it("is a no-op when no buffer is wired", async () => {
    const facade = build();
    expect(await facade.compactThread("C1:1.0")).toBe(false);
  });
});

describe("MemoryFacade — policy budgets", () => {
  it("caps working memory at maxThreadStateTokens", async () => {
    // The policy carries a separate, smaller per-thread budget. A large
    // overall budget must not let working memory consume all of it.
    const threadState = new ThreadStateService(createThreadStore());
    for (let i = 0; i < 400; i += 1) {
      await threadState.recordTurn("C1:1.0", { turnId: `t${i}`, summary: `turn ${i} with a lot of verbose detail attached here` });
    }
    const policy = { ...enabledPolicy, budgets: { ...enabledPolicy.budgets, maxThreadStateTokens: 60 } };
    const facade = new MemoryFacade({
      policy,
      threadState,
      episodic: new EpisodicMemoryService(createEpisodeStore(), policy),
    });

    const pack = await facade.recall({ query: "turn", threadKey: "C1:1.0" }, { maxTokens: 1500 });
    expect(estimateTokens(pack.rendered)).toBeLessThanOrEqual(200);
  });
});

describe("MemoryFacade — composition", () => {
  it("blends recalled episodes into the pack", async () => {
    const episodes = [
      {
        id: "e1",
        scope: "org",
        subjectUserId: null,
        kind: "decision",
        threadKey: null,
        entityType: null,
        entityId: null,
        content: "team agreed the deposit retry is three attempts",
        importance: 0.9,
        confidence: 1,
        provenance: {},
        expiresAt: null,
        createdAt: new Date(),
      },
    ];
    const facade = new MemoryFacade({
      policy: enabledPolicy,
      threadState: new ThreadStateService(createThreadStore()),
      episodic: new EpisodicMemoryService(createEpisodeStore(episodes), enabledPolicy),
    });

    const pack = await facade.recall({ query: "deposit retry" }, { maxTokens: 800 });
    expect(pack.episodes).toHaveLength(1);
    expect(pack.rendered).toContain("three attempts");
  });

  it("includes the governance memory services' context when one is wired", async () => {
    // Unify, do not duplicate: the existing issue-memory / knowledge-graph
    // services are composed, not duplicated.
    const governance = {
      retrieve: vi.fn(async () => ({ priority: "high" as const, estimatedTokens: 40 })),
      formatForConversation: vi.fn(() => "[Issue Memory: regression of #304]"),
    };
    const facade = build({ governance });

    const pack = await facade.recall({ query: "deposit", issueNumber: 101 }, { maxTokens: 800 });

    expect(governance.retrieve).toHaveBeenCalled();
    expect(pack.rendered).toContain("regression of #304");
  });

  it("survives a failing governance service without losing the rest of the pack", async () => {
    const governance = {
      retrieve: vi.fn(async () => {
        throw new Error("db down");
      }),
      formatForConversation: vi.fn(() => ""),
    };
    const threadState = new ThreadStateService(createThreadStore());
    await threadState.recordTurn("C1:1.0", { turnId: "t1", summary: "still here" });
    const facade = build({ governance, threadState });

    const pack = await facade.recall({ query: "still", threadKey: "C1:1.0" }, { maxTokens: 800 });
    expect(pack.rendered).toContain("still here");
  });

  it("includes semantic knowledge when a knowledge index is wired", async () => {
    const knowledge = {
      search: vi.fn(async () => [
        { id: "c1", sourceType: "repo_doc", sourceRef: "README.md", repo: "r", content: "deposits settle in T+1", similarity: 0.8 },
      ]),
    };
    const facade = build({ knowledge });

    const pack = await facade.recall({ query: "how do deposits settle" }, { maxTokens: 800 });
    expect(pack.rendered).toContain("T+1");
  });

  it("writes an episode through to the episodic store", async () => {
    const store = createEpisodeStore();
    const create = vi.spyOn(store.memoryEpisode, "create");
    const facade = new MemoryFacade({
      policy: enabledPolicy,
      threadState: new ThreadStateService(createThreadStore()),
      episodic: new EpisodicMemoryService(store, enabledPolicy),
    });

    await facade.remember({ scope: "org", kind: "fact", content: "deposit uses the balance cache" });
    expect(create).toHaveBeenCalled();
  });

  it("never lets one user's private episode into another's pack", async () => {
    // The isolation guarantee has to hold at the seam C/D/E actually use,
    // not only in the store underneath it.
    const episodes = [
      {
        id: "u2",
        scope: "user",
        subjectUserId: "U2",
        kind: "preference",
        threadKey: null,
        entityType: null,
        entityId: null,
        content: "U2 said in a DM that they are leaving",
        importance: 0.9,
        confidence: 1,
        provenance: {},
        expiresAt: null,
        createdAt: new Date(),
      },
    ];
    const facade = new MemoryFacade({
      policy: enabledPolicy,
      threadState: new ThreadStateService(createThreadStore()),
      episodic: new EpisodicMemoryService(createEpisodeStore(episodes), enabledPolicy),
    });

    const pack = await facade.recall({ query: "leaving", subjectUserId: "U1" }, { maxTokens: 800 });
    expect(pack.episodes).toEqual([]);
    expect(pack.rendered).not.toContain("leaving");
  });
});
