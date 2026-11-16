/**
 * Model escalation ladder.
 *
 * Coordination is deterministic code plus a capable model; EXECUTION (the
 * build runs) is ~85% of programme cost, so that is the layer to tier. Rather
 * than guessing which tasks a cheaper model can handle, let the evidence gate
 * decide: attempt 1 runs on the first rung, each retry escalates, and the
 * last rung repeats. A cheaper rung costs retries, never correctness — the
 * gate never relaxes and the attempt cap turns "couldn't" into a handback.
 */

export interface ModelLadderInput {
  /** Rung 0 = attempt 1. Empty → undefined (runner default). */
  ladder: string[];
  /** Per-kind override of the FIRST rung only; retries still climb. */
  byTaskKind?: Record<string, string>;
  taskKind: string;
  /** 1-based. */
  attempt: number;
}

export function modelForAttempt(input: ModelLadderInput): string | undefined {
  const attempt = Math.max(1, Math.floor(input.attempt));
  const override = input.byTaskKind?.[input.taskKind];
  if (attempt === 1 && override) return override;
  if (input.ladder.length === 0) return override;
  // An override that is itself a rung means "start at that rung": retries
  // continue from there rather than restarting the ladder beneath it.
  const start = override ? Math.max(0, input.ladder.indexOf(override)) : 0;
  const index = Math.min(input.ladder.length - 1, start + attempt - 1);
  return input.ladder[index];
}
