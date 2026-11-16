import { randomUUID } from "node:crypto";
import type {
  MemoryEpisodeInput,
  MemoryEpisodeRecord,
  MemoryEpisodeKind,
  MemoryScope,
  MemoryTemporalStatus,
  RecallQuery,
} from "@lexi/contracts";
import type { MemoryPolicy } from "../memory-policy.schema";

/**
 * Episodic memory — discrete events worth recalling later.
 *
 * The visibility rule is the reason most of this file exists. Work facts
 * (issue/PR/spec/decision/assignment/escalation) are org-shared; anything
 * derived from a DM or stated as a personal preference belongs to one person
 * and is recallable only by them. Getting that wrong is a disclosure bug, not
 * a quality bug, so scope is enforced three times: classified on write,
 * constrained in the query, and filtered again over whatever comes back.
 *
 * Two other properties are load-bearing and easy to break:
 *
 *  - **Relevance is decided over the whole authorized corpus, not the newest
 *    slice of it.** See `CANDIDATE_PASSES` below for the window bug this
 *    replaced.
 *  - **A thread is a unit of relevance, never of permission.** Episodes from
 *    other threads are eligible and ranked lower; they are not hidden. Only
 *    `scope`/`subjectUserId` decide who may see what.
 */

/** Minimal Prisma port for `memory_episodes`. */
export interface MemoryEpisodeStore {
  memoryEpisode: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    findMany(args?: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
      take?: number;
    }): Promise<Array<Record<string, unknown>>>;
    /**
     * Only ever reached through `forgetOwnPreferences`, which is the sole
     * caller and pins `scope` and `subjectUserId` itself. Retention pruning
     * is time-based and elsewhere; this exists so a person can revoke a
     * preference they stated, which 90-day expiry is not a substitute for.
     */
    deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
    /**
     * Marks episodes superseded. Optional on the port and not on the real
     * client: `PrismaService` has it, but this interface is structural and
     * several test doubles predate supersession, so requiring it would break
     * callers that never supersede anything.
     *
     * Optionality is a compile-time convenience only — it is never a silent
     * no-op. `supersede` throws when the wired store cannot perform the
     * update, because "recorded the replacement and quietly left the old fact
     * reading as current" is worse than an error.
     */
    updateMany?(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
}

/**
 * Candidate retrieval, in two bounded passes.
 *
 * This used to be one pass: the newest 200 eligible rows by `createdAt desc`,
 * ranked in code afterwards. Ranking blends relevance, recency and importance
 * and SQL cannot order by that blend, so a candidate window was fetched
 * and scored locally — which is sound, except that the window was chosen by
 * recency alone. Once a fact fell past row 200 it could not be *considered*,
 * however relevant it was: the store kept it, recall could never see it, and
 * the failure was invisible because a plausible answer still came back from
 * whatever was recent. A convention taught in March was unreachable by April
 * on a busy deployment, and nothing in the reply said so.
 *
 * So the query now selects candidates by what the caller asked about:
 *
 *  - **Term pass.** Rows whose content contains any of the query's selective
 *    terms, newest-first, capped. Age is irrelevant to eligibility here — this
 *    is the pass that reaches an old, highly relevant fact.
 *  - **Recency pass.** The newest rows with no term filter, capped. Kept
 *    because scoring is a blend, not a keyword match: a high-importance
 *    standing fact whose wording does not lexically overlap the question must
 *    still be a candidate, and a query with no usable terms at all ("?", "any
 *    update") must still recall something. This is the original behaviour,
 *    retained as a floor rather than as the whole strategy.
 *
 * Both are bounded, so a large corpus still cannot turn one recall into an
 * unbounded read; the ceiling is the sum, reached only when the two passes
 * are disjoint.
 *
 * `contains` rather than Postgres full-text on purpose. `to_tsvector` would
 * need a GIN index to beat this, and an index is a migration a human must run
 * — this lands whole, with no half of it inert. The scope, thread, entity and
 * kind narrowing in front of it all hit existing indexes, so the ILIKE runs
 * over a filtered set and not the table. If this ever becomes the hot path,
 * `pg_trgm` on `content` is the upgrade and it is purely an optimisation.
 */
