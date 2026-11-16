import { randomUUID } from "node:crypto";
import type { ThreadState, TurnDigest, DecisionNote } from "@lexi/contracts";

/**
 * What compaction is not allowed to paraphrase.
 *
 * The hierarchical buffer's job is to trade fidelity for tokens: thirty turns
 * become one sentence. That trade is correct for chatter and wrong for three
 * kinds of content, because for these the *exact* claim is the whole value:
 *
 *  - **Authorization state.** "U123 approved the force-push" and "someone
 *    approved a force-push" are different facts, and memory grants no
 *    permission. A summary that reads like an approval is worse than no
 *    memory at all: it invites the model to treat recalled prose as a gate
 *    that was passed. The prose must never exist.
 *  - **Mission completion state.** "PR #203 merged" compressed into "worked on
 *    the deposit bug" is how Lexi ends up re-dispatching a fix that already
 *    shipped, or telling someone work is outstanding when it landed an hour
 *    ago.
 *  - **Pending destructive-action decisions.** An unresolved "waiting on
 *    approval to delete the branch" is a commitment. Summarised away, the
 *    thread forgets it owes someone an answer, and the next turn either asks
 *    again or — worse — proceeds as though the answer had come.
 *
 * So compaction partitions before it summarises. Protected digests are held
 * out of the lossy path entirely and promoted verbatim into the two fields
 * `renderThreadState` is forbidden to drop (`decisions`, `openQuestions`).
 * Nothing here deletes a raw digest: the digest rows remain the recovery
 * source, superseded rather than removed, exactly as before.
 *
 * The classifier is deterministic and model-free, per the deterministic-first rule that
 * structured outcomes are extracted by plain code. It is also deliberately a
 * *backstop*: the turn-end writer in `ThreadStateService.recordTurnState`
 * already promotes these facts at source, where it still knows the actor. This
 * file is what makes the guarantee hold for digests written by any other path,
 * including rows written by an earlier version of the code.
 */

/** Why a digest may not be paraphrased. */
export type ProtectedClass = "authorization" | "completion" | "pending_destructive";

/** A protected digest and the class that protected it. */
export interface ProtectedDigest {
  digest: TurnDigest;
  reason: ProtectedClass;
}

/** The two halves compaction treats differently. */
export interface CompactionPartition {
  /** Safe to paraphrase — the only digests a summariser ever sees. */
  lossy: TurnDigest[];
  /** Held out of the summariser and promoted verbatim. */
  guarded: ProtectedDigest[];
}

/**
 * `decidedBy` when a digest carries no attribution.
 *
 * NOT a Slack user id, and named so it cannot be mistaken for one: rendering
 * it produces "(unattributed)", which reads as missing provenance rather than
 * as a person. A digest is `{turnId, summary, entities}` — the contract has
 * nowhere to put an actor — so a promoted decision can only be attributed when
 * the producer wrote the actor into the summary in the form this module emits
 * and `ATTRIBUTION` below reads back.
 */
export const UNATTRIBUTED = "unattributed";

/**
 * The attribution prefix `recordTurnState` writes and promotion reads back:
 * `(U123) dispatched a direct fix for #101`.
 *
 * A convention rather than a contract field because `TurnDigest` is frozen in
 * `@lexi/contracts` and widening it would oblige every implementer for
 * the sake of one optional string. Unparsed, the digest still reads correctly
 * to a human and to the model — the prefix is just a parenthesised id.
 */
const ATTRIBUTION = /^\((U[A-Z0-9]{4,})\)\s+/;

/**
 * A rule matches a digest summary and names what it protects.
 *
 * Precision over recall, on purpose. A false positive is cheap — one more
 * verbatim line in `decisions`, which the renderer will shorten rather than
 * drop — while a false negative silently hands an approval to a summariser.
 * But precision still matters, because promoting ordinary chatter into the
 * never-dropped fields would crowd out the decisions that belong there. So
 * every pattern below is a multi-word phrase or a verb bound to an artefact
 * reference, never a bare keyword like "approved" or "done".
 */
interface ProtectionRule {
  reason: ProtectedClass;
  /** Matched against the digest summary. */
  pattern: RegExp;
  /** Why this phrase is load-bearing, for whoever edits the table next. */
  because: string;
}

const RULES: readonly ProtectionRule[] = [
  // --- Authorization state -------------------------------------------------
  {
    reason: "authorization",
    pattern: /\b(?:approved|authoris(?:ed|ation)|authoriz(?:ed|ation))\b/i,
    because: "Memory grants no permission; recalled prose that reads like a granted permission is the failure this class exists to prevent.",
  },
  {
    reason: "authorization",
    pattern: /\b(?:denied|refused|declined|rejected|vetoed)\b/i,
    because: "A denial is authorization state too; losing it looks like nobody ever said no.",
  },
  {
    reason: "authorization",
    pattern: /\b(?:permission|escalat(?:ed|ion)|override|overrode|opted out|granted access)\b/i,
    because: "Who was escalated to, and what was overridden, is the audit trail for a gate.",
  },

  // --- Mission completion state --------------------------------------------
  {
    reason: "completion",
    pattern: /\b(?:merged|shipped|deployed|released|reverted|rolled back)\b/i,
    because: "Whether work landed decides whether the next turn re-dispatches it.",
  },
  {
    reason: "completion",
    pattern: /\b(?:dispatched|triggered)\b.*#\d+|\bopened PR #\d+|\bclosed #\d+/i,
    because: "A dispatch already made must never be paraphrased into something that reads like a plan.",
  },
  {
    reason: "completion",
    pattern: /\bcorrection on #\d+|\bcorrected\b/i,
    because:
      "A human correcting Lexi is ground truth contradicting something Lexi believed (see deterministic-extractor: importance 0.9). Paraphrasing it re-admits the belief it overturned.",
  },

  // --- Pending destructive-action decisions --------------------------------
  {
    reason: "pending_destructive",
    pattern: /\b(?:awaiting|pending|waiting on|blocked on)\b.{0,40}\b(?:approval|confirmation|sign[- ]?off|decision|go[- ]ahead)\b/i,
    because: "An unresolved commitment the thread owes someone; forgotten, the next turn either re-asks or assumes.",
  },
  {
    reason: "pending_destructive",
    pattern: /\bpending closure\b|\bkept #\d+ open\b|\bcancelled the pending\b/i,
    because:
      "The keep-open / cancel-closure pair are literally recorded decisions (deterministic-extractor kind: decision).",
  },
  {
    reason: "pending_destructive",
    pattern: /\b(?:force[- ]push|delete the branch|drop the (?:table|database)|hard[- ]delete|purge)\b/i,
    because: "Irreversible actions under discussion. Their exact status is the only thing that makes them safe.",
  },
];

