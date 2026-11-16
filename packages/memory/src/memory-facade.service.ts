import type {
  MemoryPort,
  MemoryPack,
  MemoryEpisodeInput,
  MemoryEpisodeRecord,
  RecallQuery,
  ThreadState,
  TokenBudget,
  TurnDigest,
  DecisionNote,
} from "@lexi/contracts";
import type { MemoryPolicy } from "./memory-policy.schema";
import { estimateTokens } from "./token-estimate";
import { ThreadStateService, type TurnStateInput } from "./working/thread-state.service";
import { EpisodicMemoryService } from "./episodic/episodic-memory.service";
import { renderThreadState } from "./working/render-thread-state";
import { extractEpisodes, type TurnOutcome } from "./episodic/deterministic-extractor";
import { renderEpisodeLine } from "./episodic/render-episode-line";
import { HierarchicalBuffer } from "./buffer/hierarchical-buffer";
import type { KnowledgeMatch, KnowledgeSearchOptions } from "./semantic/knowledge-chunk.indexer";

/**
 * The `MemoryPort` facade.
 *
 * One seam over four layers: working memory, episodic memory,
 * semantic knowledge and the pre-existing governance memory services.
 * Consumers depend on this interface and never on what is behind it,
 * which is what lets the memory subsystem change without touching them.
 *
 * Two invariants hold on every path out of `recall`:
 *  - **The pack is budget-capped.** `tokenCost` never exceeds the effective
 *    budget, and `truncated` says so when content was dropped.
 *  - **Memory is advisory, never authority.** The rendered block says
 *    so in words, because the model reads the block, not the spec. Nothing
 *    recalled here can grant a permission or satisfy a gate.
 */

/** What the facade asks an optional issue-memory service for. */
export interface GovernanceMemoryQuery {
  actorSlackId?: string;
  issueNumber?: number;
  repo?: string;
  component?: string;
  query?: string;
  maxTokenBudget?: number;
}

/**
 * An optional issue-memory service (engineering knowledge, user profiles,
 * related issues). Structural, so any implementation or a test stub fits; the
 * facade only ever renders what it returns, so the context type is opaque here.
 */
export interface GovernanceMemoryPort<Context = unknown> {
  retrieve(query: GovernanceMemoryQuery): Promise<Context>;
  formatForConversation(context: Context): string;
}

/** The read half of the knowledge indexer, so the facade needs no embedder. */
export interface KnowledgeSearchPort {
  search(query: string, options?: KnowledgeSearchOptions): Promise<KnowledgeMatch[]>;
}

/** Extra, optional hints callers can pass alongside the frozen `RecallQuery`. */
export interface FacadeRecallQuery extends RecallQuery {
  /** Routed to the governance issue-memory / knowledge-graph services. */
  issueNumber?: number;
  repo?: string;
  actorSlackId?: string;
}

/**
 * The logging this facade needs, structurally so `@lexi/memory` keeps no Nest
 * dependency. `PinoLoggerService` satisfies it.
 *
 * Present because of a specific failure mode: memory that
 * silently fails to persist is indistinguishable, from the outside, from
 * memory that had nothing to remember. Every write path below reports its own
 * outcome, so "Lexi forgot" can be answered from logs rather than inferred.
 */
export interface MemoryLoggerPort {
  log(message: string, context?: string): void;
  warn(message: string, context?: string): void;
  debug?(message: string, context?: string): void;
}

export interface MemoryFacadeDeps {
  policy: MemoryPolicy;
  threadState: ThreadStateService;
  episodic: EpisodicMemoryService;
  /** The existing `@lexi/governance` memory services. Optional. */
  governance?: GovernanceMemoryPort;
  /** Semantic corpus search. Optional. */
  knowledge?: KnowledgeSearchPort;
  /** Hierarchical compaction. Optional — needs a cheap-model summariser. */
  buffer?: HierarchicalBuffer;
  /** Write-path observability. Optional so existing constructions still compile. */
  logger?: MemoryLoggerPort;
}

