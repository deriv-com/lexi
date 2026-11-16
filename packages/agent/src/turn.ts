import type { ConversationRef, ToolImageMediaType } from "./tools/agent-tool";

/** One earlier message in the conversation, oldest first. */
export interface TurnHistoryMessage {
  role: "user" | "assistant";
  text: string;
  /** Who wrote it, when the surface knows. Shown to the model, never trusted for authorization. */
  authorId?: string;
}

export interface TurnAttachment {
  mediaType: ToolImageMediaType;
  /** Base64 image data. */
  data: string;
  name?: string;
}

export interface TurnInput {
  /** The person asking. Every governed tool call is authorized against this. */
  actorId: string;
  conversation: ConversationRef;
  /** The new message. */
  text: string;
  history?: TurnHistoryMessage[];
  attachments?: TurnAttachment[];
  /** Narrows the tools offered. Omit to offer everything. */
  intentClass?: string;
}

/**
 * How a turn ended. `answered` is the only outcome whose `text` is the model's
 * own answer; every other outcome carries a message written by the runtime.
 */
export type TurnOutcome =
  | "answered"
  | "max_iterations"
  | "timeout"
  | "cancelled"
  | "refused"
  | "llm_error";

export interface TurnToolCall {
  name: string;
  isError: boolean;
  /** For mutating tools: whether the action actually happened. */
  executed?: boolean;
}

export interface TurnResult {
  outcome: TurnOutcome;
  /** What to post back. Never empty. */
  text: string;
  iterations: number;
  toolCalls: TurnToolCall[];
  durationMs: number;
}

/** The single entry point a surface (Slack, HTTP, CLI) calls. */
export interface AgentTurnRunner {
  runTurn(input: TurnInput, options?: { signal?: AbortSignal }): Promise<TurnResult>;
}
