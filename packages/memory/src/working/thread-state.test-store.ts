import type { ThreadStateStore } from "./thread-state.service";

/**
 * An in-memory `thread_states` that models Prisma's compare-and-swap
 * semantics, for specs that need to exercise concurrency rather than assume
 * it.
 *
 * Not in a spec file because two spec files need it — the working-memory
 * concurrency tests and the facade's compaction-durability tests — and a
 * second copy would be free to drift from the first, which for a double whose
 * whole job is to be *exactly* as strict as Postgres is the one thing it must
 * not do.
 *
 * The three behaviours that matter, and why:
 *
 *  - `create` REJECTS an existing row. That is the `threadKey` unique
 *    constraint, and it is what makes two simultaneous first turns safe: one
 *    inserts, the other fails and retries into the update branch.
 *  - `updateMany` matches on `updatedAt` as well as `threadKey`, and returns
 *    `count: 0` when it does not match. That is the CAS.
 *  - every successful write ADVANCES `updatedAt`. Real Prisma does this via
 *    `@updatedAt`; the double uses a monotonic counter rather than the wall
 *    clock so that two writes in one test tick still produce distinct
 *    versions. Postgres via Prisma has millisecond granularity here, so a
 *    genuine sub-millisecond double write would not be detected — see
 *    `saveIfUnchanged`. Using the clock here would import that limitation into
 *    the tests and make them flaky about the thing they are asserting.
 */
export interface TestThreadStateStore extends ThreadStateStore {
  rows: Map<string, { state: unknown; tokenCost: number; updatedAt: Date }>;
  /** Writes attempted, successful or not. */
  writes: number;
  /** Writes rejected by the CAS predicate. */
  conflicts: number;
}

export function createCasThreadStateStore(): TestThreadStateStore {
  const rows = new Map<string, { state: unknown; tokenCost: number; updatedAt: Date }>();
  let tick = 0;
  const nextVersion = (): Date => new Date(Date.UTC(2026, 0, 1) + (tick += 1));

  const store: TestThreadStateStore = {
    rows,
    writes: 0,
    conflicts: 0,
    threadStateRecord: {
      async findUnique({ where }) {
        const row = rows.get(where.threadKey);
        if (!row) return null;
        return {
          threadKey: where.threadKey,
          // Structural clone, so a spec that mutates what it read cannot
          // accidentally mutate the stored row and hide a missing write.
          state: JSON.parse(JSON.stringify(row.state)),
          tokenCost: row.tokenCost,
          updatedAt: row.updatedAt,
        };
      },

      async create({ data }) {
        store.writes += 1;
        if (rows.has(data.threadKey)) {
          store.conflicts += 1;
          throw new Error("Unique constraint failed on the fields: (`threadKey`)");
        }
        rows.set(data.threadKey, { state: data.state, tokenCost: data.tokenCost, updatedAt: nextVersion() });
        return {};
      },

      async updateMany({ where, data }) {
        store.writes += 1;
        const row = rows.get(where.threadKey);
        if (!row || row.updatedAt.getTime() !== where.updatedAt.getTime()) {
          store.conflicts += 1;
          return { count: 0 };
        }
        rows.set(where.threadKey, { state: data.state, tokenCost: data.tokenCost, updatedAt: nextVersion() });
        return { count: 1 };
      },

      async upsert({ where, create, update }) {
        store.writes += 1;
        const existing = rows.get(where.threadKey);
        rows.set(where.threadKey, {
          state: existing ? update.state : create.state,
          tokenCost: existing ? update.tokenCost : create.tokenCost,
          updatedAt: nextVersion(),
        });
        return {};
      },
    },
  };

  return store;
}

/**
 * The same table WITHOUT the CAS pair — the shape the port shipped with, and
 * the shape every pre-existing double still has.
 *
 * Kept so a spec can assert what `saveIfUnchanged` does when it cannot do its
 * job: it must report `concurrencySafe: false` rather than quietly claim a
 * guarantee it did not provide.
 */
export function createLastWriteWinsThreadStateStore(): TestThreadStateStore {
  const store = createCasThreadStateStore();
  delete store.threadStateRecord.create;
  delete store.threadStateRecord.updateMany;
  return store;
}
