/**
 * Token-usage aggregation for programme build runs.
 *
 * A build run reports its model spend as one entry in its `checks` evidence
 * bundle: `{ name: "token-usage", status: "passed", detail: "<JSON>" }`,
 * where the JSON is `{ model, phases: [{ phase, inputTokens, outputTokens,
 * cacheReadTokens, cacheWriteTokens, costUsd }] }`. This module turns those
 * into a per-model summary and a Slack-mrkdwn rendering.
 *
 * Pure and tolerant by design: evidence is sender-controlled text, so a
 * malformed check is skipped rather than allowed to fail the report, and a
 * non-numeric count reads as 0. Pricing follows `config/cost-policy.yaml`
 * (`ledger.pricePerMillionTokensUsd`): only `input` and `output` are listed
 * per model; the cached-read rate (0.1x input) and the cache-write rate
 * (1.25x input) are derived here so a hand-maintained table cannot drift. A
 * model absent from the table is priced at 0 AND named in `unpricedModels`
 * — an obvious gap in a cost report beats an authoritative-looking guess.
 */

export const TOKEN_USAGE_CHECK_NAME = "token-usage";

export interface TokenUsageEntry {
  model: string;
  phase: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Cost the runner itself reported, when it reported one. */
  costUsd: number | null;
}

/** USD per million tokens. `cachedInput` overrides the derived 0.1x input rate. */
export interface UsagePricing {
  [model: string]: { input: number; output: number; cachedInput?: number };
}

export interface UsageModelSummary {
  /** Number of usage entries (one per reported phase) attributed to the model. */
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Priced from `UsagePricing`; 0 for an unpriced model. */
  estimatedCostUsd: number;
  /** Sum of runner-reported costs, or null unless EVERY entry reported one. */
  reportedCostUsd: number | null;
}

export interface UsageSummary {
  byModel: Record<string, UsageModelSummary>;
  totalEstimatedCostUsd: number;
  /** Models seen in the entries but absent from the pricing table. */
  unpricedModels: string[];
  /**
   * Prompt-cache hit rate across all entries: cacheReadTokens ÷
   * (inputTokens + cacheReadTokens). Null when there were no input-side
   * tokens at all. Cache writes are excluded from the denominator — they
   * are the cost of *establishing* a prefix, not a hit against one.
   */
  cacheHitRate: number | null;
  totalInputTokens: number;
  totalCacheReadTokens: number;
}

