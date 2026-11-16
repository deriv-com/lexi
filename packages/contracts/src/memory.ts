/**
 * Memory contracts.
 *
 * `@lexi/memory` implements these; other packages consume them without
 * importing any of its internals. Memory is advisory context, never authority: nothing recalled
 * through this surface can grant a permission, satisfy a gate, or license an
 * action claim.
 */

import type { CoverageRecord } from "./spec";

/**
 * Visibility. `org` covers shared work facts
 * (issues, PRs, specs, decisions). `user` covers anything derived from a DM or
 * a stated personal preference, and is recallable only by its subject.
 */
export type MemoryScope = "org" | "user";

export type MemoryEpisodeKind =
  | "decision"
  | "assignment"
  | "escalation"
  | "preference"
  | "fact"
  | "outcome";

export type MemoryEntityType = "issue" | "pull_request" | "spec" | "work_item" | "repo";

/** A thing a thread referred to, deduped across turns. */
export interface EntityRef {
  type: MemoryEntityType;
  /** Issue/PR number, spec id, work-item id, or repo key — as a string. */
  id: string;
  /** `config/repos.yaml` key this entity belongs to, where it has one. */
  repoKey?: string;
  /** Human label for rendering, e.g. "#909 deposit button dead". */
  label?: string;
  url?: string;
}

/**
 * One turn, compressed. Held newest-first on `ThreadState`. When the buffer
 * exceeds budget the oldest are folded into a single summary digest and marked
 * `superseded` — retained in Postgres for replay, excluded from the prompt
 *.
 */
export interface TurnDigest {
  turnId: string;
  /** ISO-8601. */
  createdAt: string;
  summary: string;
  entities: EntityRef[];
  /** Measured, not estimated — this is what budget enforcement subtracts. */
  tokenCost: number;
  superseded: boolean;
}

/** "We agreed X." Never dropped by budget degradation. */
export interface DecisionNote {
  id: string;
  /** ISO-8601. */
  createdAt: string;
  /** Slack user id of whoever made the call. */
  decidedBy: string;
  statement: string;
}

/**
 * Working memory for one thread, replacing the single prose summary
 * that was overwritten each turn.
 *
 * `renderThreadState(state, budget)` degrades gracefully: oldest digests go
 * first, and `decisions` and `openQuestions` are never dropped.
 */
export interface ThreadState {
  /** `${channel}:${threadTs}`. */
  threadKey: string;
  entities: EntityRef[];
  /** Newest-first. */
  digests: TurnDigest[];
  /** Unanswered asks; survives across turns. */
  openQuestions: string[];
  decisions: DecisionNote[];
  /** Spec sessions only. */
  coverage?: CoverageRecord;
  /** Measured size of the rendered pack. */
  tokenCost: number;
}

/**
 * A hard cap, sourced from `config/memory-policy.yaml: maxMemoryTokens` and
 * enforced in code. Memory must pay for itself — an unbounded dump is the
 * cost risk this budget exists to prevent.
 */
export interface TokenBudget {
  maxTokens: number;
}

/**
 * Whether a recalled fact is the one that currently holds, or a record of what
 * used to hold before something replaced it.
 *
 * Both are returned. A superseded fact is not deleted, because "we used to
 * release off `release/integration-*` and it stopped working" is the answer to
 * a question a superseding write cannot answer on its own. The distinction is
 * carried explicitly rather than left for the reader to infer from dates,
 * because the reader is a language model and it will infer wrongly.
 */
export type MemoryTemporalStatus = "current" | "historical";