const TERM_CANDIDATE_WINDOW = 400;
/**
 * Deliberately the old `CANDIDATE_WINDOW` value, unchanged. The recency pass
 * is the previous behaviour kept as a floor, so nothing that used to be a
 * candidate stops being one — the term pass only ever adds.
 */
const RECENCY_CANDIDATE_WINDOW = 200;

/**
 * How many query terms reach the SQL as `contains` clauses.
 *
 * A long investigation request tokenizes to hundreds of words, and one ILIKE
 * per word would be a worse query than the scan it replaced. Terms are ranked
 * by likely selectivity — anything with a digit first (issue numbers, PR
 * numbers, versions and branch names are the most discriminating strings in
 * this corpus), then longest-first — and the rest are dropped from the *query*
 * only. Every term still counts in `termOverlap` when the candidates are
 * scored, so dropping one costs precision in retrieval, never in ranking.
 */
const MAX_QUERY_TERMS = 12;

/** Recency half-life. A month-old fact scores about half a fresh one. */
const RECENCY_HALF_LIFE_DAYS = 30;

/**
 * Ranking weights. Relevance dominates — a highly important fact about
 * something else is still about something else.
 *
 * `AUTHORITY` is the newest of the four and exists to satisfy a specific
 * requirement: recency alone must not override a more authoritative source.
 * Without it, a fact the extractor inferred from a tool outcome five minutes
 * ago outranks a convention a team lead deliberately stated last month,
 * purely because it is newer.
 *
 * It is weighted at two and a half times recency, which is what makes that a
 * guarantee rather than a tendency: the gap between the top authority tier and
 * an attributed inference (0.25 × 0.4 = 0.10) exceeds everything recency can
 * award across the 90-day retention window in `config/memory-policy.yaml`
 * (0.10 × 1). Nothing survives long enough for freshness to win on its own.
 * Lower `WEIGHT_AUTHORITY`, or raise `retention.episodeDays`, and that stops
 * being true — the spec "prefers a stated convention over a newer inference"
 * is what fails.
 */
const WEIGHT_RELEVANCE = 0.55;
const WEIGHT_AUTHORITY = 0.25;
const WEIGHT_RECENCY = 0.1;
const WEIGHT_IMPORTANCE = 0.1;

/**
 * Multiplier applied to an episode recorded against a *different* thread than
 * the one asking.
 *
 * This is the whole of the cross-thread control, and it is deliberately a
 * rank and not a filter. Same-thread and thread-independent material wins
 * every otherwise-equal comparison, so a thread still reads mostly as itself;
 * but a markedly more relevant fact from elsewhere can outrank local noise,
 * which is the point — experience earned in one thread was previously
 * invisible in the next.
 */
const CROSS_THREAD_FACTOR = 0.55;

/**
 * Multiplier applied to an episode something later superseded.
 *
 * Superseded facts are returned, not dropped: "we used to branch off
 * `release/old-*` and it stopped working" answers a question the
 * replacement cannot. They sit well below the fact that replaced them so the
 * current answer leads, and `temporalStatus` says which is which so the model
 * cannot present history as present tense.
 */
const HISTORICAL_FACTOR = 0.4;

/** Authority tiers. Multiplied by the episode's own `confidence`. */
const AUTHORITY_TAUGHT = 1;
const AUTHORITY_ATTRIBUTED = 0.6;
const AUTHORITY_DERIVED = 0.3;

/**
 * Provenance marker for an org `decision` written by the team-convention tool,
 * as opposed to one the deterministic extractor derived from a tool outcome.
 *
 * Duplicated from the tool module's own constant rather than imported: the
 * agent app depends on this package and not the reverse, and a shared literal
 * is cheaper than inverting that. A rename must change both — the specs assert
 * this value on the write and the delete.
 */
