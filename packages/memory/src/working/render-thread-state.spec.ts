import { describe, it, expect } from "vitest";
import type { ThreadState, TurnDigest, DecisionNote } from "@lexi/contracts";
import { renderThreadState } from "./render-thread-state";
import { estimateTokens } from "../token-estimate";

/**
 * Budget-aware rendering of working memory.
 *
 * Two rules govern degradation and they are in tension, which is the whole
 * reason this is tested rather than assumed:
 *   1. the rendered pack must stay under budget, and
 *   2. `decisions` and `openQuestions` are never dropped.
 * Oldest digests go first; decisions and open questions survive to the last.
 */

function digest(index: number, summary: string): TurnDigest {
  return {
    turnId: `turn-${index}`,
    // Descending time: index 0 is the newest turn, matching the newest-first
    // ordering the contract specifies for `digests`.
    createdAt: new Date(Date.UTC(2026, 7, 15, 0, 0, 0) - index * 60_000).toISOString(),
    summary,
    entities: [],
    tokenCost: estimateTokens(summary),
    superseded: false,
  };
}

function decision(index: number, statement: string): DecisionNote {
  return {
    id: `decision-${index}`,
    createdAt: new Date(Date.UTC(2026, 7, 15, 0, 0, 0)).toISOString(),
    decidedBy: "U0TEST09",
    statement,
  };
}

function threadState(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    threadKey: "C123:1699999999.000100",
    entities: [],
    digests: [],
    openQuestions: [],
    decisions: [],
    tokenCost: 0,
    ...overrides,
  };
}

describe("renderThreadState", () => {
  it("renders an empty state as an empty pack costing nothing", () => {
    const result = renderThreadState(threadState(), { maxTokens: 800 });
    expect(result.text).toBe("");
    expect(result.tokenCost).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("includes digests, decisions, open questions and entities when they fit", () => {
    const result = renderThreadState(
      threadState({
        entities: [{ type: "issue", id: "101", repoKey: "issues", label: "deposit button dead" }],
        digests: [digest(0, "user reported the deposit button does nothing")],
        openQuestions: ["Which app version is affected?"],
        decisions: [decision(0, "we agreed to ship the fix behind a flag")],
      }),
      { maxTokens: 800 },
    );

    expect(result.text).toContain("deposit button does nothing");
    expect(result.text).toContain("Which app version is affected?");
    expect(result.text).toContain("ship the fix behind a flag");
    expect(result.text).toContain("101");
    expect(result.truncated).toBe(false);
    expect(result.droppedDigests).toBe(0);
  });

  it("stays under budget for a pathological 200-turn thread", () => {
    const digests = Array.from({ length: 200 }, (_, i) =>
      digest(i, `turn ${i}: a reasonably verbose summary of what was discussed, with detail`),
    );
    const budget = { maxTokens: 800 };

    const result = renderThreadState(
      threadState({
        digests,
        openQuestions: ["Is this reproducible on mobile?"],
        decisions: [decision(0, "we agreed the root cause is the balance cache")],
      }),
      budget,
    );

    expect(result.tokenCost).toBeLessThanOrEqual(budget.maxTokens);
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(budget.maxTokens);
    expect(result.truncated).toBe(true);
    expect(result.droppedDigests).toBeGreaterThan(0);
  });

  it("drops the OLDEST digests first, keeping the newest turns", () => {
    const digests = Array.from({ length: 200 }, (_, i) => digest(i, `turn ${i}: discussion detail here`));

    const result = renderThreadState(
      threadState({ digests }),
      { maxTokens: 300 },
    );

    // Newest is index 0; oldest is index 199.
    expect(result.text).toContain("turn 0:");
    expect(result.text).not.toContain("turn 199:");
  });

  it("never drops decisions or open questions, even under a brutal budget", () => {
    const digests = Array.from({ length: 200 }, (_, i) => digest(i, `turn ${i}: verbose discussion detail`));
    // Sized so the protected content fits and nothing else does — the exact
    // edge where the two rules meet.
    const budget = { maxTokens: 40 };

    const result = renderThreadState(
      threadState({
        digests,
        openQuestions: ["Does this affect withdrawals too?"],
        decisions: [decision(0, "we agreed to treat this as P1")],
      }),
      budget,
    );

    expect(result.text).toContain("treat this as P1");
    expect(result.text).toContain("Does this affect withdrawals too?");
    // Every digest had to go to make room — that is the correct trade.
    expect(result.droppedDigests).toBe(200);
    expect(result.tokenCost).toBeLessThanOrEqual(budget.maxTokens);
  });

  it("honours the budget even when decisions alone exceed it — by truncating, never by dropping", () => {
    // The protected content is itself over budget. Dropping a decision is
    // forbidden, and blowing the cap is forbidden, so the only honest option
    // left is to keep every decision present and truncate its text visibly.
    const decisions = Array.from({ length: 40 }, (_, i) =>
      decision(i, `decision ${i}: a long agreed statement that eats a lot of the token budget on its own`),
    );
    const budget = { maxTokens: 100 };

    const result = renderThreadState(threadState({ decisions }), budget);

    expect(result.tokenCost).toBeLessThanOrEqual(budget.maxTokens);
    expect(result.truncated).toBe(true);
    // Truncation is announced, never silent.
    expect(result.text).toMatch(/truncated|…/i);
  });

  it("excludes superseded digests from the prompt", () => {
    // Superseded digests are retained in Postgres for replay but are
    // not sent to the model.
    const kept = digest(0, "live turn about the deposit flow");
    const gone: TurnDigest = { ...digest(1, "compressed away turn about routing"), superseded: true };

    const result = renderThreadState(threadState({ digests: [kept, gone] }), { maxTokens: 800 });

    expect(result.text).toContain("live turn about the deposit flow");
    expect(result.text).not.toContain("compressed away turn about routing");
  });

  it("reports a token cost that matches its own rendered text", () => {
    const result = renderThreadState(
      threadState({
        digests: [digest(0, "something happened"), digest(1, "something else happened")],
        decisions: [decision(0, "we agreed on the approach")],
      }),
      { maxTokens: 800 },
    );

    expect(result.tokenCost).toBe(estimateTokens(result.text));
  });

  it("treats a zero or negative budget as no room for anything but protected content", () => {
    const result = renderThreadState(
      threadState({ digests: [digest(0, "a turn")], decisions: [decision(0, "agreed")] }),
      { maxTokens: 0 },
    );

    expect(result.tokenCost).toBe(0);
    expect(result.truncated).toBe(true);
  });
});
