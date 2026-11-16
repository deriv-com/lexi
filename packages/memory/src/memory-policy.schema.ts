import { z } from "zod";

/**
 * Schema for `config/memory-policy.yaml`.
 *
 * `.strict()` on every object is load-bearing rather than fastidious: the
 * design forbids spend caps and capability rationing outright, so a stray
 * `dailyLimitUsd` or `maxSpend` key must fail the boot loudly instead of
 * being silently ignored until someone assumes it is enforced. The same
 * strictness catches typo'd budget keys, which would otherwise fall back to a
 * default and quietly widen the cap.
 */

const budgetsSchema = z
  .object({
    /** Hard cap on the rendered memory pack. */
    maxMemoryTokens: z.number().int().positive().default(1500),
    /** Per-thread working memory, a subset of the above. */
    maxThreadStateTokens: z.number().int().positive().default(800),
    /** Digests kept verbatim before the hierarchical buffer compresses. */
    maxDigestsBeforeCompaction: z.number().int().positive().default(20),
    /** Episodes one recall may return before relevance ranking truncates. */
    maxEpisodesPerRecall: z.number().int().positive().default(10),
  })
  .strict();

const retentionSchema = z
  .object({
    episodeDays: z.number().int().positive().default(90),
    supersededDigestDays: z.number().int().positive().default(365),
    minImportanceToRetain: z.number().min(0).max(1).default(0.3),
  })
  .strict();

const extractionSchema = z
  .object({
    /** Structured outcomes are extracted by plain code — no model call. */
    deterministic: z.boolean().default(true),
    /** Free-text extraction needs a model, so it never runs on the fast path. */
    llmFreeText: z.boolean().default(false),
    skipOnFastPath: z.boolean().default(true),
  })
  .strict();

const visibilitySchema = z
  .object({
    orgKinds: z.array(z.string().min(1)).default([]),
    userKinds: z.array(z.string().min(1)).default([]),
    /** DM-derived content is never written at org scope, whatever its kind. */
    dmDerivedIsUserScoped: z.boolean().default(true),
  })
  .strict();

const semanticSchema = z
  .object({
    sources: z.array(z.string().min(1)).default([]),
    /** L6 content-hash dedup: identical content is never re-embedded. */
    dedupeByContentHash: z.boolean().default(true),
    embeddingBatchSize: z.number().int().positive().default(50),
  })
  .strict();

export const memoryPolicySchema = z
  .object({
    version: z.string().min(1),
    /** MEMORY_ENABLED. Ships off: a new capability that writes data is opt-in. */
    enabled: z.boolean().default(false),
    budgets: budgetsSchema.prefault({}),
    retention: retentionSchema.prefault({}),
    extraction: extractionSchema.prefault({}),
    visibility: visibilitySchema.prefault({}),
    semantic: semanticSchema.prefault({}),
  })
  .strict();

export type MemoryPolicy = z.infer<typeof memoryPolicySchema>;
export type MemoryBudgets = z.infer<typeof budgetsSchema>;
export type MemoryVisibilityPolicy = z.infer<typeof visibilitySchema>;
