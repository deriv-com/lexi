import { randomUUID } from "node:crypto";
import type { MemoryPrismaClient } from "./prisma-memory-stores";

/**
 * An in-memory stand-in for the two Prisma delegates the memory facade uses,
 * `memoryEpisode` and `threadStateRecord`.
 *
 * For tests and for local runs with no database. It interprets the filters
 * the episodic service actually builds — `OR` / `AND` / `NOT`, equality and
 * `null`, `in`, case-insensitive `contains`, and JSON `path` + `equals` — and
 * throws on any operator it does not model. Throwing is the point: a double
 * that ignored an unknown filter would match every row, and a scope bug would
 * pass its tests by returning someone else's memory.
 *
 * The behaviours that make it a faithful stand-in rather than a mock:
 *
 *  - writes reject unknown columns, as Prisma's validation does, so a store
 *    adapter that sends a misspelt field fails here too;
 *  - JSON columns are stored as a copy, so a caller mutating its object after
 *    the write cannot change what was stored;
 *  - `threadStateRecord.create` rejects an existing `threadKey` (the unique
 *    constraint) and every successful write advances `updatedAt`, which is
 *    what compare-and-swap relies on.
 *
 * Every call is recorded in `calls` with its arguments as received, so specs
 * can assert what a store adapter actually sent.
 */

export interface InMemoryMemoryPrisma {
  /** Pass this wherever a `MemoryPrismaClient` (or `PrismaService`) is expected. */
  client: MemoryPrismaClient;
  episodes: Array<Record<string, unknown>>;
  threads: Map<string, Record<string, unknown>>;
  calls: Array<{ model: "memoryEpisode" | "threadStateRecord"; method: string; args: unknown }>;
}

const EPISODE_COLUMNS = new Set([
  "id",
  "scope",
  "subjectUserId",
  "kind",
  "threadKey",
  "entityType",
  "entityId",
  "content",
  "importance",
  "confidence",
  "provenance",
  "expiresAt",
  "createdAt",
  "supersededById",
  "supersededAt",
  "validFrom",
  "validUntil",
]);

const THREAD_COLUMNS = new Set(["id", "threadKey", "state", "tokenCost", "updatedAt"]);

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

export function createInMemoryMemoryPrisma(): InMemoryMemoryPrisma {
  const episodes: Row[] = [];
  const threads = new Map<string, Row>();
  const calls: InMemoryMemoryPrisma["calls"] = [];

  // A monotonic clock for `updatedAt`, so two writes in one test tick still
  // produce distinct versions and the CAS predicate can tell them apart.
  let tick = 0;
  const nextVersion = (): Date => new Date(Date.UTC(2026, 0, 1) + (tick += 1));

  const memoryEpisode = {
    async create(args: { data: Row; select?: Record<string, boolean> }) {
      calls.push({ model: "memoryEpisode", method: "create", args });
      assertColumns(args.data, EPISODE_COLUMNS, "MemoryEpisode");
      const row: Row = {
        id: randomUUID(),
        subjectUserId: null,
        threadKey: null,
        entityType: null,
        entityId: null,
        importance: 0.5,
        confidence: 1,
        expiresAt: null,
        createdAt: new Date(),
        supersededById: null,
        supersededAt: null,
        validFrom: null,
        validUntil: null,
        ...args.data,
        provenance: copyJson(args.data.provenance ?? {}),
      };
      for (const required of ["scope", "kind", "content"]) {
        if (row[required] === undefined) throw new Error(`MemoryEpisode.${required} is required`);
      }
      episodes.push(row);
      return project(row, args.select);
    },

    async findMany(args: { where?: Where; orderBy?: Record<string, "asc" | "desc">; take?: number } = {}) {
      calls.push({ model: "memoryEpisode", method: "findMany", args });
      let rows = episodes.filter((row) => matches(row, args.where ?? {}));
      if (args.orderBy) rows = sortRows(rows, args.orderBy);
      if (args.take !== undefined) rows = rows.slice(0, args.take);
      return rows.map((row) => ({ ...row, provenance: copyJson(row.provenance) }));
    },

    async deleteMany(args: { where?: Where }) {
      calls.push({ model: "memoryEpisode", method: "deleteMany", args });
      let count = 0;
      for (let i = episodes.length - 1; i >= 0; i -= 1) {
        if (matches(episodes[i], args.where ?? {})) {
          episodes.splice(i, 1);
          count += 1;
        }
      }
      return { count };
    },

    async updateMany(args: { where?: Where; data: Row }) {
      calls.push({ model: "memoryEpisode", method: "updateMany", args });
      assertColumns(args.data, EPISODE_COLUMNS, "MemoryEpisode");
      let count = 0;
      for (const row of episodes) {
        if (matches(row, args.where ?? {})) {
          Object.assign(row, args.data);
          count += 1;
        }
      }
      return { count };
    },
  };

  const threadStateRecord = {
    async findUnique(args: { where: { threadKey: string }; select?: Record<string, boolean> }) {
      calls.push({ model: "threadStateRecord", method: "findUnique", args });
      const row = threads.get(args.where.threadKey);
      return row ? project({ ...row, state: copyJson(row.state) }, args.select) : null;
    },

    async upsert(args: { where: { threadKey: string }; create: Row; update: Row; select?: Record<string, boolean> }) {
      calls.push({ model: "threadStateRecord", method: "upsert", args });
      const existing = threads.get(args.where.threadKey);
      if (existing) {
        assertColumns(args.update, THREAD_COLUMNS, "ThreadStateRecord");
        Object.assign(existing, args.update, { state: copyJson(args.update.state), updatedAt: nextVersion() });
        return project(existing, args.select);
      }
      return insertThread(args.create, args.select);
    },

    async create(args: { data: Row; select?: Record<string, boolean> }) {
      calls.push({ model: "threadStateRecord", method: "create", args });
      const threadKey = String(args.data.threadKey);
      if (threads.has(threadKey)) {
        // What Prisma raises for a unique-constraint violation.
        throw Object.assign(new Error(`Unique constraint failed on the fields: (\`threadKey\`)`), { code: "P2002" });
      }
      return insertThread(args.data, args.select);
    },

    async updateMany(args: { where: { threadKey: string; updatedAt?: Date }; data: Row }) {
      calls.push({ model: "threadStateRecord", method: "updateMany", args });
      assertColumns(args.data, THREAD_COLUMNS, "ThreadStateRecord");
      const row = threads.get(args.where.threadKey);
      if (!row || !matches(row, args.where)) return { count: 0 };
      Object.assign(row, args.data, { state: copyJson(args.data.state), updatedAt: nextVersion() });
      return { count: 1 };
    },
  };

  function insertThread(data: Row, select?: Record<string, boolean>): Row {
    assertColumns(data, THREAD_COLUMNS, "ThreadStateRecord");
    const row: Row = {
      id: randomUUID(),
      tokenCost: 0,
      ...data,
      state: copyJson(data.state),
      updatedAt: nextVersion(),
    };
    threads.set(String(row.threadKey), row);
    return project(row, select);
  }

  const client = { memoryEpisode, threadStateRecord } as unknown as MemoryPrismaClient;
  return { client, episodes, threads, calls };
}

