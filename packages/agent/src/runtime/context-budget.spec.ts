import { describe, expect, it } from "vitest";
import { compactByPriority, createContextBudget, fitToolResult, isBudgetExhausted, nextResultCap } from "./context-budget";

describe("fitToolResult", () => {
  it("passes a small result through and charges it to the turn", () => {
    const budget = createContextBudget(1_000, 5_000);
    const fitted = fitToolResult("hello", budget);
    expect(fitted).toMatchObject({ content: "hello", truncated: false, originalChars: 5 });
    expect(budget.remainingChars).toBe(4_995);
  });

  it("keeps the beginning of oversized text and says it was truncated", () => {
    const budget = createContextBudget(1_000, 100_000);
    const fitted = fitToolResult("x".repeat(5_000), budget);
    expect(fitted.truncated).toBe(true);
    expect(typeof fitted.content).toBe("string");
    const text = fitted.content as string;
    expect(text.length).toBeLessThanOrEqual(1_000);
    expect(text).toContain("Truncated by the runtime");
    expect(text).toContain("of 5000 characters");
  });

  it("compacts a JSON object by priority, keeping the verdict and naming what was dropped", () => {
    const budget = createContextBudget(800, 100_000);
    const payload = JSON.stringify({ executed: true, reason: "posted", contents: "c".repeat(480), artifacts: "a".repeat(2_000) });
    const text = fitToolResult(payload, budget).content as string;
    const json = JSON.parse(text.split("\n")[0]);
    expect(json).toMatchObject({ executed: true, reason: "posted", contents: "c".repeat(480) });
    expect(json).not.toHaveProperty("artifacts");
    expect(text).toContain("dropped: artifacts");
  });

  it("states that a result was omitted once the turn budget is spent, rather than returning nothing", () => {
    const budget = createContextBudget(1_000, 1_200);
    fitToolResult("y".repeat(1_000), budget);
    expect(isBudgetExhausted(budget)).toBe(true);
    const text = fitToolResult("z".repeat(900), budget).content as string;
    expect(text).toContain("Result omitted by the runtime");
    expect(text).toContain("do not treat it as empty");
  });

  it("trims the text parts of mixed content and leaves images alone", () => {
    const budget = createContextBudget(500, 100_000);
    const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "AAAA" } };
    const fitted = fitToolResult([{ type: "text", text: "t".repeat(3_000) }, image], budget);
    expect(fitted.truncated).toBe(true);
    expect(Array.isArray(fitted.content) && fitted.content[1]).toEqual(image);
  });

  it("uses the smaller of the per-result cap and what the turn has left", () => {
    const budget = createContextBudget(1_000, 600);
    expect(nextResultCap(budget)).toBe(600);
  });
});

describe("compactByPriority", () => {
  it("reports shortened keys", () => {
    const { compacted, shortenedKeys } = compactByPriority({ body: "b".repeat(500) }, 100);
    expect(shortenedKeys).toEqual(["body"]);
    expect(String(compacted.body).endsWith("…")).toBe(true);
  });
});
