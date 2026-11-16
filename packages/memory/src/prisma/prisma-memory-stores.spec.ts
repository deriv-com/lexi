import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@lexi/database";
import { memoryPolicySchema } from "../memory-policy.schema";
import { EpisodicMemoryService } from "../episodic/episodic-memory.service";
import { ThreadStateService } from "../working/thread-state.service";
import {
  createPrismaKnowledgeChunkExecutor,
  createPrismaMemoryEpisodeStore,
  createPrismaThreadStateStore,
  type KnowledgeChunkPrisma,
} from "./prisma-memory-stores";
import { createInMemoryMemoryPrisma } from "./in-memory-prisma-client";

/**
 * The store adapters against a fake Prisma client. No database is involved:
 * `createInMemoryMemoryPrisma` interprets the filters the services send, and
 * records every call so these specs can assert what reached the client.
 */

const policy = memoryPolicySchema.parse({
  version: "test",
  enabled: true,
  visibility: { orgKinds: ["decision", "fact"], userKinds: ["preference"] },
});

function lastCall(fake: ReturnType<typeof createInMemoryMemoryPrisma>, method: string) {
  const call = [...fake.calls].reverse().find((entry) => entry.method === method);
  if (!call) throw new Error(`no ${method} call recorded`);
  return call.args as Record<string, unknown>;
}

describe("Prisma memory episode store", () => {
  it("forwards every column the service writes, so none is silently dropped", async () => {
    const fake = createInMemoryMemoryPrisma();
    const store = createPrismaMemoryEpisodeStore(fake.client);

    const data = {
      id: "ep-1",
      scope: "org",
      subjectUserId: null,
      kind: "fact",
      threadKey: "C0TEST01:1700000000.000100",
      entityType: "issue",
      entityId: "42",
      content: "the checkout flow retries twice",
      importance: 0.7,
      confidence: 0.9,
      provenance: { tool: "remember_team_convention", actor: "U0TEST01" },
      expiresAt: null,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
      supersededById: null,
      supersededAt: null,
      validFrom: new Date("2026-01-02T00:00:00.000Z"),
      validUntil: null,
    };
    await store.memoryEpisode.create({ data });

    const sent = lastCall(fake, "create").data as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(Object.keys(data).sort());
    expect(fake.episodes).toHaveLength(1);
    expect(fake.episodes[0]).toMatchObject({ id: "ep-1", content: data.content, entityId: "42" });
  });

  it("normalises provenance to plain JSON before it reaches the client", async () => {
    const fake = createInMemoryMemoryPrisma();
    const store = createPrismaMemoryEpisodeStore(fake.client);

    await store.memoryEpisode.create({
      data: {
        scope: "org",
        kind: "fact",
        content: "x",
        provenance: { actor: "U0TEST01", at: new Date("2026-03-04T05:06:07.000Z"), dropped: undefined },
      },
    });

    const sent = lastCall(fake, "create").data as { provenance: unknown };
    expect(sent.provenance).toEqual({ actor: "U0TEST01", at: "2026-03-04T05:06:07.000Z" });
  });

  it("asks only for the id back on create", async () => {
    const fake = createInMemoryMemoryPrisma();
    await createPrismaMemoryEpisodeStore(fake.client).memoryEpisode.create({ data: { scope: "org", kind: "fact", content: "x" } });
    expect(lastCall(fake, "create").select).toEqual({ id: true });
  });

  it("passes where, orderBy and take through unchanged", async () => {
    const fake = createInMemoryMemoryPrisma();
    const store = createPrismaMemoryEpisodeStore(fake.client);
    const where = { OR: [{ scope: "org" }], kind: { in: ["decision"] } };

    await store.memoryEpisode.findMany({ where, orderBy: { createdAt: "desc" }, take: 7 });

    expect(lastCall(fake, "findMany")).toEqual({ where, orderBy: { createdAt: "desc" }, take: 7 });
  });

  it("omits absent arguments instead of sending undefined", async () => {
    const fake = createInMemoryMemoryPrisma();
    await createPrismaMemoryEpisodeStore(fake.client).memoryEpisode.findMany();
    expect(lastCall(fake, "findMany")).toEqual({});
  });

  it("refuses a delete or update with an empty filter, which would match every row", async () => {
    const fake = createInMemoryMemoryPrisma();
    const store = createPrismaMemoryEpisodeStore(fake.client);
    await store.memoryEpisode.create({ data: { scope: "user", subjectUserId: "U0TEST01", kind: "preference", content: "short answers" } });

    await expect(store.memoryEpisode.deleteMany({ where: {} })).rejects.toThrow(/empty filter/);
    await expect(store.memoryEpisode.updateMany!({ where: {}, data: { supersededById: "x" } })).rejects.toThrow(/empty filter/);

    expect(fake.episodes).toHaveLength(1);
    expect(fake.calls.some((call) => call.method === "deleteMany" || call.method === "updateMany")).toBe(false);
  });

  it("returns the client's count from a scoped delete", async () => {
    const fake = createInMemoryMemoryPrisma();
    const store = createPrismaMemoryEpisodeStore(fake.client);
    await store.memoryEpisode.create({ data: { scope: "user", subjectUserId: "U0TEST01", kind: "preference", content: "a" } });
    await store.memoryEpisode.create({ data: { scope: "user", subjectUserId: "U0TEST02", kind: "preference", content: "b" } });

    const { count } = await store.memoryEpisode.deleteMany({ where: { scope: "user", subjectUserId: "U0TEST01", kind: "preference" } });

    expect(count).toBe(1);
    expect(fake.episodes.map((row) => row.subjectUserId)).toEqual(["U0TEST02"]);
  });

  it("lets the episodic service supersede through updateMany", async () => {
    const fake = createInMemoryMemoryPrisma();
    const episodic = new EpisodicMemoryService(createPrismaMemoryEpisodeStore(fake.client), policy);

    const old = await episodic.remember({ scope: "org", kind: "decision", content: "release branches are cut on Mondays" });
    const replacement = await episodic.remember({
      scope: "org",
      kind: "decision",
      content: "release branches are cut on Tuesdays",
      supersedes: [old],
    });

    const oldRow = fake.episodes.find((row) => row.id === old)!;
    expect(oldRow.supersededById).toBe(replacement);
    expect(oldRow.validUntil).toBeInstanceOf(Date);

    const recalled = await episodic.recall({ query: "when are release branches cut" });
    expect(recalled[0].id).toBe(replacement);
    expect(recalled.find((episode) => episode.id === old)?.temporalStatus).toBe("historical");
  });
});

