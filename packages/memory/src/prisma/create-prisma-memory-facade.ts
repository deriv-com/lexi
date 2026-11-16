import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EmbeddingProvider } from "@lexi/contracts";
import { EpisodicMemoryService } from "../episodic/episodic-memory.service";
import { loadMemoryPolicy } from "../load-memory-policy";
import {
  MemoryFacade,
  type GovernanceMemoryPort,
  type KnowledgeSearchPort,
  type MemoryLoggerPort,
} from "../memory-facade.service";
import { memoryPolicySchema, type MemoryPolicy } from "../memory-policy.schema";
import { KnowledgeChunkIndexer } from "../semantic/knowledge-chunk.indexer";
import { ThreadStateService } from "../working/thread-state.service";
import type { HierarchicalBuffer } from "../buffer/hierarchical-buffer";
import {
  createPrismaKnowledgeChunkExecutor,
  createPrismaMemoryEpisodeStore,
  createPrismaThreadStateStore,
  type KnowledgeChunkPrisma,
  type MemoryPrismaClient,
} from "./prisma-memory-stores";

/** File name read from the governance config directory. */
export const MEMORY_POLICY_FILE = "memory-policy.yaml";

const LOG_CONTEXT = "MemoryFacade";

export interface PrismaMemoryFacadeOptions {
  /**
   * A policy already loaded by the caller. When omitted, `memory-policy.yaml`
   * is read from `configDir`.
   */
  policy?: MemoryPolicy;
  /**
   * Directory holding `memory-policy.yaml`. Defaults to `GOVERNANCE_CONFIG_DIR`,
   * then `./config`, read when the factory runs rather than when the module
   * loads, so a caller that sets the variable during boot is honoured.
   */
  configDir?: string;
  /** Write-path observability; `PinoLoggerService` and Nest's `Logger` both fit. */
  logger?: MemoryLoggerPort;
  /** Issue memory, user profiles and the engineering knowledge graph. Optional. */
  governance?: GovernanceMemoryPort;
  /** Indexed product knowledge. See `createPrismaKnowledgeIndexer`. Optional. */
  knowledge?: KnowledgeSearchPort;
  /** Hierarchical compaction; needs a summariser backed by a cheap model. Optional. */
  buffer?: HierarchicalBuffer;
}

/**
 * Builds the memory facade on the application database.
 *
 * The returned `MemoryFacade` implements `MemoryPort` and also exposes the two
 * forget operations, so it satisfies the agent's memory-tools port as is.
 *
 * Policy resolution is deliberately asymmetric:
 *
 *  - **No policy file** means memory was never configured for this
 *    deployment. The facade is built with the schema defaults, which leave
 *    memory switched off, and one line says so. Failing the boot here would
 *    make an optional feature a hard requirement of every install.
 *  - **An invalid policy file** throws. Someone tried to configure memory and
 *    got it wrong — a typo'd budget or a stray key — and running with a
 *    silently different budget than the one they wrote is worse than not
 *    starting.
 */
export function createPrismaMemoryFacade(
  prisma: MemoryPrismaClient,
  options: PrismaMemoryFacadeOptions = {},
): MemoryFacade {
  const policy = options.policy ?? resolveMemoryPolicy(options.configDir, options.logger);

  const facade = new MemoryFacade({
    policy,
    threadState: new ThreadStateService(createPrismaThreadStateStore(prisma)),
    episodic: new EpisodicMemoryService(createPrismaMemoryEpisodeStore(prisma), policy),
    ...(options.governance ? { governance: options.governance } : {}),
    ...(options.knowledge ? { knowledge: options.knowledge } : {}),
    ...(options.buffer ? { buffer: options.buffer } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });

  options.logger?.log(
    policy.enabled
      ? `Memory enabled (policy ${policy.version}, ${policy.budgets.maxMemoryTokens}-token recall budget).`
      : `Memory is switched off by policy ${policy.version}: recall returns nothing and writes are dropped.`,
    LOG_CONTEXT,
  );

  return facade;
}

/**
 * Semantic search over `knowledge_chunks`, for the facade's `knowledge` slot
 * and for the agent's product-knowledge tool. Needs an embedding provider,
 * which is why it is separate from the facade factory: a deployment without
 * one still gets working and episodic memory.
 */
export function createPrismaKnowledgeIndexer(
  prisma: KnowledgeChunkPrisma,
  embedder: EmbeddingProvider,
  policy: MemoryPolicy,
): KnowledgeChunkIndexer {
  return new KnowledgeChunkIndexer(createPrismaKnowledgeChunkExecutor(prisma), embedder, policy);
}

/**
 * Loads `memory-policy.yaml` from the config directory, or the switched-off
 * defaults when the file does not exist. See `createPrismaMemoryFacade` for
 * why a missing file and an invalid one are treated differently.
 */
export function resolveMemoryPolicy(configDir?: string, logger?: MemoryLoggerPort): MemoryPolicy {
  const dir = configDir ?? process.env.GOVERNANCE_CONFIG_DIR ?? "config";
  const path = join(dir, MEMORY_POLICY_FILE);

  if (!existsSync(path)) {
    logger?.warn(`No ${MEMORY_POLICY_FILE} in ${dir}; memory stays switched off.`, LOG_CONTEXT);
    return memoryPolicySchema.parse({ version: "default" });
  }

  return loadMemoryPolicy(path);
}
