import { describe, it, expect, beforeEach, vi } from "vitest";
import { KnowledgeChunkIndexer, chunkContent, computeContentHash } from "./knowledge-chunk.indexer";
import { parseMemoryPolicy } from "../load-memory-policy";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Semantic memory indexing.
 *
 * The corpus extends beyond issues to repo docs, approved specs and skill
 * references. The cost rule that governs it: content-hash dedup means
 * unchanged content is never re-embedded. Nothing is left unindexed to save
 * money — the saving comes from not paying twice for the same bytes.
 */

const policy = parseMemoryPolicy(
  readFileSync(resolve(__dirname, "../../../../examples/config/memory-policy.yaml"), "utf-8"),
);

function createDb() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    executed: [] as string[],
    async $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
      this.executed.push(query);
      if (query.includes("SELECT") && query.includes("contentHash")) {
        // Dedup probe: which of these hashes do we already hold?
        const hashes = values.flat() as string[];
        return rows
          .filter((r) => hashes.includes(String(r.contentHash)))
          .map((r) => ({ contentHash: r.contentHash })) as unknown as T;
      }
      return [] as unknown as T;
    },
    async $executeRawUnsafe(query: string, ...values: unknown[]) {
      this.executed.push(query);
      if (query.includes("INSERT INTO knowledge_chunks")) {
        rows.push({
          id: values[0],
          sourceType: values[1],
          sourceRef: values[2],
          repo: values[3],
          content: values[4],
          contentHash: values[5],
        });
      }
      return 1;
    },
  };
}

function createEmbedder() {
  return {
    model: "text-embedding-3-small",
    modelVersion: "v3-small-2024",
    dimensions: 1536,
    embed: vi.fn(async () => ({
      embedding: new Array(1536).fill(0.1),
      model: "text-embedding-3-small",
      modelVersion: "v3-small-2024",
      dimensions: 1536,
    })),
    embedBatch: vi.fn(async (texts: string[]) => ({
      embeddings: texts.map(() => ({
        embedding: new Array(1536).fill(0.1),
        model: "text-embedding-3-small",
        modelVersion: "v3-small-2024",
        dimensions: 1536,
      })),
      failedIndices: [],
    })),
    health: vi.fn(async () => ({ available: true, model: "m", modelVersion: "v", detail: "ok" })),
  };
}

describe("computeContentHash", () => {
  it("is stable for identical content", () => {
    expect(computeContentHash("hello world")).toBe(computeContentHash("hello world"));
  });

  it("differs for different content", () => {
    expect(computeContentHash("hello world")).not.toBe(computeContentHash("hello worlds"));
  });
});