/**
 * Outcome of a turn-end working-memory write.
 *
 * A struct rather than a boolean because the three ways this can go wrong are
 * not interchangeable: memory being off is expected, a concurrency conflict is
 * retryable, and a store error means the row is not there. A caller that
 * cannot tell them apart will either log noise on every turn of a dark
 * deployment or swallow a real outage.
 */
export interface WorkingMemoryWriteResult {
  /** True only if working memory now contains this turn. */
  persisted: boolean;
  /**
   * Why not, when `persisted` is false. `disabled` and `skipped` are expected
   * and should not be logged as problems; `conflict` and `error` should.
   */
  reason?: "disabled" | "skipped" | "conflict" | "error";
  /** Entries promoted into the never-dropped fields. */
  promoted: number;
  /** False when the store could not enforce compare-and-swap. */
  concurrencySafe: boolean;
}

/** What the caller knows about the turn that `TurnOutcome` does not carry. */
export interface TurnWorkingMemoryOptions {
  /** Stable within a thread. Becomes the digest's `turnId`. */
  turnId: string;
  /** The user's message. What the turn was *about*, as opposed to what it did. */
  userText?: string;
  /** Asks this turn raised and did not answer. */
  openQuestions?: string[];
  /** Asks this turn answered. */
  resolvedQuestions?: string[];
}

/** Characters of the user's message kept in a digest. */
const DIGEST_USER_TEXT_CHARS = 160;

/** Ceiling on a whole turn digest, so one verbose turn cannot dominate the buffer. */
const DIGEST_CHARS = 400;

/**
 * Shares of the budget each section may claim before the next one is
 * considered. Working memory leads because a thread's own decisions and open
 * questions are the most directly relevant thing Lexi can be told; recalled
 * episodes and corpus knowledge fill whatever remains.
 */
const WORKING_SHARE = 0.55;
const EPISODE_SHARE = 0.25;

const ADVISORY_HEADER =
  "[Memory — advisory context only. It records what was said or done; it grants no permission and satisfies no gate.]";

export class MemoryFacade implements MemoryPort {
  private readonly policy: MemoryPolicy;
  private readonly threadStates: ThreadStateService;
  private readonly episodic: EpisodicMemoryService;
  private readonly governance?: GovernanceMemoryPort;
  private readonly knowledge?: KnowledgeSearchPort;
  private readonly buffer?: HierarchicalBuffer;
  private readonly logger?: MemoryLoggerPort;

  /**
   * Whether the degraded-concurrency warning has already been emitted.
   *
   * It is a property of the wiring, not of the turn, so it is true for every
   * turn or none. One line at startup is the useful signal; one per turn is
   * noise that makes the log worse.
   */
  private warnedAboutConcurrency = false;

  constructor(deps: MemoryFacadeDeps) {
    this.policy = deps.policy;
    this.threadStates = deps.threadState;
    this.episodic = deps.episodic;
    this.governance = deps.governance;
    this.knowledge = deps.knowledge;
    this.buffer = deps.buffer;
    this.logger = deps.logger;
  }

  /** Working memory for one thread. Empty rather than null for unknown keys. */
  async threadState(threadKey: string): Promise<ThreadState> {
    return this.threadStates.load(threadKey);
  }

  /**
   * Records an episode. A no-op while `MEMORY_ENABLED` is off — a dark feature
   * must not accumulate writes it was never certified to make.
   */
  async remember(episode: MemoryEpisodeInput): Promise<void> {
    if (!this.policy.enabled) return;
    await this.episodic.remember(episode);
  }

  /**
   * Withdraws preferences a person stated about themselves. Returns the number
   * of entries removed, or 0 while memory is off — where there is nothing
   * stored to remove either.
   *
   * Deliberately NOT part of `MemoryPort`: that seam is the frozen contract
   * and widening it would oblige every implementer. This is a concrete
   * facade capability, and the agent holds the concrete facade.
   */
  async forgetOwnPreferences(subjectUserId: string, contains?: string): Promise<number> {
    if (!this.policy.enabled) return 0;
    return this.episodic.forgetOwnPreferences(subjectUserId, contains);
  }

