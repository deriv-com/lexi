import { createHash, randomUUID } from "node:crypto";
import type { EmbeddingProvider } from "@lexi/contracts";
import type { MemoryPolicy } from "../memory-policy.schema";

/**
 * Semantic memory over the product corpus.
 *
 * Reuses the pgvector infrastructure that already backs issue dedup rather
 * than standing up a second vector store — same extension, same embedding
 * provider, different table. The corpus extends beyond issues to repo docs,
 * approved specs and vendored skill references, which is what turns "ask Lexi
 * about the apps" into something better than grep over two repos.
 *
 * Raw SQL for the same reason `PgVectorIndexProvider` uses it: the `embedding`
 * column is `Unsupported("vector(1536)")`, which the Prisma client cannot read
 * or write through its typed API.
 *
 * Cost posture: nothing is left unindexed to save money. The
 * saving comes from never paying twice for identical bytes — `contentHash`
 * dedup — and from batching rather than issuing one call per chunk.
 */

/** Minimal raw-query port, mirroring `PgVectorQueryExecutor` in governance. */
export interface KnowledgeChunkQueryExecutor {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** Corpus source types, matching the frozen `KnowledgeChunk.sourceType`. */
export type KnowledgeSourceType = "repo_doc" | "spec" | "skill_reference" | "issue";

/** One document to index. Chunking and hashing happen here. */
export interface KnowledgeSource {
  sourceType: KnowledgeSourceType;
  /** Stable identifier — file path, spec id, skill reference path. */
  sourceRef: string;
  /** `owner/name` slug for repo-scoped sources. */
  repo?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface IndexResult {
  indexed: number;
  /** Chunks whose content hash was already present — the L6 saving. */
  skipped: number;
  failed: number;
}

/** One search hit. */
export interface KnowledgeMatch {
  id: string;
  sourceType: string;
  sourceRef: string;
  repo?: string;
  content: string;
  similarity: number;
}

export interface KnowledgeSearchOptions {
  /** Restrict to one repo slug. */
  repo?: string;
  /** Restrict to one corpus source type. */
  sourceType?: KnowledgeSourceType;
  limit?: number;
}

/** Chunk ceiling in characters — roughly 200 tokens of context per chunk. */
const DEFAULT_CHUNK_CHARS = 800;

/** Cosine-similarity floor. Below this a "match" is noise dressed as context. */
const MIN_SIMILARITY = 0.3;

const DEFAULT_SEARCH_LIMIT = 5;

export class KnowledgeChunkIndexer {
  constructor(
    private readonly db: KnowledgeChunkQueryExecutor,
    private readonly embedder: EmbeddingProvider,
    private readonly policy: MemoryPolicy,
    private readonly chunkChars: number = DEFAULT_CHUNK_CHARS,
  ) {}

  /**
   * Indexes sources, embedding only what is genuinely new.
   *
   * Every chunk is hashed first and the existing hashes are looked up in one
   * query, so a re-index of an unchanged repo costs a single SELECT and zero
   * embedding calls.
   */
  async index(sources: KnowledgeSource[]): Promise<IndexResult> {
    const pending: Array<{ source: KnowledgeSource; content: string; contentHash: string }> = [];

    for (const source of sources) {
      for (const content of chunkContent(source.content, this.chunkChars)) {
        pending.push({ source, content, contentHash: computeContentHash(content) });
      }
    }

    if (pending.length === 0) return { indexed: 0, skipped: 0, failed: 0 };

    const known = this.policy.semantic.dedupeByContentHash
      ? await this.existingHashes(pending.map((p) => p.contentHash))
      : new Set<string>();

    const fresh = pending.filter((p) => !known.has(p.contentHash));
    const skipped = pending.length - fresh.length;

    let indexed = 0;
    let failed = 0;

    for (const batch of batches(fresh, this.policy.semantic.embeddingBatchSize)) {
      try {
        const embeddings = await this.embedder.embedBatch(batch.map((item) => item.content));

        for (let i = 0; i < batch.length; i += 1) {
          if (embeddings.failedIndices.includes(i)) {
            failed += 1;
            continue;
          }
          const vector = embeddings.embeddings[i];
          if (!vector) {
            failed += 1;
            continue;
          }
          await this.persist(batch[i], vector.embedding);
          indexed += 1;
        }
      } catch {
        // One bad batch — a gateway blip, a rate limit — must not discard the
        // batches that succeeded. The count is reported so the caller can
        // retry just the shortfall.
        failed += batch.length;
      }
    }

    return { indexed, skipped, failed };
  }

