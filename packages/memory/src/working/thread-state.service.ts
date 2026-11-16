import { randomUUID } from "node:crypto";
import type { ThreadState, TurnDigest, EntityRef, DecisionNote, TokenBudget } from "@lexi/contracts";
import { estimateTokens } from "../token-estimate";
import { renderThreadState, type RenderedThreadState } from "./render-thread-state";
import { classifyDigestProtection, promoteProtected, withAttribution } from "./protected-content";

/**
 * Working memory — the per-thread structured state.
 *
 * The thing this replaces is a single ~900-character prose summary that
 * `finalizeThread` overwrote on every turn, so a decision recorded early in a
 * thread was gone by the end of it. Here decisions and open questions are
 * separate fields that later writes never clobber, and only the digest buffer
 * is allowed to age out.
 *
 * Persisted as one JSON row per thread (`ThreadStateRecord`, unique on
 * `threadKey`), which keeps a turn to a single upsert.
 */

/**
 * Minimal Prisma port for `thread_states` — the same narrow-interface idiom
 * `UserPreferenceStore` uses in `@lexi/governance`, so the service is testable
 * without a database.
 *
 * `create` and `updateMany` are the compare-and-swap pair and are **optional**
 * on purpose. They were added after the port shipped, and a required member
 * would have broken every existing in-memory double at compile time for a
 * capability those doubles do not exercise. A store without them still works;
 * it just cannot detect a concurrent write, which `saveIfUnchanged` reports
 * rather than hides (`concurrencySafe: false`).
 */
export interface ThreadStateStore {
  threadStateRecord: {
    findUnique(args: { where: { threadKey: string } }): Promise<{
      threadKey: string;
      state: unknown;
      tokenCost: number;
      updatedAt: Date;
    } | null>;
    upsert(args: {
      where: { threadKey: string };
      create: { id: string; threadKey: string; state: unknown; tokenCost: number };
      update: { state: unknown; tokenCost: number };
    }): Promise<unknown>;
    /**
     * CAS insert. Must reject when the row already exists — the `threadKey`
     * unique constraint is what makes two simultaneous first turns safe.
     */
    create?(args: {
      data: { id: string; threadKey: string; state: unknown; tokenCost: number };
    }): Promise<unknown>;
    /**
     * CAS update. `where` carries the `updatedAt` the caller read, so
     * `count: 0` means "somebody else wrote first" and not "no such row".
     */
    updateMany?(args: {
      where: { threadKey: string; updatedAt: Date };
      data: { state: unknown; tokenCost: number };
    }): Promise<{ count: number }>;
  };
}

/**
 * A loaded state plus the token needed to write it back safely.
 *
 * `version` is the row's `updatedAt`, ISO-8601, and `null` when the row does
 * not exist yet. Deliberately not a field on `ThreadState`: that type is
 * frozen in `@lexi/contracts`, and a version is a property of the
 * *record*, not of the working memory it holds — putting it on the state would
 * invite callers to round-trip a stale one through a full `save`.
 *
 * `updatedAt` rather than a dedicated integer column because `ThreadStateRecord`
 * already has it, marked `@updatedAt`, so Prisma advances it on every write.
 * A version column would have needed a migration, and the deploy path does not
 * run migrations.
 */
export interface ThreadStateProjection {
  state: ThreadState;
  version: string | null;
}

/** What a compare-and-swap write did. */
export type ThreadStateWrite =
  | {
      ok: true;
      state: ThreadState;
      /**
       * The row's version AFTER the write, where it is knowable. A CAS update
       * goes through `updateMany`, which returns a count and not the row, so
       * this is `null` on that path — meaning "unknown, re-read if you need
       * it", never "the row has no version".
       */
      version: string | null;
      /**
       * False when the store cannot do CAS, so this write was last-write-wins.
       * Callers log it; nothing pretends the guarantee held.
       */
      concurrencySafe: boolean;
    }
  | { ok: false; reason: "conflict" };

/** One turn's worth of working-memory writes, applied together. */
export interface TurnStateInput {
  turnId: string;
  /** Slack user id. Attributes anything promoted out of this turn's digest. */
  actorUserId?: string;
  summary?: string;
  entities?: EntityRef[];
  /** Agreements reached on this turn. Never dropped by budget degradation. */
  decisions?: DecisionInput[];
  /** Asks this turn raised and did not answer. */
  openQuestions?: string[];
  /** Asks this turn answered. Removed from `openQuestions`. */
  resolvedQuestions?: string[];
  createdAt?: string;
}

/** How many times a CAS write is retried before the turn gives up. */
const MAX_CAS_ATTEMPTS = 3;

/** What a caller supplies for one turn; ids and costs are filled in here. */
export interface TurnDigestInput {
  turnId: string;
  summary?: string;
  entities?: EntityRef[];
  createdAt?: string;
}