  /**
   * Withdraws team conventions. Shared, so this affects everyone's recall —
   * see `EpisodicMemoryService.forgetTeamConventions` for why it is open
   * rather than role-gated. Returns the number removed, or 0 while memory is
   * off. Off `MemoryPort` for the same reason as the preference forget.
   */
  async forgetTeamConventions(contains?: string): Promise<number> {
    if (!this.policy.enabled) return 0;
    return this.episodic.forgetTeamConventions(contains);
  }

  /**
   * Turn-end extraction. Derives episodes from the turn's structured
   * outcomes with plain code — no model call — and stores them. Returns how
   * many were written.
   *
   * This is the seam that connects the deterministic extractor to the store;
   * without it the extractor is correct and unreachable.
   */
  async rememberTurn(outcome: TurnOutcome): Promise<number> {
    if (!this.policy.enabled) return 0;

    const episodes = extractEpisodes(outcome, {
      skipOnFastPath: this.policy.extraction.skipOnFastPath,
    });

    let stored = 0;
    for (const episode of episodes) {
      try {
        await this.episodic.remember(episode);
        stored += 1;
      } catch {
        // One malformed episode must not cost the turn its other memories.
      }
    }
    return stored;
  }

  /**
   * Records one turn into working memory — the write half of
   * `threadState()`.
   *
   * This is the seam that was missing. `ThreadStateService` had `recordTurn`,
   * `addDecision`, `addOpenQuestion` and `resolveOpenQuestion`, the facade
   * exposed only the `threadState` *reader*, and the sole external memory call
   * in the application was `rememberTurn` — which writes episodic memory, not
   * working memory. Structured thread state was therefore always empty, so the
   * working-memory section of every pack rendered blank and structured
   * working memory was advertised behaviour that could not occur.
   *
   * Best-effort by contract: memory is advisory, so nothing here may
   * fail a turn that already answered the user. But the failure is *returned*,
   * not swallowed — a caller must never be able to tell the user something was
   * remembered when the write did not land.
   */
  async recordTurnState(threadKey: string, input: TurnStateInput): Promise<WorkingMemoryWriteResult> {
    if (!this.policy.enabled) {
      return { persisted: false, reason: "disabled", promoted: 0, concurrencySafe: true };
    }

    try {
      const result = await this.threadStates.recordTurnState(threadKey, input);

      if (!result.concurrencySafe && !this.warnedAboutConcurrency) {
        this.warnedAboutConcurrency = true;
        this.logger?.warn(
          "Working memory is persisting without compare-and-swap: the store has no create/updateMany pair, so two concurrent turns in one thread can overwrite each other.",
          "MemoryFacade",
        );
      }

      if (!result.ok) {
        // Every retry lost its race, which means other turns *did* write. The
        // thread is not corrupt; this turn's digest is simply missing from it.
        this.logger?.warn(
          `Working memory write for ${threadKey} lost ${result.attempts} concurrency races and was abandoned.`,
          "MemoryFacade",
        );
        return { persisted: false, reason: "conflict", promoted: 0, concurrencySafe: true };
      }

      return {
        persisted: true,
        promoted: result.promoted,
        concurrencySafe: result.concurrencySafe,
      };
    } catch (error) {
      // The `thread_states` row is unreachable — a missing table, a closed
      // pool, a serialisation failure. Reported rather than degraded silently:
      // an absent write and an empty thread look identical at read time, and
      // only this line can tell them apart afterwards.
      this.logger?.warn(
        `Working memory write for ${threadKey} failed: ${error instanceof Error ? error.message : "unknown error"}`,
        "MemoryFacade",
      );
      return { persisted: false, reason: "error", promoted: 0, concurrencySafe: true };
    }
  }