const CONVENTION_TOOL_NAME = "remember_team_convention";

/** Same duplication, same reason. Used for authority only, never for deletes. */
const PREFERENCE_TOOL_NAME = "remember_preference";

/**
 * Tools that write something a person deliberately said, as opposed to
 * something Lexi inferred. Both are org/user writes through the same store;
 * only provenance distinguishes them, which is why authority reads provenance
 * rather than kind.
 */
const TAUGHT_BY_A_PERSON = new Set<string>([CONVENTION_TOOL_NAME, PREFERENCE_TOOL_NAME]);

export class EpisodicMemoryService {
  constructor(
    private readonly store: MemoryEpisodeStore,
    private readonly policy: MemoryPolicy,
  ) {}

  /**
   * Records an episode, classifying its visibility first. Returns the new id,
   * so a caller that has just recorded a replacement can supersede what it
   * replaced without a lookup.
   *
   * Classification is not advisory: a `preference`, or anything provenanced to
   * a DM, is stored at user scope even if the caller passed `org`. Callers are
   * many and will forget; this is the one place that cannot.
   *
   * **`supersedes` is not atomic with the create.** The port exposes no
   * transaction, and the replacement's id cannot exist before the row does, so
   * the order is create-then-mark. If the marking fails this throws AFTER the
   * episode was written: the new fact is recorded and the old one still reads
   * as current. That is the loud version of the failure and it is the right
   * one — but a caller that turns a throw here into "this was not recorded" is
   * lying to the person. Check `supersede`'s return count instead of assuming.
   */
  async remember(episode: MemoryEpisodeInput): Promise<string> {
    const scope = this.classifyScope(episode);

    if (scope === "user" && !episode.subjectUserId) {
      throw new Error(
        `Refusing to store a ${scope}-scoped ${episode.kind} episode without a subjectUserId — ` +
          "private memory with no owner would be recallable by nobody or, worse, everybody.",
      );
    }

    const id = randomUUID();
    const createdAt = new Date();

    await this.store.memoryEpisode.create({
      data: {
        id,
        scope,
        subjectUserId: episode.subjectUserId ?? null,
        kind: episode.kind,
        threadKey: episode.threadKey ?? null,
        entityType: episode.entityType ?? null,
        entityId: episode.entityId ?? null,
        content: episode.content,
        importance: episode.importance ?? 0.5,
        confidence: episode.confidence ?? 1,
        provenance: episode.provenance ?? {},
        expiresAt: episode.expiresAt ? new Date(episode.expiresAt) : null,
        createdAt,
        supersededById: null,
        supersededAt: null,
        validFrom: episode.validFrom ? new Date(episode.validFrom) : createdAt,
        validUntil: null,
      },
    });

    // Marking happens on the write, not in a later sweep, so there is no
    // window in which the replacement and the thing it replaced both read as
    // current. Scope-matched inside `supersede`, so this cannot be used to
    // retract someone else's fact.
    if (episode.supersedes && episode.supersedes.length > 0) {
      await this.supersede(episode.supersedes, id, {
        scope,
        subjectUserId: episode.subjectUserId,
        at: createdAt,
      });
    }

    return id;
  }

