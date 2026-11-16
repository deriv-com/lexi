import type { ToolResultContent } from "../tools/agent-tool";

/**
 * Keeps tool results inside what one model request can hold.
 *
 * Two limits apply. A per-result cap stops one large read (a whole file, a long
 * log) from crowding out everything else, and a per-turn cap stops many
 * individually reasonable results from adding up to a request the model cannot
 * accept. The turn cap decreases as results arrive, so later results trim
 * harder than earlier ones.
 *
 * Trimming is never silent. A shortened result carries a note saying how much
 * was kept and what was dropped, because a clipped result the model cannot
 * tell from a complete one gets reported as if it were complete: a file read
 * whose contents were dropped reads as an empty file.
 */
export interface ContextBudget {
  readonly maxResultChars: number;
  readonly maxTurnChars: number;
  remainingChars: number;
}

export function createContextBudget(maxResultChars: number, maxTurnChars: number): ContextBudget {
  return { maxResultChars, maxTurnChars, remainingChars: maxTurnChars };
}

/**
 * Below this many characters there is no room for a useful excerpt, so the
 * turn's budget counts as spent.
 */
export const MIN_USEFUL_RESULT_CHARS = 400;

/** The cap for the next result: the per-result ceiling or what the turn has left. */
export function nextResultCap(budget: ContextBudget): number {
  return Math.max(0, Math.min(budget.maxResultChars, budget.remainingChars));
}

export function isBudgetExhausted(budget: ContextBudget): boolean {
  return budget.remainingChars < MIN_USEFUL_RESULT_CHARS;
}

/**
 * Keys that say whether something happened. They are kept whole however little
 * budget remains: dropping one changes what the result means, not just its size.
 */
const ALWAYS_PRESERVE_KEYS = new Set([
  "ok",
  "error",
  "found",
  "empty",
  "available",
  "executed",
  "blocked",
  "authorized",
  "reason",
  "status",
  "truncated",
]);

/**
 * Survival order for everything else: lower index lasts longer. The payload the
 * caller asked for ranks first; description of that payload ranks after it.
 * Unlisted keys come last.
 */
const FIELD_PRIORITY = [
  "contents",
  "content",
  "text",
  "body",
  "matches",
  "results",
  "items",
  "summary",
  "id",
  "number",
  "name",
  "title",
  "state",
  "url",
];

function priorityRank(key: string): number {
  const index = FIELD_PRIORITY.indexOf(key);
  return index === -1 ? FIELD_PRIORITY.length : index;
}

function shrinkValueToFit(value: unknown, budget: number): unknown {
  if (budget <= 0) return undefined;
  const full = JSON.stringify(value);
  if (full === undefined) return undefined;
  if (full.length <= budget) return value;

  if (typeof value === "string") {
    if (budget < 20) return undefined;
    return `${value.slice(0, budget - 3)}…`;
  }
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    let used = 2;
    for (const item of value) {
      const itemChars = (JSON.stringify(item) ?? "null").length + (kept.length > 0 ? 1 : 0);
      if (used + itemChars > budget) break;
      kept.push(item);
      used += itemChars;
    }
    return kept.length > 0 ? kept : undefined;
  }
  if (value && typeof value === "object") {
    const nested = compactByPriority(value as Record<string, unknown>, budget);
    return Object.keys(nested.compacted).length > 0 ? nested.compacted : undefined;
  }
  return undefined;
}

/**
 * Shrinks an object to roughly `maxChars` of JSON: preserved keys stay whole,
 * the rest are added in priority order, shortened or dropped as space runs out.
 * Dropped and shortened keys are returned by name so the caller can say so.
 */