  /**
   * Derives one turn's working memory from the same `TurnOutcome` that feeds
   * episodic extraction, and writes it.
   *
   * Deliberately reuses `extractEpisodes` rather than re-describing tool calls
   * here. Those descriptions ("dispatched a direct fix for #101", "kept #101
   * open: …") are the phrases `protected-content.ts` was written against, so
   * routing the digest through the same vocabulary is what makes the
   * protection classifier land on real turns instead of on a second,
   * subtly-different phrasing invented at this layer. The extractor is pure
   * and synchronous, so calling it twice in a turn costs nothing.
   *
   * A separate method from `rememberTurn` rather than folded into it: episodic
   * and working memory fail independently, they are gated by different policy
   * keys, and `rememberTurn` is on the frozen path several specs assert
   * against. The caller does both and reports each on its own.
   */
  async recordTurnFromOutcome(
    outcome: TurnOutcome,
    options: TurnWorkingMemoryOptions,
  ): Promise<WorkingMemoryWriteResult> {
    if (!this.policy.enabled) {
      return { persisted: false, reason: "disabled", promoted: 0, concurrencySafe: true };
    }

    // The fast path is free by design and policy
    // `extraction.skipOnFastPath` is how that is expressed. Working memory
    // honours the same switch: a regex-routed turn that never reached a model
    // must not be the thing that makes the free path cost a write.
    if (outcome.isFastPath && this.policy.extraction.skipOnFastPath) {
      return { persisted: false, reason: "skipped", promoted: 0, concurrencySafe: true };
    }

    const episodes = extractEpisodes(outcome, { skipOnFastPath: this.policy.extraction.skipOnFastPath });

    // Entity identity is (type, id); `mergeEntities` dedupes downstream, so
    // this only has to be complete, not unique.
    const entities = episodes
      .filter((episode) => episode.entityType && episode.entityId)
      .map((episode) => ({ type: episode.entityType!, id: episode.entityId! }));

    // Every stated decision arrives here as a `decision`-kind episode —
    // `extractEpisodes` maps `outcome.decisions` and the decision-shaped tools
    // (request_keep_open, cancel_pending_closure) onto the same kind — so one
    // filter covers both sources.
    const decisions = episodes
      .filter((episode) => episode.kind === "decision")
      .map((episode) => ({
        decidedBy: typeof episode.provenance?.actor === "string" ? episode.provenance.actor : outcome.actorUserId,
        statement: episode.content,
      }));

    return this.recordTurnState(outcome.threadKey, {
      turnId: options.turnId,
      actorUserId: outcome.actorUserId,
      summary: buildTurnSummary(options.userText, episodes.map((episode) => episode.content)),
      entities,
      decisions,
      ...(options.openQuestions ? { openQuestions: options.openQuestions } : {}),
      ...(options.resolvedQuestions ? { resolvedQuestions: options.resolvedQuestions } : {}),
    });
  }

  /**
   * Runs hierarchical compaction if — and only if — the thread is over budget
   *. Returns whether anything was compressed *and persisted*.
   *
   * Called at turn end rather than on a schedule: a timer would spend cheap-
   * model tokens summarising threads that were never over budget.
   *
   * The write is compare-and-swap against the version read before the
   * summariser ran, and a lost race is NOT retried. Retrying would re-run the
   * summariser — real spend on the cheap model — to produce a compaction the
   * winning writer's next turn will attempt anyway. The cost of waiting one
   * turn is that the thread stays over budget for one turn; the cost of
   * retrying is unbounded model calls on the busiest threads, which is the
   * runaway-cost failure mode the budgets exist to prevent.
   */
  async compactThread(threadKey: string, budget?: TokenBudget): Promise<boolean> {
    if (!this.policy.enabled || !this.buffer) return false;

    const ceiling = budget ?? { maxTokens: this.policy.budgets.maxThreadStateTokens };

    try {
      const { state, version } = await this.threadStates.loadProjection(threadKey);

      const result = await this.buffer.compactIfNeeded(state, ceiling);
      if (!result.compacted) return false;

      // Persist, or the same compaction is recomputed — and re-paid for — on
      // every subsequent turn.
      const write = await this.threadStates.saveIfUnchanged(result.state, version);

      if (!write.ok) {
        this.logger?.warn(
          `Compaction of ${threadKey} was discarded on a concurrent write; the thread stays over budget for one turn.`,
          "MemoryFacade",
        );
        return false;
      }

      this.logger?.log(
        `Compacted ${threadKey}: ${result.compressed} digests folded, ${result.promoted} promoted` +
          `${result.guardedBy.length > 0 ? ` (guarded: ${result.guardedBy.join(", ")})` : ""}.`,
        "MemoryFacade",
      );
      return true;
    } catch (error) {
      // Both the source digests and the last valid projection are untouched:
      // nothing was written on this path unless `saveIfUnchanged` returned ok.
      this.logger?.warn(
        `Compaction of ${threadKey} failed: ${error instanceof Error ? error.message : "unknown error"}`,
        "MemoryFacade",
      );
      return false;
    }
  }

