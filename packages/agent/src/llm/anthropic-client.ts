import Anthropic from "@anthropic-ai/sdk";
import type {
  LlmCompleteOptions,
  LlmCompletion,
  LlmContentBlock,
  LlmMessage,
  LlmPort,
  LlmSystemSegment,
  LlmToolDefinition,
} from "./types";
import { textOf, toolUsesOf } from "./types";

/**
 * Anthropic Messages API client.
 *
 * Claude models are spoken to natively rather than through an OpenAI-compatible
 * translation layer. Such shims have been seen to map `stop_reason: "tool_use"`
 * onto `finish_reason: "tool_calls"` while dropping the tool_use block itself,
 * so the loop sees "no tool calls, no text" and ships an empty answer. Talking
 * to `/v1/messages` directly removes the translation and that failure class.
 */

/** Anthropic rejects a request with more than four `cache_control` breakpoints. */
export const ANTHROPIC_MAX_CACHE_BREAKPOINTS = 4;

/**
 * Non-streaming ceiling. A single HTTP request is held open for the whole
 * generation, and very long generations risk the SDK's request timeout, so
 * the default stays well under the model's maximum. Raise it only together
 * with a move to streaming.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

export interface LlmCachingOptions {
  /** Master switch for prompt caching. Defaults to on. */
  enabled?: boolean;
  /** Place a breakpoint on the last stable system segment. Defaults to on. */
  cacheSystemPrompt?: boolean;
  /** Place a breakpoint on the last tool schema. Defaults to on. */
  cacheToolSchemas?: boolean;
}

export interface LlmClientOptions {
  apiKey: string;
  /** Gateway or API base URL. Empty uses the SDK default. */
  baseURL: string;
  model: string;
  maxOutputTokens?: number;
  caching?: LlmCachingOptions;
  /**
   * Transport seam. Injecting `fetch` rather than mocking the client lets tests
   * drive the real SDK against scripted responses and assert on the real wire
   * shape.
   */
  fetch?: typeof globalThis.fetch;
}

const EPHEMERAL = { type: "ephemeral" as const };

interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export class AnthropicLlmClient implements LlmPort {
  private readonly sdk: Anthropic;

  constructor(private readonly options: LlmClientOptions) {
    this.sdk = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseURL.length > 0 ? options.baseURL : undefined,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  get model(): string {
    return this.options.model;
  }

  get baseURL(): string {
    return this.options.baseURL.length > 0 ? this.options.baseURL : "https://api.anthropic.com";
  }

  /**
   * The request body. No sampling parameters: current Claude models reject
   * `temperature` / `top_p` / `top_k` outright, and behaviour is steered by the
   * prompt instead.
   */
  buildRequest(messages: LlmMessage[], tools: LlmToolDefinition[], options: LlmCompleteOptions = {}): Record<string, unknown> {
    const system = this.buildSystem(options.system ?? []);
    const toolArray = this.buildTools(tools);
    const body: Record<string, unknown> = {
      model: options.model ?? this.options.model,
      max_tokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      messages,
      ...(system !== undefined ? { system } : {}),
      // Omitted rather than sent as an empty array: zero tools is a different
      // request from "no tools".
      ...(toolArray.length > 0 ? { tools: toolArray } : {}),
      ...(toolArray.length > 0 && options.toolChoice === "none" ? { tool_choice: { type: "none" } } : {}),
    };
    assertBreakpointBudget(body);
    return body;
  }

  async complete(messages: LlmMessage[], tools: LlmToolDefinition[], options: LlmCompleteOptions = {}): Promise<LlmCompletion> {
    const response = (await this.sdk.messages.create(
      this.buildRequest(messages, tools, options) as never,
      options.signal ? { signal: options.signal } : undefined,
    )) as unknown as {
      content?: LlmContentBlock[];
      stop_reason?: string | null;
      usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      } | null;
    };

    // Keep only the block types the loop understands. Anything else (for
    // example server-side tool blocks) would be echoed back on the next request
    // in a shape this client never produced.
    const content = (response.content ?? []).filter(
      (block) => block.type === "text" || block.type === "tool_use",
    );
    const usage = response.usage;

    return {
      message: { role: "assistant", content },
      text: textOf(content),
      toolUses: toolUsesOf(content),
      stopReason: response.stop_reason ?? null,
      usage: usage
        ? {
            promptTokens: usage.input_tokens,
            completionTokens: usage.output_tokens,
            totalTokens: usage.input_tokens + usage.output_tokens,
            // Absent when the gateway does not report cache accounting; zero is
            // the honest reading of that.
            cachedInputTokens: usage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
          }
        : null,
    };
  }

  private get cachingEnabled(): boolean {
    return this.options.caching?.enabled !== false;
  }

  /**
   * Stable segments first, volatile last, with one breakpoint closing the
   * stable prefix. Without caching the segments are sent as plain blocks.
   */
  private buildSystem(segments: LlmSystemSegment[]): SystemBlock[] | undefined {
    const kept = segments.filter((segment) => segment.text.trim().length > 0);
    if (kept.length === 0) return undefined;

    const stable = kept.filter((segment) => segment.cacheable);
    const volatile = kept.filter((segment) => !segment.cacheable);
    const blocks: SystemBlock[] = [...stable, ...volatile].map((segment) => ({ type: "text", text: segment.text }));

    if (this.cachingEnabled && this.options.caching?.cacheSystemPrompt !== false && stable.length > 0) {
      blocks[stable.length - 1] = { ...blocks[stable.length - 1], cache_control: EPHEMERAL };
    }
    return blocks;
  }

  /**
   * Marks the last tool schema, which closes the tool array as its own cached
   * prefix. Tools render before the system prompt, so this keeps the schemas
   * cached even on a turn where a volatile system segment changes. Marking every
   * tool would spend the breakpoint budget for nothing: the array is read and
   * written as one unit.
   */
  private buildTools(tools: LlmToolDefinition[]): unknown[] {
    if (!this.cachingEnabled || this.options.caching?.cacheToolSchemas === false || tools.length === 0) {
      return tools;
    }
    return tools.map((tool, index) => (index === tools.length - 1 ? { ...tool, cache_control: EPHEMERAL } : tool));
  }
}

/**
 * Counts every `cache_control` marker in a request body and throws past the
 * provider's ceiling. A request over the limit is rejected as a whole, so a
 * future change that adds its own breakpoint must fail loudly in tests rather
 * than take every turn down in production.
 */
export function countCacheBreakpoints(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + countCacheBreakpoints(item), 0);
  if (value === null || typeof value !== "object") return 0;
  let count = 0;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "cache_control" && entry) count += 1;
    else count += countCacheBreakpoints(entry);
  }
  return count;
}

function assertBreakpointBudget(body: Record<string, unknown>): void {
  const count = countCacheBreakpoints(body);
  if (count > ANTHROPIC_MAX_CACHE_BREAKPOINTS) {
    throw new Error(
      `Request has ${count} cache breakpoints; the provider accepts at most ${ANTHROPIC_MAX_CACHE_BREAKPOINTS}.`,
    );
  }
}