  /**
   * Cosine search over the chunk corpus.
   *
   * Returns `[]` rather than throwing when the vector extension or table is
   * unavailable: semantic memory is advisory context, so its absence
   * degrades the answer instead of failing the turn.
   */
  async search(query: string, options: KnowledgeSearchOptions = {}): Promise<KnowledgeMatch[]> {
    try {
      const embedded = await this.embedder.embed(query);
      const vector = `[${embedded.embedding.join(",")}]`;

      const filters: string[] = ["embedding IS NOT NULL"];
      const params: unknown[] = [vector];

      if (options.repo) {
        params.push(options.repo);
        filters.push(`"repo" = $${params.length}`);
      }
      if (options.sourceType) {
        params.push(options.sourceType);
        filters.push(`"sourceType" = $${params.length}`);
      }

      params.push(options.limit ?? DEFAULT_SEARCH_LIMIT);
      const limitParam = `$${params.length}`;

      const rows = await this.db.$queryRawUnsafe<
        Array<{ id: string; sourceType: string; sourceRef: string; repo: string | null; content: string; similarity: number }>
      >(
        `SELECT "id", "sourceType", "sourceRef", "repo", "content", 1 - ("embedding" <=> $1::vector) as similarity
         FROM knowledge_chunks
         WHERE ${filters.join(" AND ")}
         ORDER BY "embedding" <=> $1::vector
         LIMIT ${limitParam}`,
        ...params,
      );

      return (rows ?? [])
        .filter((row) => row.similarity >= MIN_SIMILARITY)
        .map((row) => ({
          id: row.id,
          sourceType: row.sourceType,
          sourceRef: row.sourceRef,
          repo: row.repo ?? undefined,
          content: row.content,
          similarity: row.similarity,
        }));
    } catch {
      return [];
    }
  }

  /** One query for every candidate hash — the cheap half of L6. */
  private async existingHashes(hashes: string[]): Promise<Set<string>> {
    if (hashes.length === 0) return new Set();
    try {
      const unique = [...new Set(hashes)];
      const placeholders = unique.map((_, i) => `$${i + 1}`).join(", ");
      const rows = await this.db.$queryRawUnsafe<Array<{ contentHash: string }>>(
        `SELECT "contentHash" FROM knowledge_chunks WHERE "contentHash" IN (${placeholders})`,
        ...unique,
      );
      return new Set((rows ?? []).map((row) => row.contentHash));
    } catch {
      // Unknown state is treated as "not indexed": re-embedding costs money,
      // skipping wrongly costs knowledge, and knowledge is the thing this
      // design refuses to ration.
      return new Set();
    }
  }

  private async persist(
    item: { source: KnowledgeSource; content: string; contentHash: string },
    embedding: number[],
  ): Promise<void> {
    await this.db.$executeRawUnsafe(
      `INSERT INTO knowledge_chunks ("id", "sourceType", "sourceRef", "repo", "content", "contentHash", "embedding", "metadata", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8::jsonb, NOW())
       ON CONFLICT ("sourceType", "sourceRef", "contentHash") DO NOTHING`,
      randomUUID(),
      item.source.sourceType,
      item.source.sourceRef,
      item.source.repo ?? null,
      item.content,
      item.contentHash,
      `[${embedding.join(",")}]`,
      JSON.stringify(item.source.metadata ?? {}),
    );
  }
}

/**
 * Stable content hash. Same construction as `computeTextHash` in the duplicate
 * package — sha256, truncated — so the two dedup surfaces behave alike.
 */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

/**
 * Splits a document into embeddable chunks on paragraph boundaries where it
 * can, and mid-paragraph only when a single paragraph is itself oversized.
 * Splitting on meaning rather than a fixed stride keeps each chunk a coherent
 * answer to a question.
 */
export function chunkContent(content: string, maxChars: number = DEFAULT_CHUNK_CHARS): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  const paragraphs = trimmed.split(/\n{2,}/).flatMap((paragraph) => splitOversized(paragraph.trim(), maxChars));

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (!paragraph) continue;
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/** Hard-wraps a paragraph that exceeds the ceiling on its own, on line breaks. */
function splitOversized(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];

  const parts: string[] = [];
  let current = "";

  for (const line of paragraph.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxChars && current) {
      parts.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);

  // A single line longer than the ceiling still has to be cut somewhere.
  return parts.flatMap((part) =>
    part.length <= maxChars ? [part] : (part.match(new RegExp(`.{1,${maxChars}}`, "g")) ?? [part]),
  );
}

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