/** What to recall. Retrieval blends relevance, recency and importance. */
export interface RecallQuery {
  query: string;
  /** Omit to search org-visible memory only. */
  scope?: MemoryScope;
  /** Required when `scope` is "user" — the only principal that may recall it. */
  subjectUserId?: string;
  threadKey?: string;
  kinds?: MemoryEpisodeKind[];
  entityType?: MemoryEntityType;
  entityId?: string;
  limit?: number;
  /**
   * Restrict recall to this thread plus thread-independent standing facts,
   * excluding episodes recorded against any other thread.
   *
   * Off by default, because a thread is a unit of RELEVANCE and not of
   * permission: experience earned in one thread should be usable in the next,
   * ranked below this thread's own material rather than hidden from it. This
   * exists for the caller that genuinely needs isolation — replaying a single
   * thread, or diagnosing what one thread alone could see — and never as a
   * privacy control, which is what `scope` and `subjectUserId` are for.
   *
   * Ignored unless `threadKey` is set; there is nothing to be "same" as.
   */
  sameThreadOnly?: boolean;
  /**
   * Drop facts something later superseded, returning only what currently
   * holds.
   *
   * Off by default: an unresolved disagreement must stay visible from both
   * sides, and "this changed on the 4th" is frequently the point of the
   * question. Set it when the caller needs the current state and nothing else.
   */
  currentOnly?: boolean;
}

/** A recalled episode, as returned inside a pack. */
export interface MemoryEpisodeRecord {
  id: string;
  scope: MemoryScope;
  subjectUserId?: string;
  kind: MemoryEpisodeKind;
  threadKey?: string;
  entityType?: MemoryEntityType;
  entityId?: string;
  content: string;
  importance: number;
  confidence: number;
  provenance: Record<string, unknown>;
  /** ISO-8601. */
  createdAt: string;
  /**
   * Derived on read, not stored: "historical" exactly when something
   * superseded this. Present on every recalled episode so a renderer never has
   * to reconstruct it from `supersededById` being set.
   */
  temporalStatus?: MemoryTemporalStatus;
  /** The episode that replaced this one, when one did. */
  supersededById?: string;
  /** ISO-8601. When the replacement was recorded. */
  supersededAt?: string;
  /**
   * ISO-8601. When the fact started holding, where that differs from when it
   * was recorded — "from Monday we branch off qa", said on the Friday.
   * Defaults to `createdAt` on read when unset.
   */
  validFrom?: string;
  /** ISO-8601. When the fact stopped holding. Set when it is superseded. */
  validUntil?: string;
}

/**
 * The budget-capped result of a recall. `tokenCost` never exceeds
 * `budget.maxTokens`; when content was dropped to stay under it, `truncated`
 * is true so the caller can say so rather than silently losing context.
 */
export interface MemoryPack {
  episodes: MemoryEpisodeRecord[];
  digests: TurnDigest[];
  decisions: DecisionNote[];
  /** The prompt-ready block, already budget-trimmed. */
  rendered: string;
  tokenCost: number;
  budget: TokenBudget;
  truncated: boolean;
}

/** The write side. Mirrors the writable half of the `MemoryEpisode` model. */
export interface MemoryEpisodeInput {
  scope: MemoryScope;
  /** Required when `scope` is "user". */
  subjectUserId?: string;
  kind: MemoryEpisodeKind;
  threadKey?: string;
  entityType?: MemoryEntityType;
  entityId?: string;
  content: string;
  importance?: number;
  confidence?: number;
  /** Turn ref, tool, actor. */
  provenance?: Record<string, unknown>;
  expiresAt?: string;
  /**
   * Ids of episodes this one replaces. Marking them is the write's job and not
   * a later sweep's, so "use branch B" and "branch A is no longer current"
   * cannot end up as two facts that both read as true.
   *
   * Explicit rather than inferred. Auto-superseding anything that merely looks
   * similar would let one person's statement silently erase another's, so an
   * unresolved conflict stays visible until somebody resolves it.
   */
  supersedes?: string[];
  /**
   * ISO-8601. When the fact starts holding, where that is not "now" — a rule
   * announced on Friday to take effect on Monday. Defaults to the write time.
   */
  validFrom?: string;
}

/**
 * The single seam between the memory subsystem and everything else.
 * `@lexi/memory` implements it; no other package imports its internals.
 */
export interface MemoryPort {
  recall(q: RecallQuery, budget: TokenBudget): Promise<MemoryPack>;
  remember(episode: MemoryEpisodeInput): Promise<void>;
  threadState(threadKey: string): Promise<ThreadState>;
}