/** Multipliers on the model's `input` rate, mirroring cost-policy.yaml's comments. */
export const CACHED_INPUT_RATE_MULTIPLIER = 0.1;
export const CACHE_WRITE_RATE_MULTIPLIER = 1.25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-numeric, negative, NaN or infinite counts read as 0 — never throw. */
function toCount(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function toCost(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parseDetail(detail: unknown): Record<string, unknown> | undefined {
  if (isRecord(detail)) return detail;
  if (typeof detail !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(detail);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Usage entries out of a `checks` array — or anything claiming to be one.
 * Accepts the array itself or its JSON text; anything else yields `[]`.
 * Checks not named `token-usage`, checks without a parseable JSON `detail`,
 * details without a string `model`, and phases without a string `phase` are
 * skipped individually, so one bad entry never hides the good ones.
 */
export function parseTokenUsageChecks(checks: unknown): TokenUsageEntry[] {
  let list: unknown = checks;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];

  const entries: TokenUsageEntry[] = [];
  for (const check of list) {
    if (!isRecord(check) || check.name !== TOKEN_USAGE_CHECK_NAME) continue;
    const detail = parseDetail(check.detail);
    if (!detail || typeof detail.model !== "string" || detail.model.trim() === "") continue;
    const model = detail.model.trim();
    if (!Array.isArray(detail.phases)) continue;
    for (const phase of detail.phases) {
      if (!isRecord(phase) || typeof phase.phase !== "string" || phase.phase.trim() === "") continue;
      entries.push({
        model,
        phase: phase.phase.trim(),
        inputTokens: toCount(phase.inputTokens),
        outputTokens: toCount(phase.outputTokens),
        cacheReadTokens: toCount(phase.cacheReadTokens),
        cacheWriteTokens: toCount(phase.cacheWriteTokens),
        costUsd: toCost(phase.costUsd),
      });
    }
  }
  return entries;
}

/** Estimated USD for one entry, or null when the model is unpriced. */
export function estimateEntryCostUsd(entry: TokenUsageEntry, pricing: UsagePricing): number | null {
  const price = pricing[entry.model];
  if (!price || !Number.isFinite(price.input) || !Number.isFinite(price.output)) return null;
  const cachedInput =
    typeof price.cachedInput === "number" && Number.isFinite(price.cachedInput)
      ? price.cachedInput
      : price.input * CACHED_INPUT_RATE_MULTIPLIER;
  const cacheWrite = price.input * CACHE_WRITE_RATE_MULTIPLIER;
  return (
    (entry.inputTokens * price.input +
      entry.outputTokens * price.output +
      entry.cacheReadTokens * cachedInput +
      entry.cacheWriteTokens * cacheWrite) /
    1_000_000
  );
}

export function summarizeTokenUsage(entries: TokenUsageEntry[], pricing: UsagePricing): UsageSummary {
  const byModel: Record<string, UsageModelSummary> = {};
  const unpriced = new Set<string>();
  // Tracks whether every entry for a model carried a reported cost.
  const allReported = new Map<string, boolean>();

  for (const entry of entries) {
    const current = (byModel[entry.model] ??= {
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0,
      reportedCostUsd: 0,
    });
    current.runs += 1;
    current.inputTokens += entry.inputTokens;
    current.outputTokens += entry.outputTokens;
    current.cacheReadTokens += entry.cacheReadTokens;
    current.cacheWriteTokens += entry.cacheWriteTokens;

    const estimated = estimateEntryCostUsd(entry, pricing);
    if (estimated === null) {
      unpriced.add(entry.model);
    } else {
      current.estimatedCostUsd += estimated;
    }

    const reportedSoFar = allReported.get(entry.model) ?? true;
    if (reportedSoFar && entry.costUsd !== null) {
      current.reportedCostUsd = (current.reportedCostUsd ?? 0) + entry.costUsd;
    } else {
      allReported.set(entry.model, false);
      current.reportedCostUsd = null;
    }
    if (entry.costUsd !== null && reportedSoFar) allReported.set(entry.model, true);
  }

  const totalEstimatedCostUsd = Object.values(byModel).reduce((sum, model) => sum + model.estimatedCostUsd, 0);
  const totalInputTokens = Object.values(byModel).reduce((sum, model) => sum + model.inputTokens, 0);
  const totalCacheReadTokens = Object.values(byModel).reduce((sum, model) => sum + model.cacheReadTokens, 0);
  const cacheDenominator = totalInputTokens + totalCacheReadTokens;
  const cacheHitRate = cacheDenominator > 0 ? totalCacheReadTokens / cacheDenominator : null;
  return {
    byModel,
    totalEstimatedCostUsd,
    unpricedModels: [...unpriced].sort(),
    cacheHitRate,
    totalInputTokens,
    totalCacheReadTokens,
  };
}

/** 0.858 → "85.8%", 1 → "100%", 0 → "0%", null → "n/a". */
export function formatCacheHitRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate) || rate < 0) return "n/a";
  const pct = Math.min(rate, 1) * 100;
  const rounded = Math.round(pct * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

/** 950 → "950", 12_345 → "12.3k", 210_000 → "210k", 3_100_000 → "3.1M". */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  if (count < 1_000) return String(Math.round(count));
  const scaled = (value: number, unit: string) =>
    `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value))}${unit}`;
  if (count < 1_000_000) return scaled(count / 1_000, "k");
  if (count < 1_000_000_000) return scaled(count / 1_000_000, "M");
  return scaled(count / 1_000_000_000, "B");
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Slack mrkdwn: one bullet per model (most expensive first), then a total.
 * Unpriced models say so on their line instead of showing a misleading $0.
 */
export function formatUsageSummary(summary: UsageSummary): string {
  const models = Object.entries(summary.byModel).sort(
    ([nameA, a], [nameB, b]) => b.estimatedCostUsd - a.estimatedCostUsd || nameA.localeCompare(nameB),
  );
  if (models.length === 0) return "• No token usage reported yet.";

  const unpriced = new Set(summary.unpricedModels);
  const lines = models.map(([model, usage]) => {
    const cached: string[] = [];
    if (usage.cacheReadTokens > 0) cached.push(`${formatTokenCount(usage.cacheReadTokens)} cached`);
    if (usage.cacheWriteTokens > 0) cached.push(`${formatTokenCount(usage.cacheWriteTokens)} cache-written`);
    const tokens =
      `${formatTokenCount(usage.inputTokens)} in / ${formatTokenCount(usage.outputTokens)} out` +
      (cached.length > 0 ? ` (${cached.join(", ")})` : "");
    const cost = unpriced.has(model)
      ? "unpriced — not in cost-policy pricing"
      : `≈ ${formatUsd(usage.estimatedCostUsd)}` +
        (usage.reportedCostUsd !== null ? ` (runner reported ${formatUsd(usage.reportedCostUsd)})` : "");
    const runs = `${usage.runs} run${usage.runs === 1 ? "" : "s"}`;
    return `• ${model}: ${runs} · ${tokens} · ${cost}`;
  });

  const totalRuns = models.reduce((sum, [, usage]) => sum + usage.runs, 0);
  let total = `*Total:* ${totalRuns} run${totalRuns === 1 ? "" : "s"} · ≈ ${formatUsd(summary.totalEstimatedCostUsd)}`;
  if (summary.unpricedModels.length > 0) {
    total += ` (excludes unpriced: ${summary.unpricedModels.join(", ")})`;
  }
  const cacheLine =
    summary.cacheHitRate === null
      ? null
      : `*Prompt-cache hit rate:* ${formatCacheHitRate(summary.cacheHitRate)} (${formatTokenCount(summary.totalCacheReadTokens)} cached / ${formatTokenCount(summary.totalInputTokens + summary.totalCacheReadTokens)} input)`;
  return [...lines, total, ...(cacheLine ? [cacheLine] : [])].join("\n");
}
