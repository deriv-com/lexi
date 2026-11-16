import { describe, it, expect } from "vitest";
import {
  CACHE_WRITE_RATE_MULTIPLIER,
  CACHED_INPUT_RATE_MULTIPLIER,
  estimateEntryCostUsd,
  formatTokenCount,
  formatUsageSummary,
  parseTokenUsageChecks,
  summarizeTokenUsage,
  type TokenUsageEntry,
  type UsagePricing,
} from "./token-usage";

function entry(overrides: Partial<TokenUsageEntry> = {}): TokenUsageEntry {
  return {
    model: "claude-opus-5",
    phase: "green",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    ...overrides,
  };
}

const usageCheck = (detail: unknown) => ({
  name: "token-usage",
  status: "passed",
  detail: typeof detail === "string" ? detail : JSON.stringify(detail),
});

describe("parseTokenUsageChecks", () => {
  it("parses a well-formed token-usage check into one entry per phase", () => {
    const entries = parseTokenUsageChecks([
      { name: "lint", status: "passed" },
      usageCheck({
        model: "claude-opus-5",
        phases: [
          { phase: "red", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 50, costUsd: 0.5 },
          { phase: "green", inputTokens: 2000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
        ],
      }),
    ]);
    expect(entries).toEqual([
      entry({ phase: "red", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 50, costUsd: 0.5 }),
      entry({ phase: "green", inputTokens: 2000, outputTokens: 400 }),
    ]);
  });

  it("accepts the checks array as JSON text and an already-parsed detail object", () => {
    const fromText = parseTokenUsageChecks(
      JSON.stringify([usageCheck({ model: "m", phases: [{ phase: "checks", inputTokens: 1 }] })]),
    );
    expect(fromText).toHaveLength(1);
    expect(fromText[0]!.inputTokens).toBe(1);

    const fromObject = parseTokenUsageChecks([
      { name: "token-usage", status: "passed", detail: { model: "m", phases: [{ phase: "checks", outputTokens: 7 }] } },
    ]);
    expect(fromObject[0]!.outputTokens).toBe(7);
  });

  it("never throws: unknown, non-array, garbage JSON and malformed checks all yield []", () => {
    expect(parseTokenUsageChecks(undefined)).toEqual([]);
    expect(parseTokenUsageChecks(null)).toEqual([]);
    expect(parseTokenUsageChecks(42)).toEqual([]);
    expect(parseTokenUsageChecks({ name: "token-usage" })).toEqual([]);
    expect(parseTokenUsageChecks("not json")).toEqual([]);
    expect(parseTokenUsageChecks('{"a":1}')).toEqual([]);
    expect(parseTokenUsageChecks([usageCheck("{broken")])).toEqual([]);
    expect(parseTokenUsageChecks([usageCheck({ phases: [] })])).toEqual([]); // no model
    expect(parseTokenUsageChecks([usageCheck({ model: "m" })])).toEqual([]); // no phases
    expect(parseTokenUsageChecks([usageCheck({ model: "m", phases: "red" })])).toEqual([]);
    expect(parseTokenUsageChecks([usageCheck({ model: "", phases: [{ phase: "red" }] })])).toEqual([]);
    expect(parseTokenUsageChecks([null, "x", 3, { name: "token-usage" }])).toEqual([]);
  });

  it("skips malformed phases individually and keeps the good ones", () => {
    const entries = parseTokenUsageChecks([
      usageCheck({
        model: "m",
        phases: [null, "red", { inputTokens: 5 }, { phase: "" }, { phase: "green", inputTokens: 5 }],
      }),
    ]);
    expect(entries.map((e) => e.phase)).toEqual(["green"]);
  });

  it("reads non-numeric, negative and missing counts as 0; unusable costUsd as null", () => {
    const [only] = parseTokenUsageChecks([
      usageCheck({
        model: "m",
        phases: [
          {
            phase: "red",
            inputTokens: "abc",
            outputTokens: -3,
            cacheReadTokens: Number.NaN,
            cacheWriteTokens: "12",
            costUsd: "oops",
          },
        ],
      }),
    ]);
    expect(only).toEqual(entry({ model: "m", phase: "red", cacheWriteTokens: 12 }));
    const [text] = parseTokenUsageChecks([usageCheck({ model: "m", phases: [{ phase: "red", costUsd: "0.25" }] })]);
    expect(text!.costUsd).toBe(0.25);
  });

  it("collects entries from several token-usage checks across models", () => {
    const entries = parseTokenUsageChecks([
      usageCheck({ model: "a", phases: [{ phase: "red" }] }),
      usageCheck({ model: "b", phases: [{ phase: "red" }, { phase: "green" }] }),
    ]);
    expect(entries.map((e) => `${e.model}/${e.phase}`)).toEqual(["a/red", "b/red", "b/green"]);
  });
});

describe("pricing derivation", () => {
  const pricing: UsagePricing = { "claude-opus-5": { input: 5, output: 25 } };

  it("multipliers mirror cost-policy.yaml: cached read 0.1x input, cache write 1.25x input", () => {
    expect(CACHED_INPUT_RATE_MULTIPLIER).toBe(0.1);
    expect(CACHE_WRITE_RATE_MULTIPLIER).toBe(1.25);
  });

  it("prices input and output per million", () => {
    expect(estimateEntryCostUsd(entry({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), pricing)).toBeCloseTo(30);
  });

  it("derives the cached-read rate as 0.1x input when cachedInput is not listed", () => {
    expect(estimateEntryCostUsd(entry({ cacheReadTokens: 1_000_000 }), pricing)).toBeCloseTo(0.5);
  });

  it("honours an explicit cachedInput override", () => {
    const overridden: UsagePricing = { "claude-opus-5": { input: 5, output: 25, cachedInput: 1 } };
    expect(estimateEntryCostUsd(entry({ cacheReadTokens: 1_000_000 }), overridden)).toBeCloseTo(1);
  });

  it("derives the cache-write rate as 1.25x input", () => {
    expect(estimateEntryCostUsd(entry({ cacheWriteTokens: 1_000_000 }), pricing)).toBeCloseTo(6.25);
  });

  it("returns null for a model absent from the table — never a guess", () => {
    expect(estimateEntryCostUsd(entry({ model: "mystery", inputTokens: 1_000_000 }), pricing)).toBeNull();
  });
});

describe("summarizeTokenUsage", () => {
  const pricing: UsagePricing = {
    "claude-opus-5": { input: 5, output: 25 },
    "claude-haiku-4-5": { input: 1, output: 5 },
  };

  it("aggregates per model and totals the estimate", () => {
    const summary = summarizeTokenUsage(
      [
        entry({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 400_000, costUsd: 9 }),
        entry({ phase: "checks", inputTokens: 500_000, costUsd: 2.5 }),
        entry({ model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      ],
      pricing,
    );
    const opus = summary.byModel["claude-opus-5"]!;
    expect(opus.runs).toBe(2);
    expect(opus.inputTokens).toBe(1_500_000);
    expect(opus.outputTokens).toBe(100_000);
    expect(opus.cacheReadTokens).toBe(2_000_000);
    expect(opus.cacheWriteTokens).toBe(400_000);
    // 1.5M*5 + 0.1M*25 + 2M*0.5 + 0.4M*6.25 = 7.5 + 2.5 + 1 + 2.5
    expect(opus.estimatedCostUsd).toBeCloseTo(13.5);
    expect(opus.reportedCostUsd).toBeCloseTo(11.5);

    const haiku = summary.byModel["claude-haiku-4-5"]!;
    expect(haiku.runs).toBe(1);
    expect(haiku.estimatedCostUsd).toBeCloseTo(6);
    expect(haiku.reportedCostUsd).toBeNull();

    expect(summary.totalEstimatedCostUsd).toBeCloseTo(19.5);
    expect(summary.unpricedModels).toEqual([]);
    // 2M cached / (1.5M + 1M haiku input + 2M cached) = 2/4.5
    expect(summary.totalInputTokens).toBe(2_500_000);
    expect(summary.totalCacheReadTokens).toBe(2_000_000);
    expect(summary.cacheHitRate).toBeCloseTo(2_000_000 / 4_500_000);
  });

  it("prices an unknown model at 0 AND lists it in unpricedModels", () => {
    const summary = summarizeTokenUsage(
      [
        entry({ model: "gpt-mystery", inputTokens: 5_000_000, outputTokens: 1_000_000, costUsd: 3 }),
        entry({ model: "claude-opus-5", inputTokens: 1_000_000 }),
      ],
      pricing,
    );
    expect(summary.byModel["gpt-mystery"]!.estimatedCostUsd).toBe(0);
    expect(summary.byModel["gpt-mystery"]!.inputTokens).toBe(5_000_000);
    expect(summary.byModel["gpt-mystery"]!.reportedCostUsd).toBe(3);
    expect(summary.unpricedModels).toEqual(["gpt-mystery"]);
    // The unpriced model contributes nothing to the total rather than a guess.
    expect(summary.totalEstimatedCostUsd).toBeCloseTo(5);
  });

  it("reportedCostUsd is null when ANY entry for the model lacks a reported cost — regardless of order", () => {
    const missingLast = summarizeTokenUsage([entry({ costUsd: 1 }), entry({ costUsd: null })], pricing);
    expect(missingLast.byModel["claude-opus-5"]!.reportedCostUsd).toBeNull();

    const missingFirst = summarizeTokenUsage([entry({ costUsd: null }), entry({ costUsd: 1 })], pricing);
    expect(missingFirst.byModel["claude-opus-5"]!.reportedCostUsd).toBeNull();

    const missingMiddle = summarizeTokenUsage([entry({ costUsd: 1 }), entry({ costUsd: null }), entry({ costUsd: 2 })], pricing);
    expect(missingMiddle.byModel["claude-opus-5"]!.reportedCostUsd).toBeNull();

    const allPresent = summarizeTokenUsage([entry({ costUsd: 1 }), entry({ costUsd: 2.5 })], pricing);
    expect(allPresent.byModel["claude-opus-5"]!.reportedCostUsd).toBeCloseTo(3.5);
  });

  it("a reported cost of 0 counts as reported", () => {
    const summary = summarizeTokenUsage([entry({ costUsd: 0 })], pricing);
    expect(summary.byModel["claude-opus-5"]!.reportedCostUsd).toBe(0);
  });

  it("handles an empty entry list", () => {
    expect(summarizeTokenUsage([], pricing)).toEqual({
      byModel: {},
      totalEstimatedCostUsd: 0,
      unpricedModels: [],
      cacheHitRate: null,
      totalInputTokens: 0,
      totalCacheReadTokens: 0,
    });
  });
});

describe("formatTokenCount", () => {
  it("abbreviates with one decimal below 10 units and none above", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(1_200)).toBe("1.2k");
    expect(formatTokenCount(12_345)).toBe("12k");
    expect(formatTokenCount(210_000)).toBe("210k");
    expect(formatTokenCount(3_100_000)).toBe("3.1M");
    expect(formatTokenCount(2_000_000)).toBe("2M");
    expect(formatTokenCount(45_000_000)).toBe("45M");
    expect(formatTokenCount(1_500_000_000)).toBe("1.5B");
    expect(formatTokenCount(-5)).toBe("0");
  });
});

describe("formatUsageSummary", () => {
  it("renders one mrkdwn bullet per model plus a total, most expensive first", () => {
    const text = formatUsageSummary({
      byModel: {
        "claude-haiku-4-5": {
          runs: 1,
          inputTokens: 400_000,
          outputTokens: 20_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCostUsd: 0.5,
          reportedCostUsd: null,
        },
        "claude-opus-5": {
          runs: 12,
          inputTokens: 3_100_000,
          outputTokens: 210_000,
          cacheReadTokens: 2_600_000,
          cacheWriteTokens: 0,
          estimatedCostUsd: 41.2,
          reportedCostUsd: null,
        },
      },
      totalEstimatedCostUsd: 41.7,
      unpricedModels: [],
      cacheHitRate: 2_600_000 / (3_100_000 + 400_000 + 2_600_000),
      totalInputTokens: 3_500_000,
      totalCacheReadTokens: 2_600_000,
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("• claude-opus-5: 12 runs · 3.1M in / 210k out (2.6M cached) · ≈ $41.20");
    expect(lines[1]).toBe("• claude-haiku-4-5: 1 run · 400k in / 20k out · ≈ $0.50");
    expect(lines[2]).toBe("*Total:* 13 runs · ≈ $41.70");
    expect(lines[3]).toBe("*Prompt-cache hit rate:* 42.6% (2.6M cached / 6.1M input)");
  });

  it("shows cache writes and the runner-reported cost when present", () => {
    const text = formatUsageSummary({
      byModel: {
        "claude-opus-5": {
          runs: 2,
          inputTokens: 1_000,
          outputTokens: 500,
          cacheReadTokens: 10_000,
          cacheWriteTokens: 2_000,
          estimatedCostUsd: 1.234,
          reportedCostUsd: 1.2,
        },
      },
      totalEstimatedCostUsd: 1.234,
      unpricedModels: [],
      cacheHitRate: 10_000 / 11_000,
      totalInputTokens: 1_000,
      totalCacheReadTokens: 10_000,
    });
    expect(text.split("\n")[0]).toBe(
      "• claude-opus-5: 2 runs · 1k in / 500 out (10k cached, 2k cache-written) · ≈ $1.23 (runner reported $1.20)",
    );
    expect(text).toContain("*Prompt-cache hit rate:* 90.9%");
  });

  it("marks unpriced models on their line and excludes them from the total", () => {
    const text = formatUsageSummary({
      byModel: {
        "gpt-mystery": {
          runs: 3,
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCostUsd: 0,
          reportedCostUsd: null,
        },
      },
      totalEstimatedCostUsd: 0,
      unpricedModels: ["gpt-mystery"],
      cacheHitRate: 0,
      totalInputTokens: 1_000_000,
      totalCacheReadTokens: 0,
    });
    expect(text).toContain("• gpt-mystery: 3 runs · 1M in / 0 out · unpriced — not in cost-policy pricing");
    expect(text).not.toContain("gpt-mystery: 3 runs · 1M in / 0 out · ≈ $0.00");
    expect(text).toContain("*Total:* 3 runs · ≈ $0.00 (excludes unpriced: gpt-mystery)");
    expect(text).toContain("*Prompt-cache hit rate:* 0%");
  });

  it("says so when nothing has been reported", () => {
    expect(
      formatUsageSummary({
        byModel: {},
        totalEstimatedCostUsd: 0,
        unpricedModels: [],
        cacheHitRate: null,
        totalInputTokens: 0,
        totalCacheReadTokens: 0,
      }),
    ).toBe("• No token usage reported yet.");
  });

  it("round-trips: parse → summarize → format", () => {
    const entries = parseTokenUsageChecks([
      usageCheck({
        model: "claude-opus-5",
        phases: [{ phase: "green", inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null }],
      }),
    ]);
    const text = formatUsageSummary(summarizeTokenUsage(entries, { "claude-opus-5": { input: 5, output: 25 } }));
    expect(text).toBe(
      "• claude-opus-5: 1 run · 1M in / 100k out · ≈ $7.50\n*Total:* 1 run · ≈ $7.50\n*Prompt-cache hit rate:* 0% (0 cached / 1M input)",
    );
  });
});
