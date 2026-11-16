/**
 * The embedding port. Implementations call an OpenAI-compatible embeddings
 * endpoint, directly or through a gateway. Memory indexing and duplicate
 * detection both depend on this interface, never on a concrete client.
 */

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  modelVersion: string;
  dimensions: number;
  tokenCount?: number;
}

export interface EmbeddingBatchResult {
  embeddings: EmbeddingResult[];
  failedIndices: number[];
}

export interface EmbeddingProviderHealth {
  available: boolean;
  model: string;
  modelVersion: string;
  detail: string;
}

export interface EmbeddingProvider {
  /** Generate an embedding for a single text. */
  embed(text: string): Promise<EmbeddingResult>;
  /** Generate embeddings for several texts in one request. */
  embedBatch(texts: string[]): Promise<EmbeddingBatchResult>;
  /** Verify the embedding endpoint is reachable. */
  health(): Promise<EmbeddingProviderHealth>;
  /** Current model identifier. */
  readonly model: string;
  /** Current model version string, for drift detection. */
  readonly modelVersion: string;
  /** Dimensions of the vectors this model produces. */
  readonly dimensions: number;
}
