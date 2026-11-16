import { describe, it, expect, vi } from "vitest";
import type { ThreadState, TurnDigest } from "@lexi/contracts";
import { HierarchicalBuffer } from "./hierarchical-buffer";
import { parseMemoryPolicy } from "../load-memory-policy";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Hierarchical buffer.
 *
 * Compresses the oldest digests into one summary digest and marks the
 * originals superseded — retained in Postgres for replay, excluded from the
 * prompt. The constraint that shapes the whole design: compression runs
 * "only when the budget is actually exceeded — not on a timer". A summariser
 * that fires on a schedule spends model tokens on threads nobody is over
 * budget on, which spends money for nothing.
 */

const policy = parseMemoryPolicy(
  readFileSync(resolve(__dirname, "../../../../examples/config/memory-policy.yaml"), "utf-8"),
);

function digest(index: number, summary = `turn ${index} with a moderate amount of detail in it`): TurnDigest {
  return {
    turnId: `t${index}`,
    createdAt: new Date(Date.UTC(2026, 7, 15) - index * 60_000).toISOString(),
    summary,
    entities: [],
    tokenCost: Math.ceil(summary.length / 4),
    superseded: false,
  };
}

function state(digests: TurnDigest[]): ThreadState {
  return {
    threadKey: "C1:1.0",
    entities: [],
    digests,
    openQuestions: [],
    decisions: [],
    tokenCost: 0,
  };
}

describe("HierarchicalBuffer — when it runs", () => {
  it("does nothing, and calls no summariser, when the thread is under budget", async () => {
    // The cost-critical assertion: a small thread must never pay for a model
    // call. This is what "not on a timer" means in practice.
    const summarise = vi.fn(async () => "should never be called");
    const buffer = new HierarchicalBuffer(policy, summarise);

    const result = await buffer.compactIfNeeded(state([digest(0), digest(1)]), { maxTokens: 800 });

    expect(result.compacted).toBe(false);
    expect(summarise).not.toHaveBeenCalled();
    expect(result.state.digests).toHaveLength(2);
  });

  it("compacts once the digest count exceeds the policy threshold", async () => {
    const summarise = vi.fn(async () => "summary of the early part of the thread");
    const buffer = new HierarchicalBuffer(policy, summarise);
    const digests = Array.from({ length: policy.budgets.maxDigestsBeforeCompaction + 5 }, (_, i) => digest(i));

    const result = await buffer.compactIfNeeded(state(digests), { maxTokens: 100_000 });

    expect(result.compacted).toBe(true);
    expect(summarise).toHaveBeenCalledTimes(1);
  });

  it("compacts when the measured cost exceeds the budget", async () => {
    const summarise = vi.fn(async () => "summary");
    const buffer = new HierarchicalBuffer(policy, summarise);
    const digests = Array.from({ length: 10 }, (_, i) => digest(i, "x".repeat(400)));

    const result = await buffer.compactIfNeeded(state(digests), { maxTokens: 200 });

    expect(result.compacted).toBe(true);
    expect(summarise).toHaveBeenCalled();
  });
});

