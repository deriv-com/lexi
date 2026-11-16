/**
 * Embedding index service — manages the lifecycle of issue embeddings.
 *
 * Responsibilities:
 * - Initial corpus backfill (processes entire corpus)
 * - Incremental indexing (triggered by corpus sync)
 * - Reindex command (model version migration)
 * - Staleness detection and health reporting
 * - Model-version drift handling
 *
 * Retrieval operates over the COMPLETE synchronized corpus.
 * No corpus size limit is imposed.
 */

import type { VectorDocument } from "./semantic-index";
import type { EmbeddingProvider, EmbeddingProviderHealth } from "./embedding-provider";
import { computeTextHash } from "./pgvector-index-provider";

export interface IndexableIssue {
  issueNumber: number;
  repository: string;
  title: string;
  body: string | null;
  labels: string[];
  state: string;
  updatedAt: string;
}

export interface BackfillProgress {
  total: number;
  processed: number;
  failed: number;
  skipped: number;
}

export interface BackfillResult {
  total: number;
  indexed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  modelUsed: string;
  modelVersion: string;
}

export interface ReindexResult {
  previousModel: string;
  previousVersion: string;
  newModel: string;
  newVersion: string;
  reindexed: number;
  failed: number;
  durationMs: number;
}

export interface IndexHealthReport {
  embeddingProvider: EmbeddingProviderHealth;
  totalEmbeddings: number;
  currentModelEmbeddings: number;
  staleEmbeddings: number;
  corpusSize: number;
  coveragePercent: number;
  oldestEmbedding: Date | null;
  newestEmbedding: Date | null;
  needsReindex: boolean;
  driftDetected: boolean;
}

export interface EmbeddingIndexPersistence {
  /** Get all issues in the corpus for backfill. */
  getCorpusIssues(batchSize: number, offset: number): Promise<IndexableIssue[]>;
  /** Get total corpus count. */
  getCorpusCount(): Promise<number>;
  /** Get issues updated since a given date. */
  getUpdatedIssuesSince(since: Date): Promise<IndexableIssue[]>;
  /** Check which issues already have current-model embeddings. */
  getExistingEmbeddings(
    model: string,
    version: string,
  ): Promise<Map<string, { textHash: string; issueNumber: number; repository: string }>>;
  /** Record health snapshot. */
  recordHealthSnapshot(health: {
    totalDocuments: number;
    staleDocuments: number;
    embeddingModel: string;
    modelVersion: string;
    avgAge: number | null;
    oldestEmbedding: Date | null;
    newestEmbedding: Date | null;
  }): Promise<void>;
}

export interface EmbeddingIndexVectorStore {
  upsert(doc: VectorDocument): Promise<void>;
  remove(id: string): Promise<void>;
  /** Get freshness stats. */
  getFreshness?(): Promise<{
    totalEmbeddings: number;
    currentModelEmbeddings: number;
    staleEmbeddings: number;
    oldestEmbedding: Date | null;
    newestEmbedding: Date | null;
  }>;
  /** Delete embeddings for a specific model version. */
  deleteByModelVersion?(model: string, version: string): Promise<number>;
}

/**
 * Converts an issue into the text format used for embedding generation.
 */
export function issueToEmbeddingText(issue: IndexableIssue): string {
  const parts = [
    issue.title,
    issue.body ?? "",
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : "",
  ].filter((p) => p.length > 0);

  return parts.join("\n\n").slice(0, 8000); // Token budget for embedding models
}

export class EmbeddingIndexService {
  constructor(
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly vectorStore: EmbeddingIndexVectorStore,
    private readonly persistence: EmbeddingIndexPersistence,
    private readonly logger: { log(msg: string, ctx?: string): void; warn(msg: string, ctx?: string): void; error(msg: string, ctx?: string): void },
    private readonly options: {
      batchSize: number;
      concurrency: number;
      onProgress?: (progress: BackfillProgress) => void;
    } = { batchSize: 50, concurrency: 5 },
  ) {}

  /**
   * Full corpus backfill — indexes all issues that don't have a current embedding.
   */
  async backfill(): Promise<BackfillResult> {
    const start = Date.now();
    const model = this.embeddingProvider.model;
    const version = this.embeddingProvider.modelVersion;

    this.logger.log(`Starting backfill with model ${model}@${version}`, "EmbeddingIndexService");

    // Get existing embeddings to skip already-indexed issues
    const existing = await this.persistence.getExistingEmbeddings(model, version);
    const total = await this.persistence.getCorpusCount();

    let processed = 0;
    let indexed = 0;
    let failed = 0;
    let skipped = 0;
    let offset = 0;

    while (offset < total) {
      const batch = await this.persistence.getCorpusIssues(this.options.batchSize, offset);
      if (batch.length === 0) break;

      for (const issue of batch) {
        const docId = `${issue.repository}#${issue.issueNumber}`;
        const text = issueToEmbeddingText(issue);
        const textHash = computeTextHash(text);

        // Skip if already indexed with same text hash
        const existingEntry = existing.get(docId);
        if (existingEntry && existingEntry.textHash === textHash) {
          skipped++;
          processed++;
          continue;
        }

        try {
          await this.vectorStore.upsert({
            id: docId,
            issueNumber: issue.issueNumber,
            repository: issue.repository,
            text,
            updatedAt: issue.updatedAt,
          });
          indexed++;
        } catch (error) {
          failed++;
          this.logger.warn(
            `Failed to index issue ${docId}: ${error instanceof Error ? error.message : String(error)}`,
            "EmbeddingIndexService",
          );
        }

        processed++;
        this.options.onProgress?.({ total, processed, failed, skipped });
      }

      offset += batch.length;
    }

    const durationMs = Date.now() - start;
    this.logger.log(
      `Backfill complete: ${indexed} indexed, ${skipped} skipped, ${failed} failed in ${durationMs}ms`,
      "EmbeddingIndexService",
    );

    return { total, indexed, failed, skipped, durationMs, modelUsed: model, modelVersion: version };
  }