function assertColumns(data: Row, columns: Set<string>, model: string): void {
  for (const key of Object.keys(data)) {
    if (!columns.has(key)) throw new Error(`Unknown argument \`${key}\` for ${model}.`);
  }
}

function project(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [key, on] of Object.entries(select)) if (on) out[key] = row[key];
  return out;
}

function copyJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sortRows(rows: Row[], orderBy: Record<string, "asc" | "desc">): Row[] {
  const [[field, direction]] = Object.entries(orderBy);
  const sign = direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => sign * (comparable(a[field]) - comparable(b[field])));
}

function comparable(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return value == null ? Number.NEGATIVE_INFINITY : Number(new Date(String(value)));
}

/** Prisma's filter semantics, for the subset the memory services emit. */
function matches(row: Row, where: Where): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      if (!(condition as Where[]).some((sub) => matches(row, sub))) return false;
    } else if (key === "AND") {
      const subs = Array.isArray(condition) ? (condition as Where[]) : [condition as Where];
      if (!subs.every((sub) => matches(row, sub))) return false;
    } else if (key === "NOT") {
      if (matches(row, condition as Where)) return false;
    } else if (!fieldMatches(row[key], condition)) {
      return false;
    }
  }
  return true;
}

function fieldMatches(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
  if (typeof condition !== "object") return value === condition;

  // A JSON-path filter is one condition spread over two keys; `equals` here
  // compares the value at the path, not the whole column.
  if ("path" in (condition as Record<string, unknown>)) {
    const { path, equals, ...rest } = condition as { path: string[]; equals?: unknown };
    if (Object.keys(rest).length > 0) {
      throw new Error(`In-memory Prisma client does not model JSON-path filters with ${Object.keys(rest).join(", ")}.`);
    }
    let cursor: unknown = value;
    for (const segment of path) cursor = cursor && typeof cursor === "object" ? (cursor as Row)[segment] : undefined;
    return cursor === equals;
  }

  for (const [op, operand] of Object.entries(condition as Record<string, unknown>)) {
    switch (op) {
      case "equals":
        if (!fieldMatches(value, operand)) return false;
        break;
      case "in":
        if (!(operand as unknown[]).some((candidate) => fieldMatches(value, candidate))) return false;
        break;
      case "not":
        if (fieldMatches(value, operand)) return false;
        break;
      case "contains": {
        if (typeof value !== "string") return false;
        const insensitive = (condition as { mode?: string }).mode === "insensitive";
        const haystack = insensitive ? value.toLowerCase() : value;
        const needle = insensitive ? String(operand).toLowerCase() : String(operand);
        if (!haystack.includes(needle)) return false;
        break;
      }
      case "mode":
        break;
      case "gte":
      case "gt":
      case "lte":
      case "lt": {
        const left = comparable(value);
        const right = comparable(operand);
        if (op === "gte" && !(left >= right)) return false;
        if (op === "gt" && !(left > right)) return false;
        if (op === "lte" && !(left <= right)) return false;
        if (op === "lt" && !(left < right)) return false;
        break;
      }
      default:
        throw new Error(`In-memory Prisma client does not model the \`${op}\` filter operator.`);
    }
  }
  return true;
}
