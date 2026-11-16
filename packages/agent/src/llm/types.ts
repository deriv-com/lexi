import type { ToolDefinition, ToolImageMediaType } from "../tools/agent-tool";

/**
 * The transport-neutral LLM surface the agent loop builds against.
 *
 * Content blocks are Anthropic-shaped because that is the richer of the two
 * wire formats: it has first-class tool_use / tool_result blocks and images in
 * tool results. The OpenAI-compatible client translates to and from this shape
 * at its own boundary, so the loop only ever filters on `type`.
 *
 * The blocks are declared structurally rather than imported from an SDK so the
 * contract is readable here and stable across SDK minor versions.
 */

export type LlmImageSource = { type: "base64"; media_type: ToolImageMediaType; data: string };

export type LlmTextBlock = { type: "text"; text: string };
export type LlmImageBlock = { type: "image"; source: LlmImageSource };
export type LlmToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type LlmToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<LlmTextBlock | LlmImageBlock>;
  is_error?: boolean;
};

export type LlmContentBlock = LlmTextBlock | LlmImageBlock | LlmToolUseBlock | LlmToolResultBlock;

export type LlmMessage =
  | { role: "user"; content: string | LlmContentBlock[] }
  | { role: "assistant"; content: string | LlmContentBlock[] };

/** Tool schemas use the Anthropic `input_schema` envelope at this layer. */
export type LlmToolDefinition = ToolDefinition;

/** A tool call the model requested, with `input` already parsed. */
export interface LlmToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Token accounting for one completion.
 *
 * Cache reads and cache writes are reported separately from fresh input
 * because they bill at different rates, and a cache hit rate cannot be measured
 * at all once they are folded into one number. `promptTokens` is the uncached
 * remainder; the full prompt is the sum of the three.
 */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * Why generation stopped: `end_turn`, `tool_use`, `max_tokens`, `refusal`, or
 * whatever else the provider reports. Read it before trusting `text`: a
 * refusal can arrive as a successful response with empty content, and
 * `max_tokens` means the answer was cut off rather than absent.
 */
export type LlmStopReason = string;

export interface LlmCompletion {
  /** The assistant turn, ready to append to the transcript verbatim. */
  message: { role: "assistant"; content: LlmContentBlock[] };
  /** Every text block concatenated; an empty string when the model wrote none. */
  text: string;
  /** Tool calls requested this turn. Empty when the model is answering. */
  toolUses: LlmToolUse[];
  stopReason: LlmStopReason | null;
  usage: LlmUsage | null;
}

/** A system-prompt segment plus whether it is stable enough to sit in the cached prefix. */
export interface LlmSystemSegment {
  text: string;
  /**
   * Stable across turns (base prompt, tool guidance). Per-turn content must be
   * `false`: caching is a prefix match, so a volatile segment inside the prefix
   * would invalidate it on every request.
   */
  cacheable: boolean;
}

export interface LlmCompleteOptions {
  /** Overrides the client's configured model for this request. */
  model?: string;
  /** System prompt split into stable and volatile segments. Blank segments are dropped. */
  system?: LlmSystemSegment[];
  /**
   * `none` keeps the tool schemas in the request (providers reject a transcript
   * containing tool calls when no tools are declared) but forbids new calls, so
   * the model has to answer from what it already has.
   */
  toolChoice?: "auto" | "none";
  /** Aborts the in-flight request. */
  signal?: AbortSignal;
}

export interface LlmPort {
  /** The model this client sends when no override is given. */
  readonly model: string;
  /** The base URL requests go to, for diagnostics. */
  readonly baseURL: string;
  complete(messages: LlmMessage[], tools: LlmToolDefinition[], options?: LlmCompleteOptions): Promise<LlmCompletion>;
}

/** Joins the text blocks of a content array. */
export function textOf(content: string | LlmContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is LlmTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** The tool_use blocks of a content array, as parsed calls. */
export function toolUsesOf(content: LlmContentBlock[]): LlmToolUse[] {
  return content
    .filter((block): block is LlmToolUseBlock => block.type === "tool_use")
    .map((block) => ({ id: block.id, name: block.name, input: block.input ?? {} }));
}
