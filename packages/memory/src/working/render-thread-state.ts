import type { ThreadState, TokenBudget, TurnDigest, EntityRef } from "@lexi/contracts";
import { estimateTokens } from "../token-estimate";

/**
 * Budget-aware rendering of working memory.
 *
 * Two rules govern this file and they pull against each other:
 *   1. the rendered pack must stay under budget, and
 *   2. `decisions` and `openQuestions` are never dropped.
 *
 * Normally both hold trivially — oldest digests are shed until the pack fits.
 * When the protected content *alone* exceeds the budget they cannot both hold
 * literally, so the tie-break is: every protected item stays **present** and is
 * visibly shortened, rather than some items vanishing silently. A shortened
 * decision still tells the model a decision was made and roughly what it was;
 * a dropped one tells it nothing and looks like it never happened.
 */

/** What `renderThreadState` produced, and what it cost to get there. */
export interface RenderedThreadState {
  /** The prompt-ready block. Empty when there is nothing to say. */
  text: string;
  /** Measured cost of `text`. Never exceeds `budget.maxTokens`. */
  tokenCost: number;
  /** True when any content was shed or shortened to fit. */
  truncated: boolean;
  /** How many digests were left out — the cheapest thing to lose. */
  droppedDigests: number;
}

const HEADER = "[Thread memory]";
const CHARS_PER_TOKEN = 4;
const ELLIPSIS = "…";

/**
 * Below this a truncated line carries no meaning, so it is better to say "N
 * more omitted" than to emit a dozen one-word stubs.
 */
const MIN_ITEM_CHARS = 16;

/**
 * A budget in tokens converts to an exact character ceiling because
 * `estimateTokens` is `ceil(len / 4)`: `ceil(len/4) <= T` exactly when
 * `len <= 4T`. Working in characters keeps the packing loop exact and cheap.
 */
function charCeiling(maxTokens: number): number {
  return Math.max(0, Math.floor(maxTokens)) * CHARS_PER_TOKEN;
}

/** Characters a `\n`-joined block will occupy, separators included. */
function charCount(lines: string[]): number {
  if (lines.length === 0) return 0;
  return lines.reduce((sum, line) => sum + line.length, 0) + (lines.length - 1);
}

