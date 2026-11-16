import { randomUUID } from "node:crypto";
import type { ThreadState, TurnDigest, TokenBudget } from "@lexi/contracts";
import type { MemoryPolicy } from "../memory-policy.schema";
import { estimateTokens } from "../token-estimate";
import { partitionForCompaction, promoteProtected, type ProtectedClass } from "../working/protected-content";

/**
 * Hierarchical buffer.
 *
 * When a thread's digests exceed budget, the oldest are folded into a single
 * summary digest and the originals are marked superseded: still in Postgres so
 * a conversation can be replayed, out of the prompt so it stays affordable.
 *
 * Three constraints shape this:
 *  - **Only on demand.** Compression runs when the budget is actually
 *    exceeded, never on a timer. A scheduled summariser would spend model
 *    tokens on threads that were never over budget, which spends money for
 *    nothing.
 *  - **Never lossy on failure.** If the summariser errors, the thread is
 *    returned untouched. Being over budget is recoverable next turn; losing
 *    thirty turns of history is not.
 *  - **Never lossy on the things that must be exact.** Authorization state,
 *    mission completion state and pending destructive-action decisions are
 *    partitioned out before the summariser is called and promoted verbatim
 *    into the never-dropped fields — see `working/protected-content.ts` for
 *    the three failure modes that rule exists to prevent. The summariser is
 *    never shown them, so the lossy prose cannot be produced in the first
 *    place.
 *
 * The summariser is injected rather than imported: it runs on the cheap model
 * and the model client lives in another package. This package stays free
 * of any model dependency.
 */

/** Compresses a run of digests into one summary line. Runs on the cheap model. */
export type DigestSummariser = (digests: TurnDigest[]) => Promise<string>;

/**
 * Projection version stamped into every summary digest's id.
 *
 * The raw digest rows are the recovery source and the summary a
 * *derived* view, which is only true in practice if a derived view can be
 * identified and re-derived. Bump this whenever the summarisation prompt or
 * the partition rules change in a way that makes older summaries untrustworthy
 * — the version travels on the row, so a re-derivation pass can find exactly
 * the projections that predate the change instead of re-summarising every
 * thread in the corpus.
 */
export const SUMMARY_PROJECTION_VERSION = 1;

/** `summary-v1-<uuid>`. Matches the `summary-` prefix earlier code asserts on. */
const SUMMARY_ID_PREFIX = `summary-v${SUMMARY_PROJECTION_VERSION}-`;

/** True for a digest this module produced, at any projection version. */
export function isSummaryDigest(digest: TurnDigest): boolean {
  return digest.turnId.startsWith("summary-");
}

export interface CompactionResult {
  state: ThreadState;
  /** False when nothing needed doing, or when the summariser failed. */
  compacted: boolean;
  /** How many digests were folded away, protected ones included. */
  compressed: number;
  /**
   * How many entries were promoted into `decisions` / `openQuestions` because
   * they could not be safely paraphrased. Zero is the common case.
   */
  promoted: number;
  /** Which protection classes fired, for the compaction log line. */
  guardedBy: ProtectedClass[];
}

/** Live digests kept after a compaction, as a share of the policy threshold. */
const KEEP_RATIO = 0.5;

/** Share of the budget held back for the summary digest that replaces the rest. */
const SUMMARY_RESERVE_RATIO = 0.2;

export class HierarchicalBuffer {
  constructor(
    private readonly policy: MemoryPolicy,
    private readonly summarise: DigestSummariser,
  ) {}