/**
 * Names the class protecting a digest, or `null` when it is safe to
 * paraphrase. First match wins, so `RULES` order is the tie-break for a
 * summary that trips two classes.
 */
export function classifyDigestProtection(digest: TurnDigest): ProtectedClass | null {
  const summary = digest.summary ?? "";
  if (!summary.trim()) return null;

  for (const rule of RULES) {
    if (rule.pattern.test(summary)) return rule.reason;
  }
  return null;
}

/**
 * Splits the digests a compaction intends to fold into the half a summariser
 * may see and the half it may not.
 *
 * Order is preserved within each half — the buffer relies on the digest list
 * staying newest-first when it dates the summary digest to the oldest turn it
 * covers.
 */
export function partitionForCompaction(digests: readonly TurnDigest[]): CompactionPartition {
  const lossy: TurnDigest[] = [];
  const guarded: ProtectedDigest[] = [];

  for (const digest of digests) {
    const reason = classifyDigestProtection(digest);
    if (reason) guarded.push({ digest, reason });
    else lossy.push(digest);
  }

  return { lossy, guarded };
}

/** A promotion that was applied, and the promotions that were already there. */
export interface PromotionResult {
  state: ThreadState;
  /** How many new entries were added across both fields. */
  promoted: number;
}

/**
 * Copies protected digests into the fields budget degradation may not drop.
 *
 * `authorization` and `completion` become decisions: they are settled facts
 * about what was allowed or what happened. `pending_destructive` becomes an
 * open question, because that is the field that means "this thread still owes
 * an answer" — and the renderer treats both as protected content.
 *
 * Idempotent by normalised statement, which is what makes a hundred-turn
 * thread with a dozen compactions converge rather than accumulate: the
 * turn-end writer already promoted most of these at source with real
 * attribution, and re-promoting the same text on a later compaction must be a
 * no-op rather than a duplicate.
 */
export function promoteProtected(state: ThreadState, guarded: readonly ProtectedDigest[]): PromotionResult {
  if (guarded.length === 0) return { state, promoted: 0 };

  const decisions = [...state.decisions];
  const openQuestions = [...state.openQuestions];

  const seenDecisions = new Set(decisions.map((decision) => normalise(decision.statement)));
  const seenQuestions = new Set(openQuestions.map(normalise));

  let promoted = 0;

  // Oldest first, so promoted entries read in the order they happened even
  // though the digest buffer is newest-first.
  for (const { digest, reason } of [...guarded].reverse()) {
    const { actor, statement } = splitAttribution(digest.summary);
    if (!statement) continue;

    if (reason === "pending_destructive") {
      const key = normalise(statement);
      if (seenQuestions.has(key)) continue;
      seenQuestions.add(key);
      openQuestions.push(statement);
      promoted += 1;
      continue;
    }

    const key = normalise(statement);
    if (seenDecisions.has(key)) continue;
    seenDecisions.add(key);
    decisions.push({
      id: randomUUID(),
      // Dated to the turn it came from, not to the compaction that moved it —
      // a promoted decision must not look like it was taken just now.
      createdAt: digest.createdAt,
      decidedBy: actor ?? UNATTRIBUTED,
      statement,
    } satisfies DecisionNote);
    promoted += 1;
  }

  if (promoted === 0) return { state, promoted: 0 };
  return { state: { ...state, decisions, openQuestions }, promoted };
}

/**
 * Formats a digest summary so promotion can attribute it later. Used by the
 * turn-end writer; see `ATTRIBUTION`.
 */
export function withAttribution(actorUserId: string | undefined, summary: string): string {
  const trimmed = summary.trim();
  if (!actorUserId || !/^U[A-Z0-9]{4,}$/.test(actorUserId)) return trimmed;
  return `(${actorUserId}) ${trimmed}`;
}

/** Lifts the `(U123)` prefix back off, leaving the statement readable alone. */
function splitAttribution(summary: string): { actor?: string; statement: string } {
  const raw = (summary ?? "").trim();
  const match = ATTRIBUTION.exec(raw);
  if (!match) return { statement: raw };
  return { actor: match[1], statement: raw.slice(match[0].length).trim() };
}

/**
 * Dedup key. Case- and whitespace-insensitive because the same fact reaches
 * this function from two producers — the turn-end writer and the compaction
 * backstop — and they must agree that it is one fact.
 */
function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}