function truncateTo(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= ELLIPSIS.length) return ELLIPSIS.slice(0, maxChars);
  return `${text.slice(0, maxChars - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

function formatEntity(entity: EntityRef): string {
  const label = entity.label ? ` ${entity.label}` : "";
  return `${entity.type}:${entity.id}${label}`;
}

function formatDigest(digest: TurnDigest): string {
  return `- ${digest.createdAt}: ${digest.summary}`;
}

/**
 * Renders `state` into a prompt block that fits `budget`.
 *
 * Degradation order, cheapest loss first: oldest digests, then the entity
 * line, then — only if the protected content still does not fit — shortening
 * of decisions and open questions.
 */
export function renderThreadState(state: ThreadState, budget: TokenBudget): RenderedThreadState {
  // Superseded digests stay in Postgres for replay but never reach the
  // prompt, so they are not candidates and are not counted as "dropped".
  const liveDigests = state.digests.filter((digest) => !digest.superseded);

  const hasContent =
    liveDigests.length > 0 ||
    state.decisions.length > 0 ||
    state.openQuestions.length > 0 ||
    state.entities.length > 0;

  if (!hasContent) {
    return { text: "", tokenCost: 0, truncated: false, droppedDigests: 0 };
  }

  const maxChars = charCeiling(budget.maxTokens);
  if (maxChars <= 0) {
    // No room for even the header. Report the loss rather than pretending.
    return { text: "", tokenCost: 0, truncated: true, droppedDigests: liveDigests.length };
  }

  // Protected content first: it is the last thing to degrade, so it claims its
  // space before anything else is considered.
  const protectedLines: string[] = [];
  if (state.decisions.length > 0) {
    protectedLines.push("Decisions:");
    for (const decision of state.decisions) {
      protectedLines.push(`- (${decision.decidedBy}) ${decision.statement}`);
    }
  }
  if (state.openQuestions.length > 0) {
    protectedLines.push("Open questions:");
    for (const question of state.openQuestions) {
      protectedLines.push(`- ${question}`);
    }
  }

  const baseLines = [HEADER, ...protectedLines];

  if (charCount(baseLines) > maxChars) {
    return renderProtectedOverflow(protectedLines, maxChars, liveDigests.length);
  }

  const lines = [...baseLines];
  let used = charCount(lines);
  let truncated = false;

  // Entities are a cheap, high-value index of what the thread is about, but
  // they are recoverable from the digests, so they yield before digests do.
  if (state.entities.length > 0) {
    const entityLine = `Entities: ${state.entities.map(formatEntity).join(", ")}`;
    if (used + 1 + entityLine.length <= maxChars) {
      lines.push(entityLine);
      used += 1 + entityLine.length;
    } else {
      truncated = true;
    }
  }

  // Digests are newest-first, so walking forward and stopping when the budget
  // runs out drops the OLDEST — exactly the working-memory degradation order.
  const digestLines: string[] = [];
  let kept = 0;
  const headingCost = liveDigests.length > 0 ? 1 + "Recent turns (newest first):".length : 0;
  let digestBudget = maxChars - used - headingCost;

  for (const digest of liveDigests) {
    const line = formatDigest(digest);
    if (digestBudget - (1 + line.length) < 0) break;
    digestLines.push(line);
    digestBudget -= 1 + line.length;
    kept += 1;
  }

  if (digestLines.length > 0) {
    lines.push("Recent turns (newest first):", ...digestLines);
  }

  const droppedDigests = liveDigests.length - kept;
  if (droppedDigests > 0) truncated = true;

  // Final clamp. Every path above is budget-aware, but this is the invariant
  // callers actually depend on, so it is enforced rather than trusted.
  const text = clamp(lines.join("\n"), maxChars);
  return { text, tokenCost: estimateTokens(text), truncated, droppedDigests };
}

/**
 * The protected content does not fit on its own. Keep every item present and
 * shorten it; if even a meaningful stub per item is impossible, keep as many
 * as will read sensibly and state plainly how many were left out.
 */
function renderProtectedOverflow(
  protectedLines: string[],
  maxChars: number,
  liveDigestCount: number,
): RenderedThreadState {
  const headerCost = HEADER.length;
  const available = maxChars - headerCost;

  if (available <= 0) {
    const text = clamp(HEADER, maxChars);
    return { text, tokenCost: estimateTokens(text), truncated: true, droppedDigests: liveDigestCount };
  }

  // Section headings ("Decisions:") are structure, not content; they are kept
  // whole so the shortened items below them stay interpretable.
  const items = protectedLines.filter((line) => line.startsWith("- "));
  const headings = protectedLines.filter((line) => !line.startsWith("- "));
  const headingChars = charCount(headings) + (headings.length > 0 ? 1 : 0);
  const itemBudget = available - headingChars;
  const perItem = items.length > 0 ? Math.floor(itemBudget / items.length) - 1 : 0;

  const lines = [HEADER, ...headings];

  if (perItem >= MIN_ITEM_CHARS) {
    // Every item survives, each visibly shortened.
    for (const item of items) lines.push(truncateTo(item, perItem));
  } else {
    // Not even a readable stub each. Keep what reads, and announce the rest —
    // an omission the caller can see beats a silent one.
    const fit = Math.max(0, Math.floor(itemBudget / (MIN_ITEM_CHARS + 1)));
    const keep = Math.min(fit, items.length);
    for (let i = 0; i < keep; i += 1) lines.push(truncateTo(items[i], MIN_ITEM_CHARS));
    const omitted = items.length - keep;
    if (omitted > 0) lines.push(`(+${omitted} more truncated — memory budget)`);
  }

  const text = clamp(lines.join("\n"), maxChars);
  return { text, tokenCost: estimateTokens(text), truncated: true, droppedDigests: liveDigestCount };
}

/** Hard character clamp — the guarantee the budget contract rests on. */
function clamp(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}