  /**
   * Marks earlier episodes as superseded by a later one, and returns how many
   * rows were actually marked.
   *
   * The count matters: it is lower than `supersededIds.length` whenever an id
   * did not exist or sat outside the replacement's own visibility, and a
   * caller that reports "noted, the old rule no longer applies" needs to know
   * the difference.
   *
   * **Scope is matched, not accepted.** An org fact may only supersede org
   * facts; a person's private fact may only supersede their own. Both
   * directions of the cross rule are deliberate: a personal preference must
   * not be able to retract a team convention, and nobody may rewrite another
   * person's private memory. Recall's three visibility layers protect reads;
   * this is the same rule on the write side, and without it `supersedes` would
   * be a model-supplied id list pointed at any row in the table.
   *
   * Supersession is always explicit. Nothing here infers a conflict from
   * similar content: auto-superseding would let one person's statement
   * silently erase another's, and an unresolved disagreement must stay
   * visible from both sides until somebody resolves it.
   */
  async supersede(
    supersededIds: string[],
    replacementId: string,
    owner: { scope: MemoryScope; subjectUserId?: string; at?: Date },
  ): Promise<number> {
    const ids = supersededIds.filter((id) => id && id !== replacementId);
    if (ids.length === 0) return 0;

    const updateMany = this.store.memoryEpisode.updateMany;
    if (!updateMany) {
      // Never degrade to a no-op. A replacement recorded while the old fact
      // still reads as current is the exact failure supersession exists to
      // prevent, and it would be undetectable from the caller's side.
      throw new Error(
        "Cannot supersede an episode: the wired memory store has no updateMany. " +
          "The replacement would be recorded while the fact it replaces still read as current.",
      );
    }

    if (owner.scope === "user" && !owner.subjectUserId) {
      throw new Error(
        "Refusing to supersede on behalf of a user-scoped episode with no subjectUserId — the update would have no owner to constrain it to.",
      );
    }

    const at = owner.at ?? new Date();

    const { count } = await updateMany.call(this.store.memoryEpisode, {
      where: {
        id: { in: ids },
        scope: owner.scope,
        subjectUserId: owner.scope === "user" ? owner.subjectUserId : null,
        // Do not re-date a fact that something already replaced. The first
        // supersession is when it stopped holding; a later one would move that
        // boundary and lose the actual history.
        supersededById: null,
      },
      data: {
        supersededById: replacementId,
        supersededAt: at,
        validUntil: at,
      },
    });

    return count;
  }

  /**
   * Deletes preferences a person stated about themselves.
   *
   * Scope and owner are pinned here rather than accepted from the caller, so
   * there is no argument combination that reaches org memory, another
   * person's private memory, or a kind other than `preference`. A stated
   * preference is the one thing in this store a person supplied directly
   * about themselves, so it is the one thing they must be able to withdraw —
   * the 90-day retention window is expiry, not revocation, and a feature that
   * records personal facts without a way to remove them should not exist.
   *
   * `contains` is a case-insensitive substring over the recorded content.
   * Omitting it forgets every preference that person has stated, which is the
   * "forget everything you know about me" case.
   *
   * Returns how many rows were removed, so the caller can tell the person
   * what actually happened instead of assuming.
   */
  async forgetOwnPreferences(subjectUserId: string, contains?: string): Promise<number> {
    if (!subjectUserId) {
      throw new Error(
        "Refusing to forget preferences without a subjectUserId — an unowned delete would either match nothing or, worse, everyone.",
      );
    }

    const where: Record<string, unknown> = {
      scope: "user",
      subjectUserId,
      kind: "preference",
    };

    const needle = contains?.trim();
    if (needle) {
      where.content = { contains: needle, mode: "insensitive" };
    }

    const { count } = await this.store.memoryEpisode.deleteMany({ where });
    return count;
  }

  /**
   * Deletes team conventions — org-scoped `decision` episodes written by the
   * convention tool.
   *
   * Narrower than it looks, and deliberately so. It cannot reach a `decision`
   * the deterministic extractor derived from a tool outcome, because those
   * carry no `tool` provenance from the convention writer: an org record of
   * what actually happened is not someone's to retract. Nor can it reach any
   * user-scoped episode, so one person clearing conventions never touches
   * another's private memory.
   *
   * Unlike `forgetOwnPreferences` there is no owner to pin — a shared fact has
   * no single owner, which is why attribution lives in provenance and this is
   * open to anyone. Memory is advisory and can never authorize, so the
   * exposure is a removable, attributable wrong fact rather than a privilege.
   */
  async forgetTeamConventions(contains?: string): Promise<number> {
    const where: Record<string, unknown> = {
      scope: "org",
      kind: "decision",
      provenance: { path: ["tool"], equals: CONVENTION_TOOL_NAME },
    };

    const needle = contains?.trim();
    if (needle) {
      where.content = { contains: needle, mode: "insensitive" };
    }

    const { count } = await this.store.memoryEpisode.deleteMany({ where });
    return count;
  }