export function compactByPriority(
  data: Record<string, unknown>,
  maxChars: number,
): { compacted: Record<string, unknown>; omittedKeys: string[]; shortenedKeys: string[] } {
  const compacted: Record<string, unknown> = {};
  const rest: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(data)) {
    if (ALWAYS_PRESERVE_KEYS.has(key)) compacted[key] = value;
    else rest.push([key, value]);
  }
  rest.sort((a, b) => priorityRank(a[0]) - priorityRank(b[0]));

  const omittedKeys: string[] = [];
  const shortenedKeys: string[] = [];
  let used = JSON.stringify(compacted).length;
  for (const [index, [key, value]] of rest.entries()) {
    if (used >= maxChars) {
      omittedKeys.push(...rest.slice(index).map(([remaining]) => remaining));
      break;
    }
    // Leave room for the key itself and its separators.
    const fitted = shrinkValueToFit(value, maxChars - used - key.length - 4);
    if (fitted === undefined) {
      omittedKeys.push(key);
      continue;
    }
    if (JSON.stringify(fitted) !== JSON.stringify(value)) shortenedKeys.push(key);
    compacted[key] = fitted;
    used = JSON.stringify(compacted).length;
  }
  return { compacted, omittedKeys, shortenedKeys };
}

export interface FittedResult {
  content: ToolResultContent;
  truncated: boolean;
  originalChars: number;
  retainedChars: number;
}

/** Characters of text a result carries. Images are not counted as text. */
export function contentChars(content: ToolResultContent): number {
  if (typeof content === "string") return content.length;
  return content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
}

/**
 * Trims a tool result to `cap` characters and charges what was kept to the
 * turn budget. JSON objects are compacted by key priority; other text keeps
 * its beginning. Either way an explicit note says what happened.
 */
export function fitToolResult(content: ToolResultContent, budget: ContextBudget): FittedResult {
  const cap = nextResultCap(budget);
  const originalChars = contentChars(content);

  if (originalChars <= cap) {
    budget.remainingChars = Math.max(0, budget.remainingChars - originalChars);
    return { content, truncated: false, originalChars, retainedChars: originalChars };
  }

  let fitted: ToolResultContent;
  if (typeof content === "string") {
    fitted = fitText(content, cap);
  } else {
    // Share the cap across the text parts in order; images pass through.
    let remaining = cap;
    fitted = content.map((part) => {
      if (part.type !== "text") return part;
      const text = remaining > 0 ? fitText(part.text, remaining) : omittedNote(part.text.length);
      remaining -= Math.min(part.text.length, remaining);
      return { type: "text" as const, text };
    });
  }

  const retainedChars = contentChars(fitted);
  budget.remainingChars = Math.max(0, budget.remainingChars - retainedChars);
  return { content: fitted, truncated: true, originalChars, retainedChars };
}

function omittedNote(originalChars: number): string {
  return (
    `[Result omitted by the runtime: it was ${originalChars} characters and this turn's tool-result budget is spent. ` +
    `Nothing from it is shown, so do not treat it as empty.]`
  );
}

function fitText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  if (cap < MIN_USEFUL_RESULT_CHARS) return omittedNote(text.length);

  // Reserve room for the note so the result stays within the cap.
  const noteReserve = 260;
  const room = Math.max(0, cap - noteReserve);

  const parsed = parseObject(text);
  const compaction = parsed ? compactByPriority(parsed, room) : undefined;
  // Preserved keys are never shortened, so a huge one can still overflow; fall
  // back to keeping the beginning of the text in that case.
  if (compaction && JSON.stringify(compaction.compacted).length <= room) {
    const { compacted, omittedKeys, shortenedKeys } = compaction;
    const details = [
      omittedKeys.length > 0 ? `dropped: ${omittedKeys.join(", ")}` : "",
      shortenedKeys.length > 0 ? `shortened: ${shortenedKeys.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    return (
      `${JSON.stringify(compacted)}\n` +
      `[Truncated by the runtime: the result was ${text.length} characters${details ? ` (${details})` : ""}. ` +
      `What is shown is partial; ask for a narrower slice if you need the rest.]`
    );
  }

  return (
    `${text.slice(0, room)}\n` +
    `[Truncated by the runtime: showing the first ${room} of ${text.length} characters. ` +
    `What is shown is partial; ask for a narrower slice if you need the rest.]`
  );
}

function parseObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
