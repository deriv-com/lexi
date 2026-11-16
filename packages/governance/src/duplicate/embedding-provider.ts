/**
 * Embedding generation provider interface and implementations.
 *
 * Embeddings are generated through the existing LiteLLM/OpenAI-compatible
 * gateway. The provider is model-version-aware: every embedding is tagged
 * with the model and version that produced it, enabling drift detection
 * and safe reindexing.
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

/**
 * Provider abstraction for embedding generation. Implementations call
 * an OpenAI-compatible embeddings endpoint (directly or via LiteLLM gateway).
 */
export interface EmbeddingProvider {
  /** Generate embedding for a single text. */
  embed(text: string): Promise<EmbeddingResult>;

  /** Generate embeddings for multiple texts in a single batch. */
  embedBatch(texts: string[]): Promise<EmbeddingBatchResult>;

  /** Health check — verifies the embedding endpoint is reachable. */
  health(): Promise<EmbeddingProviderHealth>;

  /** Current model identifier. */
  readonly model: string;

  /** Current model version string (for drift detection). */
  readonly modelVersion: string;

  /** Embedding dimensions produced by this model. */
  readonly dimensions: number;
}

export interface EmbeddingProviderConfig {
  /** OpenAI-compatible API key (or LiteLLM virtual key). */
  apiKey: string;
  /** Base URL for the embeddings endpoint (LiteLLM gateway or OpenAI direct). */
  baseUrl?: string;
  /** Model name to request (e.g., "text-embedding-3-small"). */
  model: string;
  /** Version tag for drift detection (e.g., "v3-small-2024"). */
  modelVersion: string;
  /** Expected dimensions (default 1536). */
  dimensions?: number;
  /** Maximum batch size per API call (default 100). */
  maxBatchSize?: number;
  /** Request timeout in ms (default 30000). */
  timeoutMs?: number;
}

/**
 * Production embedding provider calling an OpenAI-compatible embeddings API.
 * Works with OpenAI directly or through a LiteLLM gateway.
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly modelVersion: string;
  readonly dimensions: number;
  private readonly maxBatchSize: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: EmbeddingProviderConfig) {
    this.model = config.model;
    this.modelVersion = config.modelVersion;
    this.dimensions = config.dimensions ?? 1536;
    this.maxBatchSize = config.maxBatchSize ?? 100;
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const result = await this.embedBatch([text]);
    if (result.failedIndices.length > 0) {
      throw new Error(`Embedding generation failed for text`);
    }
    return result.embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    const embeddings: EmbeddingResult[] = [];
    const failedIndices: number[] = [];

    // Process in chunks respecting maxBatchSize
    for (let offset = 0; offset < texts.length; offset += this.maxBatchSize) {
      const chunk = texts.slice(offset, offset + this.maxBatchSize);
      try {
        const response = await this.callEmbeddingsApi(chunk);
        for (let i = 0; i < response.length; i++) {
          embeddings.push({
            embedding: response[i],
            model: this.model,
            modelVersion: this.modelVersion,
            dimensions: this.dimensions,
          });
        }
      } catch {
        // Mark all indices in this chunk as failed
        for (let i = 0; i < chunk.length; i++) {
          failedIndices.push(offset + i);
          embeddings.push({
            embedding: [],
            model: this.model,
            modelVersion: this.modelVersion,
            dimensions: this.dimensions,
          });
        }
      }
    }

    return { embeddings, failedIndices };
  }

  async health(): Promise<EmbeddingProviderHealth> {
    try {
      // Minimal health check: embed a trivial string
      await this.callEmbeddingsApi(["health check"]);
      return {
        available: true,
        model: this.model,
        modelVersion: this.modelVersion,
        detail: `Embedding endpoint reachable at ${this.baseUrl}`,
      };
    } catch (error) {
      return {
        available: false,
        model: this.model,
        modelVersion: this.modelVersion,
        detail: `Embedding endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async callEmbeddingsApi(input: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input,
          dimensions: this.dimensions,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Embedding API returned ${response.status}: ${body.slice(0, 200)}`);
      }

      const json = (await response.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
        usage?: { prompt_tokens?: number; total_tokens?: number };
      };

      // Sort by index to maintain input order
      const sorted = json.data.sort((a, b) => a.index - b.index);
      return sorted.map((d) => d.embedding);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Disabled embedding provider — used when no embedding API is configured.
 * Reports unavailable health without throwing.
 */
export class DisabledEmbeddingProvider implements EmbeddingProvider {
  readonly model = "none";
  readonly modelVersion = "disabled";
  readonly dimensions = 0;

  async embed(_text: string): Promise<EmbeddingResult> {
    throw new Error("Embedding provider is disabled (no EMBEDDING_API_KEY configured)");
  }

  async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    return {
      embeddings: texts.map(() => ({
        embedding: [],
        model: this.model,
        modelVersion: this.modelVersion,
        dimensions: 0,
      })),
      failedIndices: texts.map((_, i) => i),
    };
  }

  async health(): Promise<EmbeddingProviderHealth> {
    return {
      available: false,
      model: this.model,
      modelVersion: this.modelVersion,
      detail: "Embedding provider is disabled — no EMBEDDING_API_KEY or LITELLM_API_KEY configured.",
    };
  }
}