  /**
   * Recalls episodes visible to the querying principal, ranked and capped.
   *
   * With no `subjectUserId` the result is org-visible memory only. With one,
   * it is org memory plus that person's own private memory — never anyone
   * else's, under any combination of arguments.
   *
   * Candidates come from `gatherCandidates` (query-driven, not newest-N) and
   * are then scored over a blend of relevance, authority, recency and
   * importance. The three visibility layers are unchanged by any of that: widening what is *considered* must never widen
   * what is *visible*, so the where-clause and the defensive filter below both
   * still run exactly as before.
   */
  async recall(query: RecallQuery): Promise<MemoryEpisodeRecord[]> {
    if (query.scope === "user" && !query.subjectUserId) {
      throw new Error(
        "A user-scoped recall requires a subjectUserId. Widening it to org scope would turn a private lookup into a shared one.",
      );
    }

    const rows = await this.gatherCandidates(query);

    const now = Date.now();
    const limit = Math.min(query.limit ?? this.policy.budgets.maxEpisodesPerRecall, this.policy.budgets.maxEpisodesPerRecall);

    return rows
      .map((row) => this.toRecord(row))
      // Re-apply visibility over the returned rows. The where-clause above
      // should already have done this; this catches a mis-wired store port
      // before it becomes one user reading another's DM content.
      .filter((episode) => this.isVisibleTo(episode, query))
      .filter((episode) => !this.isExpired(episode, now))
      // Thread narrowing, when a caller explicitly asked for isolation. Off by
      // default — see `RecallQuery.sameThreadOnly` and `buildWhere`.
      .filter((episode) => this.isThreadEligible(episode, query))
      .filter((episode) => !(query.currentOnly === true && episode.temporalStatus === "historical"))
      .map((episode) => ({ episode, score: this.score(episode, query, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ episode }) => episode);
  }

  /**
   * Assembles the candidate set from the two passes described at
   * `TERM_CANDIDATE_WINDOW`, deduped by id.
   *
   * The term pass is skipped when the query yields no usable terms, which
   * leaves exactly the old behaviour — that is the intended floor, not an
   * oversight. Both passes share one where-clause builder, so there is no way
   * to widen relevance in one and forget the scope constraint in the other.
   */
  private async gatherCandidates(query: RecallQuery): Promise<Array<Record<string, unknown>>> {
    const terms = selectQueryTerms(query.query);

    const passes: Array<Promise<Array<Record<string, unknown>>>> = [
      this.store.memoryEpisode.findMany({
        where: this.buildWhere(query),
        orderBy: { createdAt: "desc" },
        take: RECENCY_CANDIDATE_WINDOW,
      }),
    ];

    if (terms.length > 0) {
      passes.push(
        this.store.memoryEpisode.findMany({
          where: this.buildWhere(query, terms),
          orderBy: { createdAt: "desc" },
          take: TERM_CANDIDATE_WINDOW,
        }),
      );
    }

    const results = await Promise.all(passes);

    // Dedupe by id rather than by identity: the passes overlap whenever a
    // recent row also matches a term, and some store doubles ignore the
    // where-clause entirely and return the same rows twice.
    const byId = new Map<string, Record<string, unknown>>();
    for (const rows of results) {
      for (const row of rows) {
        const id = String(row.id);
        if (!byId.has(id)) byId.set(id, row);
      }
    }
    return [...byId.values()];
  }

  /**
   * Visibility classification (policy `visibility.*`).
   *
   * A kind listed under `userKinds`, or provenance marking the content as
   * DM-derived, forces user scope. Everything else keeps what it asked for.
   */
  private classifyScope(episode: MemoryEpisodeInput): MemoryScope {
    if (this.policy.visibility.userKinds.includes(episode.kind)) return "user";

    if (this.policy.visibility.dmDerivedIsUserScoped && isDmDerived(episode.provenance)) return "user";

    return episode.scope;
  }

  /**
   * Scope predicate, expressed so the database does the filtering too.
   *
   * `terms`, when supplied, adds the term pass's content disjunction. It is
   * additive: it can only ever narrow what this clause already permits, and
   * the scope conditions are built identically either way.
   */
  private buildWhere(query: RecallQuery, terms: string[] = []): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    const and: Array<Record<string, unknown>> = [];

    if (query.scope === "user") {
      where.OR = [{ scope: "user", subjectUserId: query.subjectUserId }];
    } else if (query.subjectUserId) {
      where.OR = [{ scope: "org" }, { scope: "user", subjectUserId: query.subjectUserId }];
    } else {
      where.OR = [{ scope: "org" }];
    }

    // Thread-INDEPENDENT facts must survive this narrowing.
    //
    // `threadKey` was a hard equality here, and the two explicit writers
    // (`remember_team_convention`, `remember_preference`) record standing facts
    // with no thread at all — a convention taught in one thread is meant to
    // apply in every thread, which is the whole point of org scope. A `null`
    // row can never equal a concrete key, so every convention and preference
    // anyone ever taught Lexi was written successfully and then filtered out of
    // every single recall: a person could teach a set of rules, be told they
    // were recorded, and never see any of them come back.
    //
    // Only the deterministic extractor sets a thread key (from the tool outcome
    // it derives from), so the effect was inverted: facts Lexi inferred herself
    // recalled fine, and facts a human deliberately taught her never did.
    //
    // Scope stays the visibility rule — `isVisibleTo` re-applies it over the
    // results and deliberately does not mention `threadKey`, because a thread
    // is about RELEVANCE, not permission.
    //
    // That last sentence is now taken at its word. The fix above narrowed the
    // clause to "this thread, plus everything that belongs to no thread", which
    // rescued standing facts but still discarded every episode attached to
    // ANOTHER thread — so anything Lexi learned while working thread A was
    // unavailable in thread B, and each thread started over. Since a thread is
    // relevance and not permission, that belongs in the ranking and not in the
    // where-clause: other threads' episodes are candidates, and
    // `CROSS_THREAD_FACTOR` keeps them below local material.
    //
    // `sameThreadOnly` reinstates the narrowing for a caller that genuinely
    // wants one thread's view — replay, or reproducing what a single thread
    // could see. It is not a privacy control and must never be used as one.
    if (query.threadKey && query.sameThreadOnly === true) {
      and.push({ OR: [{ threadKey: query.threadKey }, { threadKey: null }] });
    }

    if (query.entityType) where.entityType = query.entityType;
    if (query.entityId) where.entityId = query.entityId;
    if (query.kinds && query.kinds.length > 0) where.kind = { in: query.kinds };

    // Pushed into SQL as well as filtered in `recall`, so a `currentOnly`
    // caller does not pay to transport history it is going to discard.
    if (query.currentOnly === true) where.supersededById = null;

    if (terms.length > 0) {
      and.push({ OR: terms.map((term) => ({ content: { contains: term, mode: "insensitive" } })) });
    }

    if (and.length > 0) where.AND = and;

    return where;
  }

