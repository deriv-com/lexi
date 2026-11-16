export interface VectorDocument {
  id: string;
  issueNumber: number;
  repository: string;
  text: string;
  updatedAt: string;
}

export interface SemanticMatch {
  issueNumber: number;
  similarity: number;
}

export type SemanticIndexStatus = "operational" | "disabled" | "empty";

export interface SemanticIndexHealth {
  status: SemanticIndexStatus;
  documentCount: number;
  /** Human-readable explanation, always populated for non-operational states. */
  detail: string;
}

/**
 * Provider abstraction for vector duplicate search. In-memory implementation
 * uses token overlap as a stand-in until pgvector or external backend is wired.
 */
export interface VectorIndexProvider {
  upsert(doc: VectorDocument): Promise<void>;
  remove(id: string): Promise<void>;
  search(query: string, topK: number): Promise<SemanticMatch[]>;
  health(): Promise<SemanticIndexHealth>;
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

export class InMemoryVectorIndexProvider implements VectorIndexProvider {
  private readonly docs = new Map<string, VectorDocument>();

  async upsert(doc: VectorDocument): Promise<void> {
    this.docs.set(doc.id, doc);
  }

  async remove(id: string): Promise<void> {
    this.docs.delete(id);
  }

  async search(query: string, topK: number): Promise<SemanticMatch[]> {
    const queryTokens = tokenSet(query);
    const scored: SemanticMatch[] = [];

    for (const doc of this.docs.values()) {
      const docTokens = tokenSet(doc.text);
      let overlap = 0;
      for (const t of queryTokens) {
        if (docTokens.has(t)) overlap += 1;
      }
      const union = new Set([...queryTokens, ...docTokens]).size;
      const similarity = union > 0 ? overlap / union : 0;
      if (similarity > 0) {
        scored.push({ issueNumber: doc.issueNumber, similarity });
      }
    }

    return scored.sort((a, b) => b.similarity - a.similarity).slice(0, topK);
  }

  async health(): Promise<SemanticIndexHealth> {
    const documentCount = this.docs.size;
    if (documentCount > 0) {
      return {
        status: "operational",
        documentCount,
        detail: `In-memory semantic index holds ${documentCount} document(s).`,
      };
    }
    return {
      status: "empty",
      documentCount: 0,
      detail:
        "The in-memory semantic index contains no documents: nothing has been indexed, so semantic matching cannot contribute and duplicate results are lexical-only.",
    };
  }
}

/**
 * Explicitly disabled semantic search.
 *
 * This exists because the previous behaviour was worse than having no semantic
 * stage at all: an in-memory index that nothing ever populated returned an
 * empty result set, which is indistinguishable from "searched and found
 * nothing". Callers believed duplicate detection was two-tier when it was
 * lexical-only. A disabled provider reports that fact instead of implying
 * coverage it does not have.
 */
export class DisabledVectorIndexProvider implements VectorIndexProvider {
  async upsert(): Promise<void> {
    // no-op: nothing is indexed while semantic search is disabled
  }

  async remove(): Promise<void> {
    // no-op
  }

  async search(): Promise<SemanticMatch[]> {
    return [];
  }

  async health(): Promise<SemanticIndexHealth> {
    return {
      status: "disabled",
      documentCount: 0,
      detail:
        "Semantic duplicate search is disabled (DUPLICATE_SEMANTIC_ENABLED=false). Duplicate detection is lexical-only; reworded duplicates will not be found.",
    };
  }
}
