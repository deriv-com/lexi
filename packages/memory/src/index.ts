/**
 * `@lexi/memory` — the Lexi memory subsystem.
 *
 * Four layers behind one seam: working memory, episodic memory,
 * semantic knowledge and a hierarchical buffer, composed by
 * `MemoryFacade` into the frozen `MemoryPort`.
 *
 * Consumers should import the `MemoryPort` *type* from
 * `@lexi/contracts` and inject `MEMORY_PORT_TOKEN` from here. Everything else
 * exported below is for the composition root and for tests.
 */

export { MEMORY_PORT_TOKEN, MEMORY_POLICY_TOKEN, THREAD_STATE_SERVICE_TOKEN, KNOWLEDGE_CHUNK_INDEXER_TOKEN } from "./tokens";

export {
  memoryPolicySchema,
  type MemoryPolicy,
  type MemoryBudgets,
  type MemoryVisibilityPolicy,
} from "./memory-policy.schema";
export { loadMemoryPolicy, parseMemoryPolicy, DEFAULT_MEMORY_POLICY_PATH } from "./load-memory-policy";

export { estimateTokens, estimateJsonTokens } from "./token-estimate";

// --- Working memory ---
export {
  ThreadStateService,
  mergeEntities,
  type ThreadStateStore,
  type ThreadStateProjection,
  type ThreadStateWrite,
  type TurnDigestInput,
  type TurnStateInput,
  type DecisionInput,
} from "./working/thread-state.service";
export { renderThreadState, type RenderedThreadState } from "./working/render-thread-state";
export {
  classifyDigestProtection,
  partitionForCompaction,
  promoteProtected,
  withAttribution,
  UNATTRIBUTED,
  type ProtectedClass,
  type ProtectedDigest,
  type CompactionPartition,
  type PromotionResult,
} from "./working/protected-content";

// --- Episodic memory ---
export {
  EpisodicMemoryService,
  termOverlap,
  authorityOf,
  selectQueryTerms,
  type MemoryEpisodeStore,
} from "./episodic/episodic-memory.service";
export {
  resolveRecallProfile,
  type RecallProfile,
  type RecallProfileName,
} from "./episodic/recall-profile";
export { renderEpisodeLine } from "./episodic/render-episode-line";
export {
  extractEpisodes,
  type TurnOutcome,
  type TurnToolCall,
  type TurnDecision,
  type ExtractionOptions,
} from "./episodic/deterministic-extractor";

// --- Semantic memory ---
export {
  KnowledgeChunkIndexer,
  chunkContent,
  computeContentHash,
  type KnowledgeChunkQueryExecutor,
  type KnowledgeSource,
  type KnowledgeSourceType,
  type KnowledgeMatch,
  type KnowledgeSearchOptions,
  type IndexResult,
} from "./semantic/knowledge-chunk.indexer";

// --- Hierarchical buffer ---
export {
  HierarchicalBuffer,
  isSummaryDigest,
  SUMMARY_PROJECTION_VERSION,
  type DigestSummariser,
  type CompactionResult,
} from "./buffer/hierarchical-buffer";

// --- The seam ---
export {
  MemoryFacade,
  type MemoryFacadeDeps,
  type MemoryLoggerPort,
  type WorkingMemoryWriteResult,
  type TurnWorkingMemoryOptions,
  type GovernanceMemoryPort,
  type KnowledgeSearchPort,
  type FacadeRecallQuery,
} from "./memory-facade.service";

// --- Database-backed stores and the composition factory ---
export {
  createPrismaMemoryEpisodeStore,
  createPrismaThreadStateStore,
  createPrismaKnowledgeChunkExecutor,
  type MemoryPrismaClient,
  type MemoryEpisodePrisma,
  type ThreadStatePrisma,
  type KnowledgeChunkPrisma,
} from "./prisma/prisma-memory-stores";
export {
  createPrismaMemoryFacade,
  createPrismaKnowledgeIndexer,
  resolveMemoryPolicy,
  MEMORY_POLICY_FILE,
  type PrismaMemoryFacadeOptions,
} from "./prisma/create-prisma-memory-facade";
export { createInMemoryMemoryPrisma, type InMemoryMemoryPrisma } from "./prisma/in-memory-prisma-client";