/** A decision as stated by a caller; `id` and `createdAt` are assigned here. */
export interface DecisionInput {
  decidedBy: string;
  statement: string;
  createdAt?: string;
}

function emptyState(threadKey: string): ThreadState {
  return { threadKey, entities: [], digests: [], openQuestions: [], decisions: [], tokenCost: 0 };
}

/** Entity identity is (type, id) — the same issue seen twice is one entity. */
function entityKey(entity: EntityRef): string {
  return `${entity.type}:${entity.id}`;
}

export class ThreadStateService {
  constructor(private readonly store: ThreadStateStore) {}

  /**
   * Loads a thread's working memory. Unknown threads and unreadable rows both
   * yield an empty state rather than null or a throw: memory is advisory
   * context, so its absence must degrade the answer, never break the
   * turn.
   */
  async load(threadKey: string): Promise<ThreadState> {
    const record = await this.store.threadStateRecord.findUnique({ where: { threadKey } });
    if (!record) return emptyState(threadKey);
    return this.toState(threadKey, record.state);
  }

  /**
   * Loads a thread's working memory together with the CAS token needed to
   * write it back. Same degradation as `load`: an unreadable row yields an
   * empty state, but with the row's real `version` so a blind overwrite is
   * still detected.
   */
  async loadProjection(threadKey: string): Promise<ThreadStateProjection> {
    const record = await this.store.threadStateRecord.findUnique({ where: { threadKey } });
    if (!record) return { state: emptyState(threadKey), version: null };
    return {
      state: this.toState(threadKey, record.state),
      version: record.updatedAt instanceof Date ? record.updatedAt.toISOString() : null,
    };
  }

  /**
   * Writes a state only if the row still carries `expectedVersion`.
   *
   * Two turns in one thread are not hypothetical: the agent runs a per-thread
   * queue precisely because concurrent messages in a thread were being
   * dropped, and the scheduler can post into a thread a human is also talking
   * in. `save` is read-modify-write with no guard, so the loser of that race
   * silently reverts the winner's decisions — the exact regression the
   * structured-state design exists to prevent (see the class comment on the
   * ~900-character prose summary).
   *
   * Returns `{ ok: false, reason: "conflict" }` rather than throwing, because
   * a conflict is an expected outcome to retry, not an error to report.
   *
   * **Known granularity limit.** The version is `updatedAt`, which Prisma sets
   * client-side as `new Date()` — millisecond resolution. Two writes to one
   * thread landing in the *same millisecond* would both see the same version
   * and both succeed. That is not reachable by the writers this guards: the
   * per-thread queue serialises a thread's own turns, and the
   * other writer is the scheduler, which is seconds away at best. Closing it
   * properly needs a monotonic revision column, which needs a migration, and
   * the deploy path does not run migrations — so it is documented here rather
   * than papered over with a guarantee this cannot make.
   */
  async saveIfUnchanged(state: ThreadState, expectedVersion: string | null): Promise<ThreadStateWrite> {
    const tokenCost = this.measure(state);
    const persisted: ThreadState = { ...state, tokenCost };
    const record = this.store.threadStateRecord;

    // No CAS pair on this store. Fall back to the pre-existing last-write-wins
    // upsert and SAY SO, so a caller cannot read `ok: true` as a guarantee it
    // did not get.
    if (!record.create || !record.updateMany) {
      await this.save(persisted);
      return { ok: true, state: persisted, version: null, concurrencySafe: false };
    }

    if (expectedVersion === null) {
      // First write for this thread. The unique constraint on `threadKey` is
      // the CAS: whichever of two simultaneous first turns loses gets a
      // constraint violation and retries into the update branch.
      try {
        await record.create({
          data: { id: randomUUID(), threadKey: state.threadKey, state: persisted, tokenCost },
        });
      } catch {
        return { ok: false, reason: "conflict" };
      }
      return { ok: true, state: persisted, version: null, concurrencySafe: true };
    }

    const { count } = await record.updateMany({
      where: { threadKey: state.threadKey, updatedAt: new Date(expectedVersion) },
      data: { state: persisted, tokenCost },
    });

    // `count: 0` is unambiguous here. The row existed when it was read — that
    // is where `expectedVersion` came from — so the only way the predicate
    // fails is that `updatedAt` moved, i.e. another writer got there first.
    if (count === 0) return { ok: false, reason: "conflict" };

    return { ok: true, state: persisted, version: null, concurrencySafe: true };
  }

