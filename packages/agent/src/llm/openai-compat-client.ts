import OpenAI from "openai";
import { DEFAULT_MAX_OUTPUT_TOKENS, type LlmClientOptions } from "./anthropic-client";
import type {
  LlmCompleteOptions,
  LlmCompletion,
  LlmContentBlock,
  LlmMessage,
  LlmPort,
  LlmSystemSegment,
  LlmToolDefinition,
  LlmToolUseBlock,
  LlmUsage,
} from "./types";
import { textOf, toolUsesOf } from "./types";

/**
 * OpenAI-compatible Chat Completions client for non-Claude models.
 *
 * It speaks real `tool_calls` and `role: "tool"` messages and normalises every
 * response back to the Anthropic-shaped blocks the loop uses, so the loop has
 * one transcript format regardless of provider.
 */

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;
type ChatContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

export class OpenAiCompatLlmClient implements LlmPort {
  private readonly sdk: OpenAI;

  constructor(private readonly options: LlmClientOptions) {
    this.sdk = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL.length > 0 ? options.baseURL : undefined,
      ...(options.fetch ? { fetch: options.fetch as never } : {}),
    });
  }

  get model(): string {
    return this.options.model;
  }

  get baseURL(): string {
    return this.options.baseURL.length > 0 ? this.options.baseURL : "https://api.openai.com/v1";
  }

  buildRequest(messages: LlmMessage[], tools: LlmToolDefinition[], options: LlmCompleteOptions = {}): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: options.model ?? this.options.model,
      max_tokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      messages: toChatMessages(messages, joinSystem(options.system ?? [])),
    };
    if (tools.length > 0) {
      body.tools = tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
      }));
      if (options.toolChoice === "none") body.tool_choice = "none";
    }
    return body;
  }

  async complete(messages: LlmMessage[], tools: LlmToolDefinition[], options: LlmCompleteOptions = {}): Promise<LlmCompletion> {
    const response = (await this.sdk.chat.completions.create(
      this.buildRequest(messages, tools, options) as never,
      options.signal ? { signal: options.signal } : undefined,
    )) as unknown as ChatResponse;

    const choice = response.choices?.[0];
    const message = choice?.message ?? {};
    const toolCalls = message.tool_calls ?? [];

    // A response that says it stopped for tools but carries none would read as
    // "no tools, no text" and ship an empty answer. Fail loudly instead.
    if (choice?.finish_reason === "tool_calls" && toolCalls.length === 0) {
      throw new Error("The model reported finish_reason=tool_calls but returned no tool calls.");
    }

    const refused = typeof message.refusal === "string" && message.refusal.length > 0;
    const content: LlmContentBlock[] = [];
    if (refused) {
      // The refusal text is the model's own explanation; keep it rather than
      // returning empty content and making the caller guess.
      content.push({ type: "text", text: message.refusal as string });
    } else {
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of toolCalls) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: parseArguments(call.function.arguments),
        });
      }
    }

    return {
      message: { role: "assistant", content },
      text: textOf(content),
      toolUses: toolUsesOf(content),
      stopReason: refused ? "refusal" : mapFinishReason(choice?.finish_reason, toolCalls.length > 0),
      usage: mapUsage(response.usage),
    };
  }
}

interface ChatResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: ChatToolCall[]; refusal?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/** Chat Completions has no cacheable/volatile distinction: segments are joined in order. */
function joinSystem(segments: LlmSystemSegment[]): string | undefined {
  const stable = segments.filter((s) => s.cacheable && s.text.trim().length > 0);
  const volatile = segments.filter((s) => !s.cacheable && s.text.trim().length > 0);
  const joined = [...stable, ...volatile].map((s) => s.text).join("\n\n");
  return joined.length > 0 ? joined : undefined;
}

/** Translates the Anthropic-shaped transcript to Chat Completions messages. */
export function toChatMessages(messages: LlmMessage[], system?: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push(message.role === "user" ? { role: "user", content: message.content } : { role: "assistant", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const toolCalls = message.content
        .filter((block): block is LlmToolUseBlock => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          type: "function" as const,
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        }));
      const text = textOf(message.content);
      out.push({
        role: "assistant",
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // A user turn may carry tool results and ordinary content side by side.
    // Tool results become `role: "tool"` messages and must directly follow the
    // assistant turn that called them, so they go first.
    const parts: ChatContentPart[] = [];
    for (const block of message.content) {
      if (block.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: block.tool_use_id, content: toolResultText(block.content, block.is_error) });
      } else if (block.type === "text") {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        parts.push({ type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } });
      }
    }
    if (parts.length > 0) out.push({ role: "user", content: parts });
  }
  return out;
}

/** Tool messages are text-only on this wire format, so images are noted, not silently dropped. */
function toolResultText(content: string | Array<{ type: string; text?: string }>, isError?: boolean): string {
  const prefix = isError ? "[tool error] " : "";
  if (typeof content === "string") return `${prefix}${content}`;
  const text = content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  const images = content.filter((part) => part.type === "image").length;
  const note = images > 0 ? `\n[${images} image(s) returned by the tool cannot be shown on this model's tool channel]` : "";
  return `${prefix}${text}${note}`;
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapFinishReason(finish: string | null | undefined, hadTools: boolean): string {
  if (finish === "tool_calls" || finish === "function_call" || (hadTools && !finish)) return "tool_use";
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  if (finish === "stop" || !finish) return "end_turn";
  return finish;
}

function mapUsage(usage: ChatResponse["usage"]): LlmUsage | null {
  if (!usage) return null;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    // Reported as the uncached remainder, matching the Anthropic client, so
    // the three input figures sum to the whole prompt on either transport.
    promptTokens: Math.max(0, prompt - cached),
    completionTokens: completion,
    totalTokens: usage.total_tokens ?? prompt + completion,
    cachedInputTokens: cached,
    cacheCreationInputTokens: 0,
  };
}