  /** The same rule as `buildWhere`, applied to results. Deliberately duplicated. */
  private isVisibleTo(episode: MemoryEpisodeRecord, query: RecallQuery): boolean {
    if (episode.scope === "org") return query.scope !== "user";
    return Boolean(query.subjectUserId) && episode.subjectUserId === query.subjectUserId;
  }

  /**
   * Thread narrowing, applied to results — and only when the caller asked for
   * it. Separate from `isVisibleTo` on purpose: mixing a relevance filter into
   * the visibility filter is how a thread key starts being mistaken for a
   * permission.
   */
  private isThreadEligible(episode: MemoryEpisodeRecord, query: RecallQuery): boolean {
    if (query.sameThreadOnly !== true || !query.threadKey) return true;
    return !episode.threadKey || episode.threadKey === query.threadKey;
  }

  private isExpired(episode: MemoryEpisodeRecord, now: number): boolean {
    const raw = (episode as { expiresAt?: string | null }).expiresAt;
    if (!raw) return false;
    return new Date(raw).getTime() <= now;
  }

  /**
   * Blends the four signals ranking uses. Relevance dominates — a highly
   * important fact about something else is still about something else — and
   * authority sits above recency so a fresh inference cannot outrank a stated
   * rule just by being newer.
   *
   * The two multipliers are demotions, not exclusions: a cross-thread or
   * superseded episode still competes, it just has to be materially more
   * relevant to win.
   */
  private score(episode: MemoryEpisodeRecord, query: RecallQuery, now: number): number {
    const relevance = termOverlap(query.query, episode.content);
    const ageDays = (now - new Date(episode.createdAt).getTime()) / 86_400_000;
    const recency = Math.pow(0.5, Math.max(0, ageDays) / RECENCY_HALF_LIFE_DAYS);

    let score =
      relevance * WEIGHT_RELEVANCE +
      authorityOf(episode) * WEIGHT_AUTHORITY +
      recency * WEIGHT_RECENCY +
      episode.importance * WEIGHT_IMPORTANCE;

    if (query.threadKey && episode.threadKey && episode.threadKey !== query.threadKey) {
      score *= CROSS_THREAD_FACTOR;
    }

    if (episode.temporalStatus === "historical") score *= HISTORICAL_FACTOR;

    return score;
  }