describe("HierarchicalBuffer — what it does", () => {
  const summarise = async (digests: TurnDigest[]) => `compressed ${digests.length} earlier turns`;

  it("marks the compressed digests superseded rather than deleting them", async () => {
    // Retained in Postgres for replay, excluded from the prompt.
    const buffer = new HierarchicalBuffer(policy, summarise);
    const digests = Array.from({ length: 30 }, (_, i) => digest(i));

    const result = await buffer.compactIfNeeded(state(digests), { maxTokens: 100_000 });

    const superseded = result.state.digests.filter((d) => d.superseded);
    expect(superseded.length).toBeGreaterThan(0);
    // Nothing was destroyed: originals + the new summary digest.
    expect(result.state.digests.length).toBe(digests.length + 1);
  });

  it("compresses the OLDEST digests and leaves the newest untouched", async () => {
    const buffer = new HierarchicalBuffer(policy, summarise);
    const digests = Array.from({ length: 30 }, (_, i) => digest(i));

    const result = await buffer.compactIfNeeded(state(digests), { maxTokens: 100_000 });
    const live = result.state.digests.filter((d) => !d.superseded && !d.turnId.startsWith("summary-"));

    expect(live.some((d) => d.turnId === "t0")).toBe(true);
    expect(live.some((d) => d.turnId === "t29")).toBe(false);
  });

  it("inserts the summary digest as the oldest live digest", async () => {
    const buffer = new HierarchicalBuffer(policy, summarise);
    const result = await buffer.compactIfNeeded(
      state(Array.from({ length: 30 }, (_, i) => digest(i))),
      { maxTokens: 100_000 },
    );

    const live = result.state.digests.filter((d) => !d.superseded);
    expect(live[live.length - 1].turnId).toMatch(/^summary-/);
    expect(live[live.length - 1].summary).toContain("compressed");
  });

  it("brings the live digest count back under the threshold", async () => {
    const buffer = new HierarchicalBuffer(policy, summarise);
    const result = await buffer.compactIfNeeded(
      state(Array.from({ length: 60 }, (_, i) => digest(i))),
      { maxTokens: 100_000 },
    );

    const live = result.state.digests.filter((d) => !d.superseded);
    expect(live.length).toBeLessThanOrEqual(policy.budgets.maxDigestsBeforeCompaction);
  });

  it("never compresses an already-superseded digest twice", async () => {
    const buffer = new HierarchicalBuffer(policy, summarise);
    const already = { ...digest(50), superseded: true };
    const digests = [...Array.from({ length: 30 }, (_, i) => digest(i)), already];

    const result = await buffer.compactIfNeeded(state(digests), { maxTokens: 100_000 });
    const supersededCount = result.state.digests.filter((d) => d.superseded && d.turnId === "t50").length;
    expect(supersededCount).toBe(1);
  });

  it("leaves the thread untouched when the summariser fails", async () => {
    // A failed compression must not lose turns. Memory is advisory:
    // degrading to "still over budget" is recoverable, losing history is not.
    const buffer = new HierarchicalBuffer(policy, async () => {
      throw new Error("gateway 503");
    });
    const digests = Array.from({ length: 30 }, (_, i) => digest(i));

    const result = await buffer.compactIfNeeded(state(digests), { maxTokens: 100_000 });

    expect(result.compacted).toBe(false);
    expect(result.state.digests).toHaveLength(30);
    expect(result.state.digests.every((d) => !d.superseded)).toBe(true);
  });

  it("prunes superseded digests past the retention window", async () => {
    // policy `retention.supersededDigestDays` — replay value has a shelf life.
    const buffer = new HierarchicalBuffer(policy, summarise);
    const ancient: TurnDigest = {
      ...digest(99),
      superseded: true,
      createdAt: new Date(Date.now() - (policy.retention.supersededDigestDays + 10) * 86_400_000).toISOString(),
    };

    const result = await buffer.compactIfNeeded(state([ancient, ...Array.from({ length: 30 }, (_, i) => digest(i))]), {
      maxTokens: 100_000,
    });

    expect(result.state.digests.some((d) => d.turnId === "t99")).toBe(false);
  });

  it("passes only the digests being compressed to the summariser", async () => {
    const seen: TurnDigest[][] = [];
    const buffer = new HierarchicalBuffer(policy, async (digests) => {
      seen.push(digests);
      return "summary";
    });

    await buffer.compactIfNeeded(state(Array.from({ length: 30 }, (_, i) => digest(i))), { maxTokens: 100_000 });

    expect(seen).toHaveLength(1);
    expect(seen[0].every((d) => !d.superseded)).toBe(true);
    expect(seen[0].length).toBeGreaterThan(0);
  });
});