  /**
   * Assembles a budget-capped pack from every layer.
   *
   * Each section is measured before it is admitted, and the effective budget
   * is the smaller of the caller's ask and the policy ceiling — a caller
   * cannot opt into a larger pack than the org agreed to pay for.
   */
  async recall(query: FacadeRecallQuery, budget: TokenBudget): Promise<MemoryPack> {
    const effective: TokenBudget = {
      maxTokens: Math.min(budget.maxTokens, this.policy.budgets.maxMemoryTokens),
    };

    if (!this.policy.enabled) return emptyPack(effective);

    const sections: string[] = [ADVISORY_HEADER];
    let used = estimateTokens(ADVISORY_HEADER);
    let truncated = false;

    // --- Working memory -------------------------------------------
    let digests: TurnDigest[] = [];
    let decisions: DecisionNote[] = [];

    if (query.threadKey) {
      const state = await this.threadStates.load(query.threadKey);
      digests = state.digests.filter((digest) => !digest.superseded);
      decisions = state.decisions;

      // Two ceilings apply: this section's share of the pack, and the policy's
      // separate per-thread budget. The tighter one wins, so a generous
      // overall budget cannot let one thread's history consume the lot.
      const workingBudget = Math.min(
        Math.floor(effective.maxTokens * WORKING_SHARE),
        this.policy.budgets.maxThreadStateTokens,
      );
      const rendered = renderThreadState(state, { maxTokens: Math.max(0, workingBudget) });

      if (rendered.text && used + rendered.tokenCost <= effective.maxTokens) {
        sections.push(rendered.text);
        used += rendered.tokenCost;
      } else if (rendered.text) {
        truncated = true;
      }
      if (rendered.truncated) truncated = true;
    }

    // --- Episodic memory ------------------------------------------
    // Scope filtering lives in the episodic service; the facade passes the
    // principal through and never widens it.
    const episodes = await this.safely(() => this.episodic.recall(query), [] as MemoryEpisodeRecord[]);
    const admitted: MemoryEpisodeRecord[] = [];

    const episodeCeiling = used + Math.floor(effective.maxTokens * EPISODE_SHARE);
    const episodeLines: string[] = [];

    for (const episode of episodes) {
      // `renderEpisodeLine` rather than an inline template, so a superseded
      // fact cannot reach the prompt looking current — the model reads this
      // block and not the record's `temporalStatus`. Unchanged for a current
      // episode, byte for byte.
      const line = renderEpisodeLine(episode);
      const cost = estimateTokens(line);
      if (used + cost > Math.min(episodeCeiling, effective.maxTokens)) {
        truncated = true;
        break;
      }
      episodeLines.push(line);
      admitted.push(episode);
      used += cost;
    }

    if (episodeLines.length > 0) {
      const heading = "Recalled:";
      used += estimateTokens(heading);
      sections.push([heading, ...episodeLines].join("\n"));
    }

    // --- Governance memory services -------------------------------
    if (this.governance) {
      const context = await this.safely(
        () =>
          this.governance!.retrieve({
            actorSlackId: query.actorSlackId ?? query.subjectUserId,
            issueNumber: query.issueNumber,
            repo: query.repo,
            query: query.query,
            maxTokenBudget: Math.max(0, effective.maxTokens - used),
          }),
        undefined,
      );

      if (context) {
        const formatted = this.safelySync(() => this.governance!.formatForConversation(context), "");
        const cost = estimateTokens(formatted);
        if (formatted && used + cost <= effective.maxTokens) {
          sections.push(formatted);
          used += cost;
        } else if (formatted) {
          truncated = true;
        }
      }
    }

    // --- Semantic knowledge ---------------------------------------
    if (this.knowledge && query.query) {
      const matches = await this.safely(() => this.knowledge!.search(query.query, { limit: 3 }), [] as KnowledgeMatch[]);
      const lines: string[] = [];

      for (const match of matches) {
        const line = `- ${match.sourceRef}: ${match.content}`;
        const cost = estimateTokens(line);
        if (used + cost > effective.maxTokens) {
          truncated = true;
          break;
        }
        lines.push(line);
        used += cost;
      }

      if (lines.length > 0) {
        const heading = "Product knowledge:";
        used += estimateTokens(heading);
        sections.push([heading, ...lines].join("\n"));
      }
    }

    // Nothing but the header was admitted: render nothing. A lone advisory
    // label costs prompt tokens on every turn and tells the reader nothing,
    // and a non-empty rendering of an empty recall makes "nothing is
    // recorded" indistinguishable from "something is" for every caller that
    // checks `rendered`. The label still accompanies any real content.
    if (sections.length === 1) {
      return { ...emptyPack(effective), digests, decisions, truncated };
    }

    // Assemble, then clamp. Every step above is budget-aware; this is the
    // guarantee callers actually rely on, so it is enforced, not trusted.
    const assembled = sections.filter(Boolean).join("\n");
    const rendered = clampToBudget(assembled, effective.maxTokens);
    if (rendered.length < assembled.length) truncated = true;

    return {
      episodes: admitted,
      digests,
      decisions,
      rendered,
      tokenCost: estimateTokens(rendered),
      budget: effective,
      truncated,
    };
  }