describe("Prisma thread-state store", () => {
  it("selects only the four columns the service reads", async () => {
    const fake = createInMemoryMemoryPrisma();
    await createPrismaThreadStateStore(fake.client).threadStateRecord.findUnique({ where: { threadKey: "t1" } });
    expect(lastCall(fake, "findUnique")).toEqual({
      where: { threadKey: "t1" },
      select: { threadKey: true, state: true, tokenCost: true, updatedAt: true },
    });
  });

  it("offers the create/updateMany pair, so working memory writes are compare-and-swap", async () => {
    const fake = createInMemoryMemoryPrisma();
    const service = new ThreadStateService(createPrismaThreadStateStore(fake.client));

    const first = await service.recordTurnState("C0TEST01:1.1", { turnId: "t1", summary: "asked: status — did: read the board" });
    const second = await service.recordTurnState("C0TEST01:1.1", { turnId: "t2", summary: "asked: again — did: read it again" });

    expect(first).toMatchObject({ ok: true, concurrencySafe: true });
    expect(second).toMatchObject({ ok: true, concurrencySafe: true });
    expect(fake.calls.filter((call) => call.method === "upsert")).toHaveLength(0);

    const state = await service.load("C0TEST01:1.1");
    expect(state.digests.map((digest) => digest.turnId).sort()).toEqual(["t1", "t2"]);
  });

  it("detects a concurrent write through the updatedAt predicate", async () => {
    const fake = createInMemoryMemoryPrisma();
    const service = new ThreadStateService(createPrismaThreadStateStore(fake.client));
    await service.recordTurnState("thread", { turnId: "t1", summary: "first" });

    const stale = await service.loadProjection("thread");
    await service.recordTurnState("thread", { turnId: "t2", summary: "someone else" });

    const write = await service.saveIfUnchanged(stale.state, stale.version);
    expect(write).toEqual({ ok: false, reason: "conflict" });
  });

  it("stores the state blob as plain JSON", async () => {
    const fake = createInMemoryMemoryPrisma();
    const store = createPrismaThreadStateStore(fake.client);

    await store.threadStateRecord.create!({
      data: { id: "r1", threadKey: "thread", state: { threadKey: "thread", note: undefined, digests: [] }, tokenCost: 3 },
    });

    const sent = lastCall(fake, "create").data as { state: unknown };
    expect(sent.state).toEqual({ threadKey: "thread", digests: [] });
    expect(lastCall(fake, "create").select).toEqual({ threadKey: true });
  });

  it("falls back to upsert through the same JSON normalisation", async () => {
    const fake = createInMemoryMemoryPrisma();
    const service = new ThreadStateService(createPrismaThreadStateStore(fake.client));

    await service.save({ threadKey: "thread", entities: [], digests: [], openQuestions: ["which build?"], decisions: [], tokenCost: 0 });

    const sent = lastCall(fake, "upsert") as { create: { state: { openQuestions: string[] } } };
    expect(sent.create.state.openQuestions).toEqual(["which build?"]);
    expect((await service.load("thread")).openQuestions).toEqual(["which build?"]);
  });
});

describe("Prisma knowledge-chunk executor", () => {
  it("forwards raw queries and their parameters", async () => {
    const queryRaw = vi.fn(async () => [{ id: "k1" }]);
    const executeRaw = vi.fn(async () => 2);
    const prisma = { $queryRawUnsafe: queryRaw, $executeRawUnsafe: executeRaw } as unknown as KnowledgeChunkPrisma;
    const executor = createPrismaKnowledgeChunkExecutor(prisma);

    await expect(executor.$queryRawUnsafe("SELECT 1 WHERE repo = $1", "acme/web")).resolves.toEqual([{ id: "k1" }]);
    await expect(executor.$executeRawUnsafe("DELETE FROM x WHERE id = $1", "k1")).resolves.toBe(2);

    expect(queryRaw).toHaveBeenCalledWith("SELECT 1 WHERE repo = $1", "acme/web");
    expect(executeRaw).toHaveBeenCalledWith("DELETE FROM x WHERE id = $1", "k1");
  });

  it("accepts the generated client type", () => {
    // Compile-time check: the factory takes the real client, not only fakes.
    const accept = (client: PrismaClient) => createPrismaKnowledgeChunkExecutor(client);
    expect(typeof accept).toBe("function");
  });
});
