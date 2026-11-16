import { describe, it, expect, beforeEach } from "vitest";
import type { ThreadState } from "@lexi/contracts";
import { ThreadStateService } from "./thread-state.service";
import {
  createCasThreadStateStore,
  createLastWriteWinsThreadStateStore,
  type TestThreadStateStore,
} from "./thread-state.test-store";

/**
 * Optimistic concurrency on working memory.
 *
 * `save()` is a blind read-modify-write. With one writer that is fine; with
 * two it is the same defect the structured-state design was built to fix — the
 * loser of the race silently reverts the winner's decisions, exactly as the
 * old single prose summary used to when `finalizeThread` overwrote it every
 * turn. Two writers is the real shape: a thread's own turns are serialised by
 * the agent's per-thread queue, but the scheduler posts into threads
 * humans are also talking in.
 *
 * The interleaving is forced rather than raced. A test that hoped two promises
 * would collide would pass on a machine where they did not, which for a
 * concurrency guard makes the test worse than none.
 */

function state(threadKey: string, overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    threadKey,
    entities: [],
    digests: [],
    openQuestions: [],
    decisions: [],
    tokenCost: 0,
    ...overrides,
  };
}

/**
 * Makes the NEXT compare-and-swap lose, by committing a competing write in the
 * window between the caller's read and its write.
 *
 * This is the whole race, reproduced deterministically: the victim has already
 * read a version that is about to go stale.
 */
function interposeWrite(store: TestThreadStateStore, competing: (current: ThreadState) => ThreadState): void {
  const real = store.threadStateRecord.updateMany!;
  let fired = false;

  store.threadStateRecord.updateMany = async (args) => {
    if (!fired) {
      fired = true;
      const row = store.rows.get(args.where.threadKey);
      const current = (row?.state as ThreadState | undefined) ?? state(args.where.threadKey);
      // A direct row write, standing in for the other process's committed
      // transaction. It advances `updatedAt`, which is what invalidates the
      // version the caller is holding.
      await store.threadStateRecord.upsert({
        where: { threadKey: args.where.threadKey },
        create: { id: "competing", threadKey: args.where.threadKey, state: competing(current), tokenCost: 1 },
        update: { state: competing(current), tokenCost: 1 },
      });
    }
    return real(args);
  };
}

describe("ThreadStateService — compare-and-swap", () => {
  let store: TestThreadStateStore;
  let service: ThreadStateService;

  beforeEach(() => {
    store = createCasThreadStateStore();
    service = new ThreadStateService(store);
  });

  it("reports a version for an existing row and null for a new thread", async () => {
    expect((await service.loadProjection("C1:1.0")).version).toBeNull();
    await service.save(state("C1:1.0"));
    expect((await service.loadProjection("C1:1.0")).version).not.toBeNull();
  });

  it("refuses a write whose version has moved on", async () => {
    await service.save(state("C1:1.0"));
    const stale = await service.loadProjection("C1:1.0");

    // Somebody else writes, advancing the row's version.
    await service.save(state("C1:1.0", { openQuestions: ["theirs"] }));

    const write = await service.saveIfUnchanged(state("C1:1.0", { openQuestions: ["mine"] }), stale.version);

    expect(write).toEqual({ ok: false, reason: "conflict" });
    // And the winner's content is still there — a rejected CAS writes nothing.
    expect((await service.load("C1:1.0")).openQuestions).toEqual(["theirs"]);
  });

  it("refuses a first-write race, so two simultaneous first turns cannot both insert", async () => {
    const first = await service.loadProjection("C1:1.0");
    const second = await service.loadProjection("C1:1.0");
    expect(first.version).toBeNull();
    expect(second.version).toBeNull();

    const winner = await service.saveIfUnchanged(state("C1:1.0", { openQuestions: ["first"] }), first.version);
    const loser = await service.saveIfUnchanged(state("C1:1.0", { openQuestions: ["second"] }), second.version);

    expect(winner.ok).toBe(true);
    expect(loser).toEqual({ ok: false, reason: "conflict" });
    expect((await service.load("C1:1.0")).openQuestions).toEqual(["first"]);
  });

  it("accepts a write whose version is current", async () => {
    await service.save(state("C1:1.0"));
    const fresh = await service.loadProjection("C1:1.0");

    const write = await service.saveIfUnchanged(state("C1:1.0", { openQuestions: ["mine"] }), fresh.version);

    expect(write.ok).toBe(true);
    expect((await service.load("C1:1.0")).openQuestions).toEqual(["mine"]);
  });

  it("says so when the store cannot enforce compare-and-swap", async () => {
    // The port's `create`/`updateMany` are optional, so a store predating them
    // still works — but a caller must not be able to read `ok: true` as a
    // guarantee that was never provided.
    const legacy = createLastWriteWinsThreadStateStore();
    const degraded = new ThreadStateService(legacy);

    const write = await degraded.saveIfUnchanged(state("C1:1.0"), "not-a-real-version");

    expect(write).toMatchObject({ ok: true, concurrencySafe: false });
    expect(legacy.rows.has("C1:1.0")).toBe(true);
  });
});

