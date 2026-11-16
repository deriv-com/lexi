import type { ToolCallContext, ToolResult } from "./tools/agent-tool";

/**
 * Optional hooks for tracing, audit and metrics. Every method is optional and
 * every call is best-effort: an observer that throws never affects a turn.
 */
export interface AgentObserver {
  onToolCall?(event: {
    name: string;
    args: Record<string, unknown>;
    ctx: ToolCallContext;
    result: ToolResult;
    durationMs: number;
    /** Set when the registry refused the call before `invoke`. */
    refused?: "unknown_tool" | "unauthorized" | "invalid_tool";
  }): void;
  onLlmCall?(event: {
    model: string;
    durationMs: number;
    stopReason: string | null;
    usage: {
      promptTokens: number;
      completionTokens: number;
      cachedInputTokens: number;
      cacheCreationInputTokens: number;
    } | null;
  }): void;
  onTurnEnd?(event: {
    conversation: ToolCallContext["conversation"];
    outcome: string;
    iterations: number;
    durationMs: number;
  }): void;
}

/** Calls an observer hook, swallowing anything it throws. */
export function notify<K extends keyof AgentObserver>(
  observer: AgentObserver | undefined,
  hook: K,
  event: Parameters<NonNullable<AgentObserver[K]>>[0],
): void {
  const fn = observer?.[hook] as ((e: typeof event) => void) | undefined;
  if (!fn) return;
  try {
    fn.call(observer, event);
  } catch {
    // Observers are best-effort by contract.
  }
}