  private toRecord(row: Record<string, unknown>): MemoryEpisodeRecord {
    const createdAt = toIso(row.createdAt) ?? new Date().toISOString();
    const expiresAt = toIso(row.expiresAt);
    const supersededById = (row.supersededById as string | null) ?? undefined;
    const supersededAt = toIso(row.supersededAt);
    const validUntil = toIso(row.validUntil);
    const temporalStatus: MemoryTemporalStatus = supersededById ? "historical" : "current";

    return {
      id: String(row.id),
      scope: row.scope as MemoryScope,
      subjectUserId: (row.subjectUserId as string | null) ?? undefined,
      kind: row.kind as MemoryEpisodeKind,
      threadKey: (row.threadKey as string | null) ?? undefined,
      entityType: (row.entityType as MemoryEpisodeRecord["entityType"]) ?? undefined,
      entityId: (row.entityId as string | null) ?? undefined,
      content: String(row.content ?? ""),
      importance: typeof row.importance === "number" ? row.importance : 0.5,
      confidence: typeof row.confidence === "number" ? row.confidence : 1,
      provenance: (row.provenance as Record<string, unknown>) ?? {},
      createdAt,
      // Always populated, so a renderer never has to infer "is this still
      // true?" from whether another field happens to be set.
      temporalStatus,
      ...(supersededById ? { supersededById } : {}),
      ...(supersededAt ? { supersededAt } : {}),
      // Defaulted to the write time when the row predates `validFrom` or the
      // writer had nothing more precise to say. A temporal fact with a null
      // start reads as "always applied", which is not what was recorded.
      validFrom: toIso(row.validFrom) ?? createdAt,
      ...(validUntil ? { validUntil } : {}),
      // Carried so `recall` can drop expired rows without a second read; not
      // part of the frozen record shape, so it stays off the public type.
      ...(expiresAt ? { expiresAt } : {}),
    } as MemoryEpisodeRecord;
  }
}

/** Provenance markers that mean "this came out of a DM". */
function isDmDerived(provenance: Record<string, unknown> | undefined): boolean {
  if (!provenance) return false;
  const source = String(provenance.source ?? provenance.channelType ?? "").toLowerCase();
  return source === "dm" || source === "im" || provenance.isDirectMessage === true;
}