describe("ThreadStateService — mutate", () => {
  let store: TestThreadStateStore;
  let service: ThreadStateService;

  beforeEach(() => {
    store = createCasThreadStateStore();
    service = new ThreadStateService(store);
  });

  it("re-applies its change on top of the winner's, so both survive", async () => {
    await service.save(state("C1:1.0"));

    // The other process records a decision in the window between our read and
    // our write.
    interposeWrite(store, (current) => ({
      ...current,
      decisions: [
        ...current.decisions,
        { id: "theirs", createdAt: "2026-08-15T00:00:00.000Z", decidedBy: "U0TEST09", statement: "theirs" },
      ],
    }));

    const result = await service.mutate("C1:1.0", (current) => ({
      ...current,
      openQuestions: [...current.openQuestions, "mine"],
    }));

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);

    const final = await service.load("C1:1.0");
    // This is the whole point: neither writer lost anything.
    expect(final.decisions.map((d) => d.statement)).toEqual(["theirs"]);
    expect(final.openQuestions).toEqual(["mine"]);
  });

  it("gives up rather than looping forever on a permanently contended thread", async () => {
    await service.save(state("C1:1.0"));

    // Every CAS loses: `updateMany` always reports a conflict.
    store.threadStateRecord.updateMany = async () => {
      store.conflicts += 1;
      return { count: 0 };
    };

    const result = await service.mutate("C1:1.0", (current) => ({ ...current, openQuestions: ["mine"] }));

    expect(result.ok).toBe(false);
    // Bounded: a turn that already answered the user must not spin on writes.
    expect(result.attempts).toBe(3);
    expect(store.conflicts).toBe(3);
  });
});

describe("ThreadStateService — recordTurnState", () => {
  let store: TestThreadStateStore;
  let service: ThreadStateService;

  beforeEach(() => {
    store = createCasThreadStateStore();
    service = new ThreadStateService(store);
  });

  it("applies a whole turn in one write", async () => {
    const result = await service.recordTurnState("C1:1.0", {
      turnId: "t1",
      actorUserId: "U0TEST09",
      summary: "asked: what is broken — did: read the issue",
      entities: [{ type: "issue", id: "101" }],
      decisions: [{ decidedBy: "U0TEST09", statement: "we ship behind a flag" }],
      openQuestions: ["which platform?"],
    });

    expect(result.ok).toBe(true);
    // One CAS insert. A per-field writer would have made this four.
    expect(store.writes).toBe(1);

    const final = await service.load("C1:1.0");
    expect(final.digests).toHaveLength(1);
    expect(final.entities).toEqual([{ type: "issue", id: "101" }]);
    expect(final.decisions.map((d) => d.statement)).toEqual(["we ship behind a flag"]);
    expect(final.openQuestions).toEqual(["which platform?"]);
  });

  it("attributes the digest so a later promotion can name the actor", async () => {
    await service.recordTurnState("C1:1.0", {
      turnId: "t1",
      actorUserId: "U0TEST09",
      summary: "asked: status — did: read the issue",
    });

    expect((await service.load("C1:1.0")).digests[0].summary).toBe(
      "(U0TEST09) asked: status — did: read the issue",
    );
  });

  it("resolves a question and raises a new one in the same turn", async () => {
    await service.recordTurnState("C1:1.0", { turnId: "t1", openQuestions: ["which platform?", "which build?"] });
    await service.recordTurnState("C1:1.0", {
      turnId: "t2",
      resolvedQuestions: ["which platform?"],
      openQuestions: ["which account?"],
    });

    expect((await service.load("C1:1.0")).openQuestions).toEqual(["which build?", "which account?"]);
  });

  it("does not duplicate a question that is still open", async () => {
    await service.recordTurnState("C1:1.0", { turnId: "t1", openQuestions: ["which platform?"] });
    await service.recordTurnState("C1:1.0", { turnId: "t2", openQuestions: ["which platform?"] });

    expect((await service.load("C1:1.0")).openQuestions).toEqual(["which platform?"]);
  });

  it("promotes an authorization turn immediately, not only at compaction", async () => {
    // A thread with no summariser wired never compacts, so an approval that
    // waited for compaction to be rescued would eventually be shed by the
    // renderer's digest degradation and never come back.
    const result = await service.recordTurnState("C1:1.0", {
      turnId: "t1",
      actorUserId: "U0TEST09",
      summary: "asked: ship it — did: approved the direct fix for #101",
    });

    expect(result.promoted).toBe(1);
    const final = await service.load("C1:1.0");
    expect(final.decisions).toHaveLength(1);
    expect(final.decisions[0].decidedBy).toBe("U0TEST09");
    expect(final.decisions[0].statement).toContain("approved the direct fix for #101");
  });

  it("promotes a pending destructive decision to an open question", async () => {
    const result = await service.recordTurnState("C1:1.0", {
      turnId: "t1",
      actorUserId: "U0TEST09",
      summary: "asked: can we close it — did: awaiting approval from the issue owner",
    });

    expect(result.promoted).toBe(1);
    expect((await service.load("C1:1.0")).openQuestions).toHaveLength(1);
  });

  it("leaves a completion turn to compaction rather than promoting every dispatch", async () => {
    // The high-volume class. Promoting each at source would fill the
    // never-dropped fields with dispatch notices until real decisions render
    // as stubs; the digest is live and verbatim in the prompt meanwhile.
    const result = await service.recordTurnState("C1:1.0", {
      turnId: "t1",
      actorUserId: "U0TEST09",
      summary: "asked: fix it — did: dispatched a direct fix for #101",
    });

    expect(result.promoted).toBe(0);
    expect((await service.load("C1:1.0")).decisions).toEqual([]);
  });

  it("does not report a promotion it could not persist", async () => {
    store.threadStateRecord.create = async () => {
      throw new Error("Unique constraint failed on the fields: (`threadKey`)");
    };

    const result = await service.recordTurnState("C1:1.0", {
      turnId: "t1",
      actorUserId: "U0TEST09",
      summary: "asked: ship it — did: approved the direct fix for #101",
    });

    expect(result.ok).toBe(false);
    // A non-zero count here would be a claim that something was remembered.
    expect(result.promoted).toBe(0);
  });
});
