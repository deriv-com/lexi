import { describe, it, expect, vi, afterEach } from "vitest";
import type { AgentTurnRunner, TurnInput, TurnResult } from "@lexi/agent";
import { runTurnWithTimeout, TURN_ERROR_REPLY, TURN_TIMEOUT_REPLY } from "./run-turn-with-timeout";

const input: TurnInput = {
  actorId: "U0TEST01",
  conversation: { channel: "C0TEST01", threadTs: "1700000000.000100" },
  text: "what is open?",
};

function result(outcome: TurnResult["outcome"], text: string): TurnResult {
  return { outcome, text, iterations: 1, toolCalls: [], durationMs: 5 };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runTurnWithTimeout", () => {
  it("returns the runner's answer when it finishes in time", async () => {
    const runner: AgentTurnRunner = { runTurn: async () => result("answered", "Three issues are open.") };
    const outcome = await runTurnWithTimeout(runner, input, { timeoutMs: 1_000, abortGraceMs: 100 });
    expect(outcome).toMatchObject({ timedOut: false, detached: false });
    expect(outcome.result.text).toBe("Three issues are open.");
  });

  it("aborts the turn through its signal at the timeout and posts what the runner then returns", async () => {
    vi.useFakeTimers();
    let seenSignal: AbortSignal | undefined;
    const runner: AgentTurnRunner = {
      runTurn: (_input, options) =>
        new Promise<TurnResult>((resolve) => {
          seenSignal = options?.signal;
          options?.signal?.addEventListener("abort", () =>
            resolve(result("timeout", "I stopped early. Here is what I found so far: two issues.")),
          );
        }),
    };

    const pending = runTurnWithTimeout(runner, input, { timeoutMs: 1_000, abortGraceMs: 500 });
    await vi.advanceTimersByTimeAsync(999);
    expect(seenSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await pending;

    expect(seenSignal?.aborted).toBe(true);
    expect(outcome).toMatchObject({ timedOut: true, detached: false });
    // The runner's own words, not a canned notice.
    expect(outcome.result.text).toBe("I stopped early. Here is what I found so far: two issues.");
  });

  it("keeps a real answer that lands during the grace period after the abort", async () => {
    vi.useFakeTimers();
    const runner: AgentTurnRunner = {
      // Ignores the signal, but finishes inside the grace period.
      runTurn: () =>
        new Promise<TurnResult>((resolve) => setTimeout(() => resolve(result("answered", "The full answer.")), 1_200)),
    };

    const pending = runTurnWithTimeout(runner, input, { timeoutMs: 1_000, abortGraceMs: 500 });
    await vi.advanceTimersByTimeAsync(1_200);
    const outcome = await pending;
    expect(outcome.result).toMatchObject({ outcome: "answered", text: "The full answer." });
    expect(outcome.timedOut).toBe(true);
  });

  it("returns a notice when the runner ignores the abort, then hands over the late answer instead of dropping it", async () => {
    vi.useFakeTimers();
    const onLateResult = vi.fn();
    const runner: AgentTurnRunner = {
      runTurn: () =>
        new Promise<TurnResult>((resolve) => setTimeout(() => resolve(result("answered", "Late but real.")), 5_000)),
    };

    const pending = runTurnWithTimeout(runner, input, { timeoutMs: 1_000, abortGraceMs: 500, onLateResult });
    await vi.advanceTimersByTimeAsync(1_500);
    const outcome = await pending;
    expect(outcome).toMatchObject({ timedOut: true, detached: true });
    expect(outcome.result.text).toBe(TURN_TIMEOUT_REPLY);
    expect(onLateResult).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_500);
    expect(onLateResult).toHaveBeenCalledWith(expect.objectContaining({ text: "Late but real." }));
  });

  it("turns a runner error into a generic reply and reports the error separately", async () => {
    const failure = new Error("upstream 500 with internal detail");
    const runner: AgentTurnRunner = {
      runTurn: async () => {
        throw failure;
      },
    };
    const outcome = await runTurnWithTimeout(runner, input, { timeoutMs: 1_000, abortGraceMs: 100 });
    expect(outcome.result.text).toBe(TURN_ERROR_REPLY);
    expect(outcome.result.text).not.toContain("internal detail");
    expect(outcome.error).toBe(failure);
  });

  it("never returns empty text", async () => {
    const runner: AgentTurnRunner = { runTurn: async () => result("answered", "   ") };
    const outcome = await runTurnWithTimeout(runner, input, { timeoutMs: 1_000, abortGraceMs: 100 });
    expect(outcome.result.text.trim().length).toBeGreaterThan(0);
  });
});
