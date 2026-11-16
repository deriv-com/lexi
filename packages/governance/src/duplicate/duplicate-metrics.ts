/**
 * Duplicate intelligence metrics — tracks embedding freshness,
 * search latency, adjudication outcomes, and pipeline health.
 */

export interface DuplicateMetrics {
  // Embedding metrics
  embeddingIndexSize: number;
  embeddingCoveragePercent: number;
  embeddingStaleCount: number;
  embeddingAvgAgeHours: number;
  lastBackfillAt: Date | null;
  lastIncrementalAt: Date | null;

  // Search metrics
  avgSearchLatencyMs: number;
  p95SearchLatencyMs: number;
  searchCount: number;

  // Adjudication metrics
  adjudicationCount: number;
  duplicateCount: number;
  possibleDuplicateCount: number;
  notDuplicateCount: number;
  humanAdjudicationCount: number;
  humanConfirmedCount: number;
  humanRejectedCount: number;
  reporterRejectionCount: number;

  // Consolidation metrics
  consolidationCount: number;
  consolidationFailedCount: number;

  // Pipeline metrics
  closedIssueReopenCount: number;
  closedIssueRegressionCount: number;
  closedIssueCanonicalChainCount: number;
}

export interface MetricsSample {
  name: string;
  value: number;
  timestamp: Date;
  labels?: Record<string, string>;
}

/**
 * Collects and reports duplicate intelligence metrics.
 */
export class DuplicateMetricsCollector {
  private searchLatencies: number[] = [];
  private readonly maxLatencySamples = 1000;
  private counters: Record<string, number> = {};
  private timestamps: Record<string, Date> = {};

  recordSearchLatency(latencyMs: number): void {
    this.searchLatencies.push(latencyMs);
    if (this.searchLatencies.length > this.maxLatencySamples) {
      this.searchLatencies = this.searchLatencies.slice(-this.maxLatencySamples);
    }
  }

  recordAdjudication(verdict: "DUPLICATE" | "POSSIBLE_DUPLICATE" | "NOT_DUPLICATE"): void {
    this.increment("adjudication_total");
    this.increment(`adjudication_${verdict.toLowerCase()}`);
  }

  recordHumanAdjudication(outcome: "confirmed" | "rejected" | "reporter_rejected"): void {
    this.increment("human_adjudication_total");
    this.increment(`human_adjudication_${outcome}`);
  }

  recordConsolidation(success: boolean): void {
    this.increment("consolidation_total");
    if (!success) this.increment("consolidation_failed");
  }

  recordClosedIssueAction(action: "REOPEN" | "REGRESSION" | "RESOLVE_CANONICAL"): void {
    this.increment(`closed_issue_${action.toLowerCase()}`);
  }

  recordBackfill(): void {
    this.timestamps["last_backfill"] = new Date();
  }

  recordIncremental(): void {
    this.timestamps["last_incremental"] = new Date();
  }

  recordSearch(): void {
    this.increment("search_total");
  }

  /**
   * Get current metric values.
   */
  getMetrics(indexHealth?: {
    totalEmbeddings: number;
    coveragePercent: number;
    staleCount: number;
    avgAgeHours: number;
  }): DuplicateMetrics {
    const sorted = [...this.searchLatencies].sort((a, b) => a - b);
    const avg = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0;

    return {
      embeddingIndexSize: indexHealth?.totalEmbeddings ?? 0,
      embeddingCoveragePercent: indexHealth?.coveragePercent ?? 0,
      embeddingStaleCount: indexHealth?.staleCount ?? 0,
      embeddingAvgAgeHours: indexHealth?.avgAgeHours ?? 0,
      lastBackfillAt: this.timestamps["last_backfill"] ?? null,
      lastIncrementalAt: this.timestamps["last_incremental"] ?? null,
      avgSearchLatencyMs: Math.round(avg),
      p95SearchLatencyMs: Math.round(p95),
      searchCount: this.getCount("search_total"),
      adjudicationCount: this.getCount("adjudication_total"),
      duplicateCount: this.getCount("adjudication_duplicate"),
      possibleDuplicateCount: this.getCount("adjudication_possible_duplicate"),
      notDuplicateCount: this.getCount("adjudication_not_duplicate"),
      humanAdjudicationCount: this.getCount("human_adjudication_total"),
      humanConfirmedCount: this.getCount("human_adjudication_confirmed"),
      humanRejectedCount: this.getCount("human_adjudication_rejected"),
      reporterRejectionCount: this.getCount("human_adjudication_reporter_rejected"),
      consolidationCount: this.getCount("consolidation_total"),
      consolidationFailedCount: this.getCount("consolidation_failed"),
      closedIssueReopenCount: this.getCount("closed_issue_reopen"),
      closedIssueRegressionCount: this.getCount("closed_issue_regression"),
      closedIssueCanonicalChainCount: this.getCount("closed_issue_resolve_canonical"),
    };
  }

  /**
   * Export metrics as Prometheus-style samples.
   */
  toSamples(prefix = "lexi_duplicate_"): MetricsSample[] {
    const now = new Date();
    const metrics = this.getMetrics();
    const samples: MetricsSample[] = [];

    for (const [key, value] of Object.entries(metrics)) {
      if (typeof value === "number") {
        samples.push({ name: `${prefix}${key}`, value, timestamp: now });
      }
    }

    return samples;
  }

  private increment(key: string): void {
    this.counters[key] = (this.counters[key] ?? 0) + 1;
  }

  private getCount(key: string): number {
    return this.counters[key] ?? 0;
  }
}