/**
 * How much weight this episode's source earns, in [0, 1].
 *
 * Read off provenance rather than kind, because kind does not distinguish a
 * `decision` a person dictated from a `decision` the extractor inferred from a
 * successful tool call — and that difference is precisely what "a more
 * authoritative source" means here. Scaled by the episode's own `confidence`,
 * so a convention recorded as *observed* rather than *stated* (0.7 from the
 * writing tool) sits below one someone actually asked for.
 */
export function authorityOf(episode: Pick<MemoryEpisodeRecord, "provenance" | "confidence">): number {
  const provenance = episode.provenance ?? {};
  const tool = String(provenance.tool ?? "");

  const tier = TAUGHT_BY_A_PERSON.has(tool)
    ? AUTHORITY_TAUGHT
    : provenance.actor
      ? AUTHORITY_ATTRIBUTED
      : AUTHORITY_DERIVED;

  const confidence = typeof episode.confidence === "number" ? Math.min(1, Math.max(0, episode.confidence)) : 1;
  return tier * confidence;
}

/**
 * Picks the terms the term pass sends to SQL, most selective first.
 *
 * Selectivity is estimated rather than measured: no statistics are available
 * here, and a round trip to get them would cost more than the imprecision.
 * Tokens containing a digit come first because in this corpus they are issue
 * numbers, PR numbers, versions and branch names — the strings that identify
 * one thing rather than a topic. Length breaks the remaining ties, on the
 * usual assumption that longer words are rarer than short ones.
 *
 * Stopwords are dropped outright: "the" as an ILIKE would match most of the
 * table and turn the term pass back into the scan it replaced.
 */
export function selectQueryTerms(query: string, max: number = MAX_QUERY_TERMS): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];

  // `?? ""` because this now runs on every recall, before any read. A caller
  // that reaches `recall` with no query text at all must fall through to the
  // recency pass, not throw and lose the turn its memory block.
  for (const token of tokenize(query ?? "")) {
    if (STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }

  return terms
    .sort((a, b) => {
      const aNumeric = /\d/.test(a) ? 1 : 0;
      const bNumeric = /\d/.test(b) ? 1 : 0;
      if (aNumeric !== bNumeric) return bNumeric - aNumeric;
      if (a.length !== b.length) return b.length - a.length;
      // Alphabetical last, so the selected set is stable for a given query
      // and a failing recall is reproducible.
      return a.localeCompare(b);
    })
    .slice(0, Math.max(0, max));
}

/**
 * Words too common to narrow anything. Short by design — this list only has
 * to cover what would make an ILIKE useless, and an aggressive list would
 * start discarding real query terms.
 */
const STOPWORDS = new Set<string>([
  "the",
  "and",
  "for",
  "was",
  "are",
  "you",
  "her",
  "his",
  "its",
  "our",
  "not",
  "but",
  "can",
  "did",
  "does",
  "has",
  "had",
  "have",
  "how",
  "into",
  "that",
  "this",
  "then",
  "them",
  "there",
  "they",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "from",
  "were",
  "will",
  "would",
  "your",
  "about",
  "please",
  "could",
  "should",
]);

/**
 * Lexical relevance: the share of the query's terms present in the content.
 *
 * Deliberately not an embedding call. Plain code comes first, and episodic
 * recall runs on every turn — semantic search over the corpus is what
 * `search_product_knowledge` is for.
 *
 * Note that this scores over *every* query term, including the ones
 * `selectQueryTerms` dropped from the SQL. Retrieval and ranking are allowed
 * to disagree: the query decides what is considered, this decides what wins.
 */
export function termOverlap(query: string, content: string): number {
  const terms = tokenize(query ?? "");
  if (terms.length === 0) return 0;
  const haystack = new Set(tokenize(content));
  const hits = terms.filter((term) => haystack.has(term)).length;
  return hits / terms.length;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9#]+/i)
    .filter((token) => token.length > 2);
}

/** Dates arrive as `Date` from Prisma and as strings from replayed fixtures. */
function toIso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return text.length > 0 ? text : undefined;
}
