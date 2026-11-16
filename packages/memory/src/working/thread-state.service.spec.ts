import { describe, it, expect, beforeEach } from "vitest";
import type { ThreadState } from "@lexi/contracts";
import { ThreadStateService, type ThreadStateStore } from "./thread-state.service";

/**
 * Working-memory store.
 *
 * Replaces the single ~900-char prose summary that `finalizeThread` overwrote
 * every turn. The point of structured state is that a decision recorded on
 * turn 2 is still there on turn 40 — so most of these tests are about what
 * *survives* a subsequent write.
 */

/** In-memory stand-in for the `thread_states` table. */
function createStore(): ThreadStateStore & { rows: Map<string, { state: unknown; tokenCost: number }> } {
  const rows = new Map<string, { state: unknown; tokenCost: number }>();
  return {
    rows,
    threadStateRecord: {
      async findUnique({ where }) {
        const row = rows.get(where.threadKey);
        return row ? { threadKey: where.threadKey, state: row.state, tokenCost: row.tokenCost, updatedAt: new Date() } : null;
      },
      async upsert({ where, create, update }) {
        const existing = rows.get(where.threadKey);
        if (existing) {
          rows.set(where.threadKey, { state: update.state, tokenCost: update.tokenCost ?? 0 });
        } else {
          rows.set(where.threadKey, { state: create.state, tokenCost: create.tokenCost ?? 0 });
        }
        const row = rows.get(where.threadKey)!;
        return { threadKey: where.threadKey, state: row.state, tokenCost: row.tokenCost, updatedAt: new Date() };
      },
    },
  };
}

describe("ThreadStateService", () => {
  let store: ReturnType<typeof createStore>;
  let service: ThreadStateService;

  beforeEach(() => {
    store = createStore();
    service = new ThreadStateService(store);
  });

  it("returns an empty state for an unknown thread rather than null", () => {
    // Callers fold this into a prompt; a null here would mean a null check at
    // every call site and a crash at the one that forgot.
    return service.load("C1:1.0").then((state) => {
      expect(state.threadKey).toBe("C1:1.0");
      expect(state.digests).toEqual([]);
      expect(state.decisions).toEqual([]);
      expect(state.openQuestions).toEqual([]);
      expect(state.entities).toEqual([]);
    });
  });

  it("round-trips a saved state", async () => {
    await service.recordTurn("C1:1.0", {
      turnId: "t1",
      summary: "user asked about the deposit button",
      entities: [{ type: "issue", id: "101" }],
    });

    const state = await service.load("C1:1.0");
    expect(state.digests).toHaveLength(1);
    expect(state.digests[0].summary).toBe("user asked about the deposit button");
    expect(state.entities).toEqual([{ type: "issue", id: "101" }]);
  });

  it("keeps digests newest-first", async () => {
    await service.recordTurn("C1:1.0", { turnId: "t1", summary: "first turn" });
    await service.recordTurn("C1:1.0", { turnId: "t2", summary: "second turn" });

    const state = await service.load("C1:1.0");
    expect(state.digests.map((d) => d.turnId)).toEqual(["t2", "t1"]);
  });

  it("measures a token cost for every digest it records", async () => {
    await service.recordTurn("C1:1.0", { turnId: "t1", summary: "a summary of some length" });
    const state = await service.load("C1:1.0");
    expect(state.digests[0].tokenCost).toBeGreaterThan(0);
  });

  it("dedupes entities across turns", async () => {
    await service.recordTurn("C1:1.0", { turnId: "t1", entities: [{ type: "issue", id: "101" }] });
    await service.recordTurn("C1:1.0", {
      turnId: "t2",
      entities: [{ type: "issue", id: "101" }, { type: "pull_request", id: "42" }],
    });

    const state = await service.load("C1:1.0");
    expect(state.entities).toHaveLength(2);
  });

  it("enriches a deduped entity with a label learned on a later turn", async () => {
    await service.recordTurn("C1:1.0", { turnId: "t1", entities: [{ type: "issue", id: "101" }] });
    await service.recordTurn("C1:1.0", {
      turnId: "t2",
      entities: [{ type: "issue", id: "101", label: "deposit button dead", url: "https://x/101" }],
    });

    const state = await service.load("C1:1.0");
    expect(state.entities).toHaveLength(1);
    expect(state.entities[0].label).toBe("deposit button dead");
    expect(state.entities[0].url).toBe("https://x/101");
  });

  it("keeps decisions across later turns", async () => {
    await service.addDecision("C1:1.0", { decidedBy: "U1", statement: "we agreed to ship behind a flag" });
    await service.recordTurn("C1:1.0", { turnId: "t2", summary: "unrelated later chatter" });

    const state = await service.load("C1:1.0");
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0].statement).toBe("we agreed to ship behind a flag");
  });

  it("does not duplicate an identical open question", async () => {
    await service.addOpenQuestion("C1:1.0", "Which platform?");
    await service.addOpenQuestion("C1:1.0", "Which platform?");

    const state = await service.load("C1:1.0");
    expect(state.openQuestions).toEqual(["Which platform?"]);
  });

  it("resolves an open question without touching the others", async () => {
    await service.addOpenQuestion("C1:1.0", "Which platform?");
    await service.addOpenQuestion("C1:1.0", "Which app version?");
    await service.resolveOpenQuestion("C1:1.0", "Which platform?");

    const state = await service.load("C1:1.0");
    expect(state.openQuestions).toEqual(["Which app version?"]);
  });

  it("isolates threads from one another", async () => {
    await service.recordTurn("C1:1.0", { turnId: "t1", summary: "thread one content" });
    await service.recordTurn("C2:2.0", { turnId: "t2", summary: "thread two content" });

    const one = await service.load("C1:1.0");
    const two = await service.load("C2:2.0");
    expect(one.digests[0].summary).toBe("thread one content");
    expect(two.digests[0].summary).toBe("thread two content");
  });

  it("persists the measured token cost alongside the state", async () => {
    await service.recordTurn("C1:1.0", { turnId: "t1", summary: "some content worth measuring" });
    expect(store.rows.get("C1:1.0")!.tokenCost).toBeGreaterThan(0);
  });

  it("survives a corrupt state row by returning an empty state", async () => {
    // A malformed row must not take down every turn in the thread; memory is
    // advisory context, so degrading to "no memory" is correct.
    store.rows.set("C1:1.0", { state: "not an object", tokenCost: 0 });
    const state = await service.load("C1:1.0");
    expect(state.digests).toEqual([]);
    expect(state.threadKey).toBe("C1:1.0");
  });

  it("renders through the budget-aware renderer", async () => {
    await service.addDecision("C1:1.0", { decidedBy: "U1", statement: "we agreed on the cache fix" });
    for (let i = 0; i < 200; i += 1) {
      await service.recordTurn("C1:1.0", { turnId: `t${i}`, summary: `turn ${i} with a fair amount of detail` });
    }

    const rendered = await service.render("C1:1.0", { maxTokens: 400 });
    expect(rendered.tokenCost).toBeLessThanOrEqual(400);
    expect(rendered.text).toContain("we agreed on the cache fix");
  });

  it("accepts a full state replacement", async () => {
    const state: ThreadState = {
      threadKey: "C1:1.0",
      entities: [],
      digests: [],
      openQuestions: ["carried over"],
      decisions: [],
      tokenCost: 0,
    };
    await service.save(state);
    const loaded = await service.load("C1:1.0");
    expect(loaded.openQuestions).toEqual(["carried over"]);
  });
});