  /**
   * Read-modify-write under optimistic concurrency, retried on conflict.
   *
   * The mutator is re-run against freshly loaded state on every attempt, which
   * is what makes a retry correct rather than merely repeated: the loser of a
   * race re-applies its own change on top of the winner's, so both survive.
   *
   * Gives up after `MAX_CAS_ATTEMPTS` and reports it. Retrying forever would
   * turn a hot thread into an unbounded write loop inside a turn that has
   * already answered the user.
   */
  async mutate(
    threadKey: string,
    mutator: (current: ThreadState) => ThreadState,
  ): Promise<{ ok: boolean; state: ThreadState; attempts: number; concurrencySafe: boolean }> {
    let last: ThreadState = emptyState(threadKey);

    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
      const { state, version } = await this.loadProjection(threadKey);
      const next = mutator(state);
      last = next;

      const write = await this.saveIfUnchanged(next, version);
      if (write.ok) {
        return { ok: true, state: write.state, attempts: attempt, concurrencySafe: write.concurrencySafe };
      }
    }

    return { ok: false, state: last, attempts: MAX_CAS_ATTEMPTS, concurrencySafe: true };
  }

  /**
   * The turn-end writer. One conflict-safe read-modify-write per turn
   * covering everything working memory learned: the digest, the entities, any
   * decisions reached, and the open questions raised or answered.
   *
   * Before this existed, `ThreadStateService` had writers that nothing called
   * — the only external memory write in the whole application was
   * `rememberTurn`, which populates *episodic* memory. Structured thread state
   * was therefore always empty at read time, so `threadState()` and the
   * working-memory section of every recalled pack were advertised and
   * permanently blank.
   *
   * A turn's digest is stored with an attribution prefix so that if compaction
   * later has to promote it out of the lossy path, the promoted decision can
   * still name who made the call. Protected content is *also* promoted here,
   * at source: waiting for a compaction to rescue an approval means the
   * approval is only safe on threads long enough to compact.
   */
  async recordTurnState(
    threadKey: string,
    input: TurnStateInput,
  ): Promise<{ ok: boolean; state: ThreadState; attempts: number; concurrencySafe: boolean; promoted: number }> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const summary = withAttribution(input.actorUserId, input.summary ?? "");
    let promoted = 0;

    const result = await this.mutate(threadKey, (current) => {
      const digest: TurnDigest = {
        turnId: input.turnId,
        createdAt,
        summary,
        entities: input.entities ?? [],
        tokenCost: estimateTokens(summary),
        superseded: false,
      };

      const decisions: DecisionNote[] = [
        ...current.decisions,
        ...(input.decisions ?? []).map((decision) => ({
          id: randomUUID(),
          createdAt: decision.createdAt ?? createdAt,
          decidedBy: decision.decidedBy,
          statement: decision.statement,
        })),
      ];

      // Resolve first, then add: a turn that answers one question and asks
      // another must not have the new one removed by the old one's cleanup,
      // and re-raising a still-open question must stay idempotent.
      const resolved = new Set(input.resolvedQuestions ?? []);
      const openQuestions = [...current.openQuestions.filter((question) => !resolved.has(question))];
      for (const question of input.openQuestions ?? []) {
        if (!openQuestions.includes(question)) openQuestions.push(question);
      }

      const withTurn: ThreadState = {
        ...current,
        digests: [digest, ...current.digests],
        entities: mergeEntities(current.entities, input.entities ?? []),
        decisions,
        openQuestions,
      };

      // Promote at source — but only the two classes whose invisibility can
      // make Lexi *act* wrongly.
      //
      // Compaction already rescues every protected class when a digest leaves
      // the live set, so while a digest is live its verbatim text is in the
      // prompt and promoting it would just duplicate it. The exception is the
      // window where compaction never runs: with no summariser wired (or after
      // a conflict), digests are never folded, and `renderThreadState` sheds
      // the oldest ones to stay under budget. An authorization decision or an
      // unresolved commitment that falls out of that window is not merely
      // forgotten — the model then reasons as though permission was never
      // sought, or as though nobody is waiting on an answer.
      //
      // `completion` facts are left to compaction on purpose. They are by far
      // the highest-volume class (every dispatch, every PR), they are
      // recoverable by looking the artefact up, and promoting each one at
      // source would fill the never-dropped fields with them until genuine
      // decisions render as stubs.
      //
      // `promoteProtected` dedupes on the statement, so an explicit
      // `decisions` entry above covering the same text wins and this adds
      // nothing.
      const reason = classifyDigestProtection(digest);
      if (reason !== "authorization" && reason !== "pending_destructive") return withTurn;

      const promotion = promoteProtected(withTurn, [{ digest, reason }]);
      promoted = promotion.promoted;
      return promotion.state;
    });

    return { ...result, promoted: result.ok ? promoted : 0 };
  }

  /** Replaces a thread's state wholesale, re-measuring its cost. */
  async save(state: ThreadState): Promise<ThreadState> {
    const tokenCost = this.measure(state);
    const persisted: ThreadState = { ...state, tokenCost };

    await this.store.threadStateRecord.upsert({
      where: { threadKey: state.threadKey },
      create: { id: randomUUID(), threadKey: state.threadKey, state: persisted, tokenCost },
      update: { state: persisted, tokenCost },
    });

    return persisted;
  }

  /**
   * Appends one turn's digest, newest-first, and folds its entities into the
   * thread's deduped entity set.
   */
  async recordTurn(threadKey: string, input: TurnDigestInput): Promise<ThreadState> {
    const state = await this.load(threadKey);
    const summary = input.summary ?? "";

    const digest: TurnDigest = {
      turnId: input.turnId,
      createdAt: input.createdAt ?? new Date().toISOString(),
      summary,
      entities: input.entities ?? [],
      tokenCost: estimateTokens(summary),
      superseded: false,
    };

    return this.save({
      ...state,
      digests: [digest, ...state.digests],
      entities: mergeEntities(state.entities, input.entities ?? []),
    });
  }

  /** Records an agreement. Never dropped by budget degradation. */
  async addDecision(threadKey: string, input: DecisionInput): Promise<ThreadState> {
    const state = await this.load(threadKey);
    const decision: DecisionNote = {
      id: randomUUID(),
      createdAt: input.createdAt ?? new Date().toISOString(),
      decidedBy: input.decidedBy,
      statement: input.statement,
    };
    return this.save({ ...state, decisions: [...state.decisions, decision] });
  }

  /** Records an unanswered ask. Idempotent — re-asking does not duplicate. */
  async addOpenQuestion(threadKey: string, question: string): Promise<ThreadState> {
    const state = await this.load(threadKey);
    if (state.openQuestions.includes(question)) return state;
    return this.save({ ...state, openQuestions: [...state.openQuestions, question] });
  }

  /** Clears one answered question, leaving the rest untouched. */
  async resolveOpenQuestion(threadKey: string, question: string): Promise<ThreadState> {
    const state = await this.load(threadKey);
    return this.save({ ...state, openQuestions: state.openQuestions.filter((q) => q !== question) });
  }

  /** Loads and renders under budget in one step — the common caller path. */
  async render(threadKey: string, budget: TokenBudget): Promise<RenderedThreadState> {
    return renderThreadState(await this.load(threadKey), budget);
  }

  /**
   * Cost of the state as stored. Rendering re-measures against its own budget;
   * this figure is what `/lexi diag` reports and what compaction triggers on.
   */
  private measure(state: ThreadState): number {
    const digestCost = state.digests
      .filter((digest) => !digest.superseded)
      .reduce((sum, digest) => sum + digest.tokenCost, 0);
    const decisionCost = state.decisions.reduce((sum, d) => sum + estimateTokens(d.statement), 0);
    const questionCost = state.openQuestions.reduce((sum, q) => sum + estimateTokens(q), 0);
    const entityCost = state.entities.reduce((sum, e) => sum + estimateTokens(`${e.type}${e.id}${e.label ?? ""}`), 0);
    return digestCost + decisionCost + questionCost + entityCost;
  }

  /** Defensive read of a JSON column that other processes also write. */
  private toState(threadKey: string, raw: unknown): ThreadState {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyState(threadKey);
    const candidate = raw as Partial<ThreadState>;
    return {
      threadKey,
      entities: Array.isArray(candidate.entities) ? candidate.entities : [],
      digests: Array.isArray(candidate.digests) ? candidate.digests : [],
      openQuestions: Array.isArray(candidate.openQuestions) ? candidate.openQuestions : [],
      decisions: Array.isArray(candidate.decisions) ? candidate.decisions : [],
      ...(candidate.coverage ? { coverage: candidate.coverage } : {}),
      tokenCost: typeof candidate.tokenCost === "number" ? candidate.tokenCost : 0,
    };
  }
}

/**
 * Union of two entity lists on `(type, id)`, with later facts filling gaps in
 * earlier ones — a thread often names an issue by number first and learns its
 * title a turn later, and the label is what makes the prompt readable.
 */
export function mergeEntities(existing: EntityRef[], incoming: EntityRef[]): EntityRef[] {
  const merged = new Map<string, EntityRef>();
  for (const entity of existing) merged.set(entityKey(entity), entity);

  for (const entity of incoming) {
    const key = entityKey(entity);
    const prior = merged.get(key);
    merged.set(key, prior ? { ...prior, ...stripUndefined(entity) } : entity);
  }

  return [...merged.values()];
}

/** Keeps a later mention from erasing a label an earlier one supplied. */
function stripUndefined(entity: EntityRef): Partial<EntityRef> {
  return Object.fromEntries(Object.entries(entity).filter(([, value]) => value !== undefined)) as Partial<EntityRef>;
}
