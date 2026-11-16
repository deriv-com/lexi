/**
 * Cost Accounting — tracks resource consumption per issue/run/team.
 *
 * Resources tracked:
 * - LLM tokens (input + output, by model)
 * - Embedding generation (tokens, by model)
 * - Reproduction (reproduction) runs
 * - GitHub API calls
 * - Slack messages
 * - Artifact storage
 *
 * Aggregated by: issue, run, product, team, time period.
 */

export type CostResource =
  | "llm_tokens_input"
  | "llm_tokens_output"
  | "embedding_tokens"
  | "bre_runs"
  | "github_api_calls"
  | "slack_messages"
  | "artifact_storage_bytes";

export interface CostEntry {
  resource: CostResource;
  quantity: number;
  /** Model/provider identifier (for token costs). */
  provider?: string;
  /** Estimated cost in USD (if available). */
  estimatedCostUsd?: number;
  /** What triggered this cost. */
  issueNumber?: number;
  runId?: string;
  team?: string;
  product?: string;
  timestamp: Date;
}

export interface CostSummary {
  period: string;
  totalEstimatedUsd: number;
  byResource: Record<CostResource, { quantity: number; estimatedUsd: number }>;
  byTeam: Record<string, { quantity: number; estimatedUsd: number }>;
  topIssues: Array<{ issueNumber: number; totalUsd: number }>;
}

export interface CostAccountingPersistence {
  recordCost(entry: CostEntry): Promise<void>;
  getSummary(since: Date, until: Date): Promise<CostSummary>;
  getCostByIssue(issueNumber: number): Promise<CostEntry[]>;
  getCostByRun(runId: string): Promise<CostEntry[]>;
}

/**
 * Cost accounting service — records and queries resource consumption.
 */
export class CostAccountingService {
  private buffer: CostEntry[] = [];
  private readonly flushThreshold: number;

  constructor(
    private readonly persistence: CostAccountingPersistence | null,
    options?: { flushThreshold?: number },
  ) {
    this.flushThreshold = options?.flushThreshold ?? 50;
  }

  /**
   * Record a cost entry. Buffers for batch persistence.
   */
  record(entry: Omit<CostEntry, "timestamp">): void {
    this.buffer.push({ ...entry, timestamp: new Date() });
    if (this.buffer.length >= this.flushThreshold) {
      this.flush().catch(() => {}); // Non-blocking flush
    }
  }

  /** Convenience: record LLM token usage. */
  recordLlmUsage(inputTokens: number, outputTokens: number, model: string, issueNumber?: number, runId?: string): void {
    this.record({ resource: "llm_tokens_input", quantity: inputTokens, provider: model, issueNumber, runId });
    this.record({ resource: "llm_tokens_output", quantity: outputTokens, provider: model, issueNumber, runId });
  }

  /** Convenience: record reproduction run. */
  recordBreRun(issueNumber: number, runId?: string): void {
    this.record({ resource: "bre_runs", quantity: 1, issueNumber, runId });
  }

  /** Convenience: record GitHub API call. */
  recordGitHubCall(issueNumber?: number): void {
    this.record({ resource: "github_api_calls", quantity: 1, issueNumber });
  }

  /**
   * Flush buffered entries to persistence.
   */
  async flush(): Promise<void> {
    if (!this.persistence || this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    for (const entry of batch) {
      await this.persistence.recordCost(entry);
    }
  }

  /**
   * Get cost summary for a period.
   */
  async getSummary(since: Date, until: Date): Promise<CostSummary | null> {
    if (!this.persistence) return null;
    return this.persistence.getSummary(since, until);
  }
}
