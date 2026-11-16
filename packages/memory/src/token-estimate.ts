/**
 * Token estimation for budget enforcement.
 *
 * Deliberately arithmetic, not a tokenizer call: budget enforcement runs on
 * every turn, and plain code comes first. A real tokenizer would be more
 * accurate and would cost a dependency and CPU on the hot path for a number
 * that only needs to be a safe upper bound.
 *
 * The ~4-characters-per-token approximation matches what
 * `memory-retrieval.service.ts` already uses, so the two halves of the memory
 * subsystem measure in the same unit. Rounding is always **up**: a budget that
 * over-counts trims slightly early, a budget that under-counts blows the cap.
 */

/** Characters per token. Conservative for English prose and code alike. */
const CHARS_PER_TOKEN = 4;

/**
 * Upper-bound token count for a string. Never under-reports — every caller
 * that enforces a cap depends on that direction of error.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Upper-bound token count for an object, measured over its JSON form. */
export function estimateJsonTokens(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return estimateTokens(JSON.stringify(value) ?? "");
  } catch {
    // Circular or otherwise unserialisable: treat as unmeasurable rather than
    // throwing on the hot path. Callers budget defensively against 0.
    return 0;
  }
}
