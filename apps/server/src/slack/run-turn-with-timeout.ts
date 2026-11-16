import type { AgentTurnRunner, TurnInput, TurnResult } from "@lexi/agent";

/**
 * Runs one agent turn under a wall-clock limit without discarding its answer.
 *
 * The tempting implementation — race the turn against a timer and post a
 * "took too long" reply when the timer wins — leaves the turn running and then
 * throws away the answer it eventually produces. Here the timer instead aborts
 * the turn through its `AbortSignal` and waits for the runner to return; the
 * runner is expected to stop at its next checkpoint and hand back what it has,
 * and that is what gets posted.
 *
 * A runner can be stuck somewhere an abort cannot reach (a tool call that
 * ignores the signal). After `abortGraceMs` a timeout notice is returned so the
 * thread is not left hanging, and if a real answer still arrives later it is
 * passed to `onLateResult` rather than dropped.
 */

export const TURN_TIMEOUT_REPLY =
  "That took too long and I had to stop. Ask again and I'll pick it up fresh.";

export const TURN_ERROR_REPLY =
  "Something went wrong while I was working on that, and nothing was changed as a result. Please try again.";

export interface TimedTurnOptions {
  timeoutMs: number;
  abortGraceMs: number;
  /** A model answer that arrived after the timeout notice was already returned. */
  onLateResult?: (result: TurnResult) => void;
}

export interface TimedTurnOutcome {
  /** What to post. Its `text` is never empty. */
  result: TurnResult;
  /** The wall clock passed and the turn was aborted. */
  timedOut: boolean;
  /** The runner had not returned by the end of the grace period. */
  detached: boolean;
  /** Set when the runner threw. Never shown to the user. */
  error?: unknown;
}

type Settled = { kind: "result"; result: TurnResult } | { kind: "error"; error: unknown };

export async function runTurnWithTimeout(
  runner: AgentTurnRunner,
  input: TurnInput,
  options: TimedTurnOptions,
): Promise<TimedTurnOutcome> {
  const startedAt = Date.now();
  const controller = new AbortController();

  let work: Promise<Settled>;
  try {
    work = runner.runTurn(input, { signal: controller.signal }).then(
      (result): Settled => ({ kind: "result", result }),
      (error: unknown): Settled => ({ kind: "error", error }),
    );
  } catch (error) {
    // A runner that throws synchronously instead of rejecting.
    work = Promise.resolve({ kind: "error", error });
  }

  const first = await raceWithTimer(work, options.timeoutMs);
  if (first !== TIMER) return settle(first, false, startedAt);

  controller.abort(new Error(`Turn exceeded ${options.timeoutMs}ms`));
  const second = await raceWithTimer(work, options.abortGraceMs);
  if (second !== TIMER) return settle(second, true, startedAt);

  void work.then((late) => {
    if (late.kind === "result" && late.result.outcome === "answered" && late.result.text.trim()) {
      options.onLateResult?.(late.result);
    }
  });
  return {
    result: synthetic("timeout", TURN_TIMEOUT_REPLY, startedAt),
    timedOut: true,
    detached: true,
  };
}

const TIMER = Symbol("timer");

async function raceWithTimer<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMER> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<typeof TIMER>((resolve) => {
    handle = setTimeout(() => resolve(TIMER), Math.max(0, ms));
  });
  try {
    return await Promise.race([work, timer]);
  } finally {
    clearTimeout(handle);
  }
}

function settle(settled: Settled, timedOut: boolean, startedAt: number): TimedTurnOutcome {
  if (settled.kind === "error") {
    return {
      result: synthetic(timedOut ? "timeout" : "llm_error", timedOut ? TURN_TIMEOUT_REPLY : TURN_ERROR_REPLY, startedAt),
      timedOut,
      detached: false,
      error: settled.error,
    };
  }
  const { result } = settled;
  if (!result.text || result.text.trim().length === 0) {
    // The contract says text is never empty; an empty post would look like
    // the agent ignored the person.
    return {
      result: { ...result, text: timedOut ? TURN_TIMEOUT_REPLY : TURN_ERROR_REPLY },
      timedOut,
      detached: false,
    };
  }
  return { result, timedOut, detached: false };
}

function synthetic(outcome: TurnResult["outcome"], text: string, startedAt: number): TurnResult {
  return { outcome, text, iterations: 0, toolCalls: [], durationMs: Date.now() - startedAt };
}
