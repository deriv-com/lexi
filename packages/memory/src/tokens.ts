/**
 * Nest DI tokens for the memory subsystem.
 *
 * `MEMORY_PORT_TOKEN` is what consumers inject. They depend on the
 * `MemoryPort` interface from `@lexi/contracts` and on this token — never on
 * `MemoryFacade` itself — so the implementation behind the seam can change
 * without touching a consumer.
 */
export const MEMORY_PORT_TOKEN = Symbol("MEMORY_PORT_TOKEN");
export const MEMORY_POLICY_TOKEN = Symbol("MEMORY_POLICY_TOKEN");
export const THREAD_STATE_SERVICE_TOKEN = Symbol("THREAD_STATE_SERVICE_TOKEN");
export const KNOWLEDGE_CHUNK_INDEXER_TOKEN = Symbol("KNOWLEDGE_CHUNK_INDEXER_TOKEN");