  /**
   * Compresses the oldest digests if — and only if — the thread is over
   * budget. Returns the state unchanged, and calls nothing, when it is not.
   */
  async compactIfNeeded(state: ThreadState, budget: TokenBudget): Promise<CompactionResult> {
    const pruned = this.pruneExpiredSuperseded(state);
    const live = pruned.digests.filter((digest) => !digest.superseded);

    if (!this.needsCompaction(live, budget)) {
      return unchanged(pruned);
    }

    // Digests are newest-first, so the tail is the oldest — exactly what gets
    // folded away.
    const toCompress = live.slice(this.keepCount(live, budget));

    if (toCompress.length === 0) {
      return unchanged(pruned);
    }

    // Partition BEFORE the model call, not after. The point is not to filter a
    // summary afterwards — by then the lossy prose exists and something has to
    // decide whether to trust it. The summariser simply never sees this
    // content.
    const { lossy, guarded } = partitionForCompaction(toCompress);

    let summaryDigest: TurnDigest | undefined;

    if (lossy.length > 0) {
      let summary: string;
      try {
        summary = await this.summarise(lossy);
      } catch {
        // Over budget is a cost problem; losing history is a correctness one.
        // Prefer the cost problem. Nothing is promoted either: a half-applied
        // compaction would leave promoted decisions duplicating digests that
        // are still live, and the next attempt would have to reason about
        // which of the two states it was resuming from.
        return unchanged(pruned);
      }

      if (!summary.trim()) {
        return unchanged(pruned);
      }

      // Dated to the oldest turn it covers, so chronological ordering still
      // reads correctly after compaction. `lossy` preserves the newest-first
      // order of its source, so its tail is its oldest member.
      const oldest = lossy[lossy.length - 1];

      summaryDigest = {
        turnId: `${SUMMARY_ID_PREFIX}${randomUUID()}`,
        createdAt: oldest.createdAt,
        summary,
        // Entities outlive the digests that mentioned them: they are the index
        // the model uses to know what the thread is about, and they are cheap.
        entities: dedupeEntities(lossy),
        tokenCost: estimateTokens(summary),
        superseded: false,
      };
    }

    // Promotion runs only once the lossy half has actually succeeded, so a
    // compaction is all-or-nothing.
    const { state: promotedState, promoted } = promoteProtected(pruned, guarded);

    const compressedIds = new Set(toCompress.map((digest) => digest.turnId));
    const digests: TurnDigest[] = [
      ...promotedState.digests.map((digest) =>
        compressedIds.has(digest.turnId) && !digest.superseded ? { ...digest, superseded: true } : digest,
      ),
      ...(summaryDigest ? [summaryDigest] : []),
    ];

    return {
      state: { ...promotedState, digests },
      compacted: true,
      compressed: toCompress.length,
      promoted,
      guardedBy: [...new Set(guarded.map((entry) => entry.reason))],
    };
  }

  /**
   * How many of the newest digests survive a compaction.
   *
   * Both triggers get a say, and the tighter one wins. Using the count rule
   * alone would be a no-op on a short thread of very large digests: ten turns
   * is under the count threshold, so nothing would be compressed even though
   * the thread is far over its token budget — compaction would report success
   * and change nothing. So the newest digests are also walked against the
   * budget, reserving room for the summary digest that replaces the rest.
   *
   * Zero is a legitimate answer: a thread whose newest single digest already
   * blows the budget should be compressed in full.
   */
  private keepCount(live: TurnDigest[], budget: TokenBudget): number {
    const byCount = Math.floor(this.policy.budgets.maxDigestsBeforeCompaction * KEEP_RATIO);

    const ceiling = budget.maxTokens - Math.ceil(budget.maxTokens * SUMMARY_RESERVE_RATIO);
    let used = 0;
    let byBudget = 0;
    for (const digest of live) {
      if (used + digest.tokenCost > ceiling) break;
      used += digest.tokenCost;
      byBudget += 1;
    }

    return Math.min(byCount, byBudget);
  }

  /**
   * Either signal trips compaction: too many turns to render, or too many
   * tokens to afford. Both are measured, neither is a clock.
   */
  private needsCompaction(live: TurnDigest[], budget: TokenBudget): boolean {
    if (live.length > this.policy.budgets.maxDigestsBeforeCompaction) return true;
    const cost = live.reduce((sum, digest) => sum + digest.tokenCost, 0);
    return cost > budget.maxTokens;
  }

  /**
   * Superseded digests are kept for replay, but not forever — policy
   * `retention.supersededDigestDays` bounds how long a compressed turn stays
   * on the row.
   */
  private pruneExpiredSuperseded(state: ThreadState): ThreadState {
    const cutoff = Date.now() - this.policy.retention.supersededDigestDays * 86_400_000;
    const digests = state.digests.filter((digest) => {
      if (!digest.superseded) return true;
      return new Date(digest.createdAt).getTime() >= cutoff;
    });

    return digests.length === state.digests.length ? state : { ...state, digests };
  }
}

/**
 * The "nothing happened" result, in one place.
 *
 * Every early return has to be identical, because a caller reading
 * `compacted: false` alongside a non-zero `promoted` would have no way to know
 * whether the promotion had been persisted. There is exactly one shape for
 * "the state you passed in is the state you get back".
 */
function unchanged(state: ThreadState): CompactionResult {
  return { state, compacted: false, compressed: 0, promoted: 0, guardedBy: [] };
}

/** Entities mentioned in the compressed span survive their digests. */
function dedupeEntities(digests: TurnDigest[]): TurnDigest["entities"] {
  const merged = new Map<string, TurnDigest["entities"][number]>();
  for (const digest of digests) {
    for (const entity of digest.entities) merged.set(`${entity.type}:${entity.id}`, entity);
  }
  return [...merged.values()];
}