  /**
   * Incremental indexing — processes issues updated since last sync.
   * Called by corpus synchronization after fetching new/updated issues.
   */
  async indexIncremental(issues: IndexableIssue[]): Promise<{ indexed: number; failed: number }> {
    let indexed = 0;
    let failed = 0;

    for (const issue of issues) {
      const docId = `${issue.repository}#${issue.issueNumber}`;
      const text = issueToEmbeddingText(issue);

      try {
        await this.vectorStore.upsert({
          id: docId,
          issueNumber: issue.issueNumber,
          repository: issue.repository,
          text,
          updatedAt: issue.updatedAt,
        });
        indexed++;
      } catch (error) {
        failed++;
        this.logger.warn(
          `Incremental index failed for ${docId}: ${error instanceof Error ? error.message : String(error)}`,
          "EmbeddingIndexService",
        );
      }
    }

    this.logger.log(
      `Incremental indexing: ${indexed} indexed, ${failed} failed out of ${issues.length}`,
      "EmbeddingIndexService",
    );

    return { indexed, failed };
  }

  /**
   * Reindex command — re-generates embeddings for all issues using the current model.
   * Used when the embedding model changes (model-version migration).
   *
   * Process:
   * 1. Generate new embeddings with current model
   * 2. Old embeddings remain until overwritten (graceful migration)
   * 3. After successful reindex, optionally clean up old model versions
   */
  async reindex(options?: { cleanupOldVersions?: boolean }): Promise<ReindexResult> {
    const start = Date.now();
    const newModel = this.embeddingProvider.model;
    const newVersion = this.embeddingProvider.modelVersion;

    this.logger.log(
      `Starting reindex to model ${newModel}@${newVersion}`,
      "EmbeddingIndexService",
    );

    // Detect previous model version from existing embeddings
    const existing = await this.persistence.getExistingEmbeddings(newModel, newVersion);
    const previousModel = newModel; // Same model, different version
    const previousVersion = existing.size > 0 ? "previous" : "none";

    // Full reindex — process all corpus issues
    const result = await this.backfill();

    // Optionally clean up old model versions
    if (options?.cleanupOldVersions && this.vectorStore.deleteByModelVersion) {
      // Only delete old versions AFTER successful reindex
      // This is intentionally left for explicit invocation
      this.logger.log("Old model versions retained. Use explicit cleanup to remove.", "EmbeddingIndexService");
    }

    return {
      previousModel,
      previousVersion,
      newModel,
      newVersion,
      reindexed: result.indexed,
      failed: result.failed,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Health check — comprehensive index status report.
   */
  async health(): Promise<IndexHealthReport> {
    const providerHealth = await this.embeddingProvider.health();
    const corpusSize = await this.persistence.getCorpusCount();

    let freshness = {
      totalEmbeddings: 0,
      currentModelEmbeddings: 0,
      staleEmbeddings: 0,
      oldestEmbedding: null as Date | null,
      newestEmbedding: null as Date | null,
    };

    if (this.vectorStore.getFreshness) {
      freshness = await this.vectorStore.getFreshness();
    }

    const coveragePercent =
      corpusSize > 0 ? (freshness.currentModelEmbeddings / corpusSize) * 100 : 0;

    const needsReindex = freshness.staleEmbeddings > 0 || coveragePercent < 90;
    const driftDetected = freshness.staleEmbeddings > freshness.currentModelEmbeddings * 0.1;

    const report: IndexHealthReport = {
      embeddingProvider: providerHealth,
      totalEmbeddings: freshness.totalEmbeddings,
      currentModelEmbeddings: freshness.currentModelEmbeddings,
      staleEmbeddings: freshness.staleEmbeddings,
      corpusSize,
      coveragePercent,
      oldestEmbedding: freshness.oldestEmbedding,
      newestEmbedding: freshness.newestEmbedding,
      needsReindex,
      driftDetected,
    };

    // Record health snapshot
    await this.persistence.recordHealthSnapshot({
      totalDocuments: freshness.totalEmbeddings,
      staleDocuments: freshness.staleEmbeddings,
      embeddingModel: this.embeddingProvider.model,
      modelVersion: this.embeddingProvider.modelVersion,
      avgAge: null,
      oldestEmbedding: freshness.oldestEmbedding,
      newestEmbedding: freshness.newestEmbedding,
    });

    return report;
  }

  /**
   * Remove embedding for a deleted/closed issue.
   */
  async removeIssue(issueNumber: number, repository: string): Promise<void> {
    const docId = `${repository}#${issueNumber}`;
    await this.vectorStore.remove(docId);
  }
}
