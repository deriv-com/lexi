import type { Prisma, PrismaClient } from "@lexi/database";
import type { MemoryEpisodeStore } from "../episodic/episodic-memory.service";
import type { ThreadStateStore } from "../working/thread-state.service";
import type { KnowledgeChunkQueryExecutor } from "../semantic/knowledge-chunk.indexer";

/**
 * Database-backed stores for the memory subsystem.
 *
 * The services in this package talk to narrow, structural store ports so they
 * can be tested without a database. These adapters are the production side of
 * those ports: each one takes the generated Prisma client (or anything with
 * the same delegates, such as `PrismaService`) and translates the port's
 * loosely typed arguments into the client's typed ones.
 *
 * They are deliberately thin. Every rule that matters — scope classification,
 * owner pinning on deletes, compare-and-swap on working memory — lives in the
 * services, and an adapter that re-implemented any of it would be a second
 * place for that rule to drift. What an adapter does own:
 *
 *  - **JSON normalisation.** `provenance` and the thread-state blob are JSON
 *    columns. The services hand over plain objects that may carry `undefined`
 *    or `Date` values, which Prisma either rejects or stores inconsistently;
 *    they are round-tripped through JSON here so what is stored is exactly
 *    what will be read back.
 *  - **Column pass-through, not column selection.** Writes forward every key
 *    the service supplies instead of copying a hand-picked list. A hand-picked
 *    list silently drops any column added later, and the bug only shows up as
 *    a value that was "written" and never comes back; forwarding everything
 *    makes an unknown column fail loudly in Prisma's validation instead.
 *  - **A last guard on destructive calls.** See `deleteMany`.
 */

/** The delegates each store needs, so callers and tests can pass a narrower client. */
export type MemoryEpisodePrisma = Pick<PrismaClient, "memoryEpisode">;
export type ThreadStatePrisma = Pick<PrismaClient, "threadStateRecord">;
export type KnowledgeChunkPrisma = Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">;

/** Everything the memory facade's stores read and write. `PrismaService` satisfies it. */
export type MemoryPrismaClient = MemoryEpisodePrisma & ThreadStatePrisma;

/**
 * Episodic memory over `memory_episodes`.
 *
 * `where` clauses arrive already built by `EpisodicMemoryService` — scope,
 * owner, kind and term filters — and are forwarded unchanged. They are written
 * in Prisma's filter vocabulary (`OR`, `in`, `contains` with
 * `mode: "insensitive"`, JSON `path`/`equals`) precisely so that no
 * translation is needed here.
 */
export function createPrismaMemoryEpisodeStore(prisma: MemoryEpisodePrisma): MemoryEpisodeStore {
  const episodes = prisma.memoryEpisode;

  return {
    memoryEpisode: {
      async create({ data }) {
        const row: Record<string, unknown> = { ...data };
        if ("provenance" in row) row.provenance = toJsonValue(row.provenance ?? {});
        return episodes.create({
          data: row as unknown as Prisma.MemoryEpisodeUncheckedCreateInput,
          select: { id: true },
        });
      },

      async findMany(args = {}) {
        const rows = await episodes.findMany({
          ...(args.where ? { where: args.where as Prisma.MemoryEpisodeWhereInput } : {}),
          ...(args.orderBy ? { orderBy: args.orderBy as Prisma.MemoryEpisodeOrderByWithRelationInput } : {}),
          ...(args.take !== undefined ? { take: args.take } : {}),
        });
        return rows as unknown as Array<Record<string, unknown>>;
      },

      async deleteMany({ where }) {
        // The service always pins scope and kind before it deletes, so an
        // empty filter can only mean a caller bypassed it or a refactor lost
        // the clause. Prisma would read `{}` as "every row", which for this
        // table means everyone's private memory; refuse rather than trust.
        assertNonEmptyFilter(where, "delete");
        const { count } = await episodes.deleteMany({ where: where as Prisma.MemoryEpisodeWhereInput });
        return { count };
      },

      async updateMany({ where, data }) {
        // Same reasoning as `deleteMany`: supersession is always scoped to an
        // id list, so an unscoped update is a bug, not a request.
        assertNonEmptyFilter(where, "update");
        const { count } = await episodes.updateMany({
          where: where as Prisma.MemoryEpisodeWhereInput,
          data: data as Prisma.MemoryEpisodeUncheckedUpdateManyInput,
        });
        return { count };
      },
    },
  };
}

/**
 * Working memory over `thread_states`, one row per thread.
 *
 * Provides the optional `create` / `updateMany` pair, which is what lets
 * `ThreadStateService` do compare-and-swap instead of last-write-wins:
 * `create` fails on the `threadKey` unique constraint when a concurrent first
 * turn got there first, and `updateMany` matches on the `updatedAt` the caller
 * read. Omitting either would quietly downgrade every write to unguarded.
 */
export function createPrismaThreadStateStore(prisma: ThreadStatePrisma): ThreadStateStore {
  const records = prisma.threadStateRecord;

  return {
    threadStateRecord: {
      findUnique({ where }) {
        return records.findUnique({
          where: { threadKey: where.threadKey },
          select: { threadKey: true, state: true, tokenCost: true, updatedAt: true },
        });
      },

      upsert({ where, create, update }) {
        return records.upsert({
          where: { threadKey: where.threadKey },
          create: { ...create, state: toJsonValue(create.state) },
          update: { ...update, state: toJsonValue(update.state) },
          select: { threadKey: true },
        });
      },

      create({ data }) {
        return records.create({
          data: { ...data, state: toJsonValue(data.state) },
          select: { threadKey: true },
        });
      },

      async updateMany({ where, data }) {
        const { count } = await records.updateMany({
          where: { threadKey: where.threadKey, updatedAt: where.updatedAt },
          data: { ...data, state: toJsonValue(data.state) },
        });
        return { count };
      },
    },
  };
}

/**
 * Raw-query access for semantic memory over `knowledge_chunks`.
 *
 * The `embedding` column is a pgvector type the typed client cannot read or
 * write, so the indexer issues parameterised raw SQL. This only narrows the
 * client to the two methods it uses.
 */
export function createPrismaKnowledgeChunkExecutor(prisma: KnowledgeChunkPrisma): KnowledgeChunkQueryExecutor {
  return {
    $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
      return prisma.$queryRawUnsafe<T>(query, ...values);
    },
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
      return prisma.$executeRawUnsafe(query, ...values);
    },
  };
}

/**
 * Converts a plain value to something a Prisma JSON column stores faithfully:
 * `undefined` members disappear and `Date`s become ISO strings, exactly as
 * they would on the way back out. A value that is not representable as JSON
 * (a cycle, a BigInt) throws here rather than inside the database driver.
 */
function toJsonValue(value: unknown): Prisma.InputJsonValue {
  const serialised = JSON.stringify(value ?? null);
  return JSON.parse(serialised) as Prisma.InputJsonValue;
}

function assertNonEmptyFilter(where: Record<string, unknown> | undefined, verb: string): void {
  if (!where || Object.keys(where).length === 0) {
    throw new Error(`Refusing to ${verb} memory episodes with an empty filter: it would match every row in the table.`);
  }
}
