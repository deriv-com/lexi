/**
 * DegradedVectorIndexProvider — used when pgvector infrastructure exists
 * but is temporarily unavailable (connection failure, extension missing, etc.).
 *
 * Distinction from DisabledVectorIndexProvider:
 * - Disabled: admin intentionally turned off semantic search (DUPLICATE_SEMANTIC_ENABLED=false)
 * - Degraded: semantic search is enabled but infrastructure is unavailable
 *
 * The degraded provider:
 * 1. Reports the specific reason for degradation in health()
 * 2. Does not throw on upsert/remove (queues would lose data)
 * 3. Returns empty results on search (with explanation)
 * 4. Enables downstream callers to distinguish between "nothing found"
 *    and "could not search"
 */

import type { VectorIndexProvider, VectorDocument, SemanticMatch, SemanticIndexHealth } from "./semantic-index";

export class DegradedVectorIndexProvider implements VectorIndexProvider {
  constructor(private readonly reason: string) {}

  async upsert(_doc: VectorDocument): Promise<void> {
    // Silently accept — embeddings will be generated on next healthy backfill.
    // We don't want callers to fail just because the vector store is temporarily down.
  }

  async remove(_id: string): Promise<void> {
    // Silently accept
  }

  async search(_query: string, _topK: number): Promise<SemanticMatch[]> {
    return [];
  }

  async health(): Promise<SemanticIndexHealth> {
    return {
      status: "disabled",
      documentCount: 0,
      detail: `Semantic search degraded (infrastructure unavailable): ${this.reason}. Duplicate detection is lexical-only; reworded duplicates will not be found.`,
    };
  }
}
