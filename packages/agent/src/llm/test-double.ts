import type { LlmCompleteOptions, LlmCompletion, LlmContentBlock, LlmMessage, LlmPort, LlmToolDefinition, LlmUsage } from "./types";
import { textOf, toolUsesOf } from "./types";

/**
 * A scripted LLM for tests of anything that drives the agent loop.
 *
 * Each `complete()` call takes the next step from the script, repeating the
 * last one once the script runs out. A step may be a completion or a function
 * of the request, for tests that need to react to what the loop sent. Every
 * request is recorded (with a copy of the transcript at that moment) so tests
 * can assert on exactly what the model was shown.
 */
export type ScriptedStep =
  | LlmCompletion
  | Error
  | ((request: ScriptedRequest) => LlmCompletion | Promise<LlmCompletion>);

export interface ScriptedRequest {
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  options: LlmCompleteOptions;
}

export class ScriptedLlm implements LlmPort {
  readonly requests: ScriptedRequest[] = [];
  readonly baseURL = "https://llm.test";

  constructor(
    private readonly script: ScriptedStep[],
    readonly model = "claude-sonnet-5-5",
  ) {
    if (script.length === 0) throw new Error("ScriptedLlm needs at least one step");
  }

  get callCount(): number {
    return this.requests.length;
  }

  async complete(messages: LlmMessage[], tools: LlmToolDefinition[], options: LlmCompleteOptions = {}): Promise<LlmCompletion> {
    const request: ScriptedRequest = { messages: structuredClone(messages), tools: [...tools], options: { ...options } };
    const step = this.script[Math.min(this.requests.length, this.script.length - 1)];
    this.requests.push(request);
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(request) : step;
  }
}

const TEST_USAGE: LlmUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedInputTokens: 0, cacheCreationInputTokens: 0 };

/** Builds a completion from content blocks, filling in text and tool calls the way the real clients do. */
export function completionOf(content: LlmContentBlock[], stopReason: string | null = null): LlmCompletion {
  const toolUses = toolUsesOf(content);
  return {
    message: { role: "assistant", content },
    text: textOf(content),
    toolUses,
    stopReason: stopReason ?? (toolUses.length > 0 ? "tool_use" : "end_turn"),
    usage: { ...TEST_USAGE },
  };
}

/** A plain text answer. */
export function textCompletion(text: string, stopReason?: string): LlmCompletion {
  return completionOf(text.length > 0 ? [{ type: "text", text }] : [], stopReason ?? null);
}

let toolUseCounter = 0;

/** A turn that calls one or more tools, optionally with leading text. */
export function toolCallCompletion(
  calls: Array<{ name: string; input?: Record<string, unknown>; id?: string }>,
  text = "",
): LlmCompletion {
  const content: LlmContentBlock[] = text ? [{ type: "text", text }] : [];
  for (const call of calls) {
    toolUseCounter += 1;
    content.push({ type: "tool_use", id: call.id ?? `toolu_test_${toolUseCounter}`, name: call.name, input: call.input ?? {} });
  }
  return completionOf(content);
}