  /**
   * Memory is advisory, so a broken memory source degrades the answer
   * rather than failing the turn. Applied per source so one bad service
   * cannot cost the caller the rest of the pack.
   */
  private async safely<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await operation();
    } catch {
      return fallback;
    }
  }

  private safelySync<T>(operation: () => T, fallback: T): T {
    try {
      return operation();
    } catch {
      return fallback;
    }
  }
}

/**
 * One turn, as a single line of working memory.
 *
 * Shaped so the two halves stay distinguishable: what was asked, and what was
 * actually done. Only the second half is ground truth — the first is the
 * user's framing — and a later reader (human or model) needs to be able to
 * tell them apart, which "asked: … — did: …" does and a merged sentence does
 * not.
 *
 * Whitespace is collapsed because Slack messages arrive with newlines that
 * would break the one-line-per-digest rendering in `render-thread-state.ts`.
 */
function buildTurnSummary(userText: string | undefined, actions: string[]): string {
  const asked = (userText ?? "").replace(/\s+/g, " ").trim().slice(0, DIGEST_USER_TEXT_CHARS);
  const did = actions.join("; ").replace(/\s+/g, " ").trim();

  const parts: string[] = [];
  if (asked) parts.push(`asked: ${asked}`);
  if (did) parts.push(`did: ${did}`);

  return parts.join(" — ").slice(0, DIGEST_CHARS);
}

function emptyPack(budget: TokenBudget): MemoryPack {
  return {
    episodes: [],
    digests: [],
    decisions: [],
    rendered: "",
    tokenCost: 0,
    budget,
    truncated: false,
  };
}

/** Character clamp on a token budget — `ceil(len/4) <= T` exactly when `len <= 4T`. */
function clampToBudget(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, Math.floor(maxTokens)) * 4;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