describe("chunkContent", () => {
  it("returns a single chunk for short content", () => {
    expect(chunkContent("a short doc", 500)).toHaveLength(1);
  });

  it("splits long content into multiple chunks", () => {
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} with some explanatory prose in it.`).join("\n\n");
    const chunks = chunkContent(long, 400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(400);
  });

  it("drops empty content rather than indexing nothing", () => {
    expect(chunkContent("   \n\n  ", 500)).toEqual([]);
  });

  it("never loses content across the split", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const rejoined = chunkContent(long, 100).join("\n");
    expect(rejoined.replace(/\s+/g, " ")).toContain("line 29");
  });
});

describe("KnowledgeChunkIndexer — content-hash dedup (L6)", () => {
  let db: ReturnType<typeof createDb>;
  let embedder: ReturnType<typeof createEmbedder>;
  let indexer: KnowledgeChunkIndexer;

  beforeEach(() => {
    db = createDb();
    embedder = createEmbedder();
    indexer = new KnowledgeChunkIndexer(db, embedder, policy);
  });

  it("indexes new content", async () => {
    const result = await indexer.index([
      { sourceType: "repo_doc", sourceRef: "README.md", repo: "acme/web-app", content: "The deposit flow lives in src/deposit." },
    ]);

    expect(result.indexed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(db.rows).toHaveLength(1);
  });

  it("never re-embeds unchanged content", async () => {
    const source = {
      sourceType: "repo_doc" as const,
      sourceRef: "README.md",
      repo: "acme/web-app",
      content: "The deposit flow lives in src/deposit.",
    };

    await indexer.index([source]);
    const callsAfterFirst = embedder.embedBatch.mock.calls.length;

    const second = await indexer.index([source]);

    expect(second.skipped).toBe(1);
    expect(second.indexed).toBe(0);
    // The whole point of L6: identical bytes cost nothing the second time.
    expect(embedder.embedBatch.mock.calls.length).toBe(callsAfterFirst);
  });

  it("re-embeds when the content actually changes", async () => {
    const base = { sourceType: "repo_doc" as const, sourceRef: "README.md", repo: "acme/web-app" };
    await indexer.index([{ ...base, content: "original text about deposits" }]);
    const result = await indexer.index([{ ...base, content: "revised text about deposits and withdrawals" }]);

    expect(result.indexed).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("batches embedding calls rather than issuing one per chunk", async () => {
    // Indexing batches rather than issuing per-chunk calls.
    const long = Array.from({ length: 40 }, (_, i) => `Section ${i}: prose about the product that is long enough to split.`).join("\n\n");
    await indexer.index([{ sourceType: "repo_doc", sourceRef: "BIG.md", repo: "r", content: long }]);

    expect(embedder.embedBatch.mock.calls.length).toBeGreaterThan(0);
    expect(embedder.embed.mock.calls.length).toBe(0);
    // Far fewer batch calls than chunks.
    expect(embedder.embedBatch.mock.calls.length).toBeLessThan(10);
  });

  it("respects the policy's embedding batch size", async () => {
    const long = Array.from({ length: 200 }, (_, i) => `Section ${i}: prose that is long enough to become its own chunk here.`).join("\n\n");
    await indexer.index([{ sourceType: "repo_doc", sourceRef: "HUGE.md", repo: "r", content: long }]);

    for (const call of embedder.embedBatch.mock.calls) {
      expect((call[0] as string[]).length).toBeLessThanOrEqual(policy.semantic.embeddingBatchSize);
    }
  });

  it("indexes specs and skill references, not just repo docs", async () => {
    const result = await indexer.index([
      { sourceType: "spec", sourceRef: "spec-42", content: "Approved spec: deposit retry behaviour." },
      { sourceType: "skill_reference", sourceRef: "accessibility/wcag.md", content: "WCAG 2.2 AA is the floor." },
    ]);
    expect(result.indexed).toBe(2);
  });

  it("skips a source with no usable content instead of embedding whitespace", async () => {
    const result = await indexer.index([{ sourceType: "repo_doc", sourceRef: "EMPTY.md", content: "   \n  " }]);
    expect(result.indexed).toBe(0);
    expect(embedder.embedBatch.mock.calls.length).toBe(0);
  });

  it("reports failures without aborting the whole run", async () => {
    embedder.embedBatch = vi.fn(async () => {
      throw new Error("gateway 503");
    });
    const result = await indexer.index([{ sourceType: "repo_doc", sourceRef: "A.md", content: "some indexable content here" }]);

    expect(result.failed).toBeGreaterThan(0);
    expect(result.indexed).toBe(0);
  });
});

describe("KnowledgeChunkIndexer — search", () => {
  it("returns matches above the similarity floor", async () => {
    const db = createDb();
    db.$queryRawUnsafe = (async (query: string) => {
      if (query.includes("similarity")) {
        return [
          { id: "c1", sourceType: "repo_doc", sourceRef: "README.md", repo: "r", content: "deposit flow", similarity: 0.82 },
          { id: "c2", sourceType: "repo_doc", sourceRef: "OTHER.md", repo: "r", content: "unrelated", similarity: 0.05 },
        ];
      }
      return [];
    }) as never;

    const indexer = new KnowledgeChunkIndexer(db, createEmbedder(), policy);
    const results = await indexer.search("how does deposit work");

    expect(results.map((r) => r.id)).toEqual(["c1"]);
  });

  it("scopes a search to one repo when asked", async () => {
    const db = createDb();
    let seenParams: unknown[] = [];
    db.$queryRawUnsafe = (async (query: string, ...values: unknown[]) => {
      seenParams = values;
      return [];
    }) as never;

    const indexer = new KnowledgeChunkIndexer(db, createEmbedder(), policy);
    await indexer.search("deposit", { repo: "acme/web-app" });

    expect(seenParams).toContain("acme/web-app");
  });

  it("degrades to an empty result when pgvector is unavailable", async () => {
    // Semantic memory is advisory context. A missing extension must
    // cost the answer some quality, not take the turn down.
    const db = createDb();
    db.$queryRawUnsafe = (async () => {
      throw new Error('type "vector" does not exist');
    }) as never;

    const indexer = new KnowledgeChunkIndexer(db, createEmbedder(), policy);
    await expect(indexer.search("deposit")).resolves.toEqual([]);
  });
});
