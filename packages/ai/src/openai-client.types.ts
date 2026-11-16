export interface OpenAiChatCompletionCreateParams {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  temperature?: number;
  response_format?: {
    type: "json_schema";
    json_schema: {
      name: string;
      schema: Record<string, unknown>;
      strict?: boolean;
    };
  };
}

export interface OpenAiChatCompletionResult {
  choices?: Array<{ message?: { content?: string | null } }>;
}

/**
 * Minimal surface of the OpenAI-compatible Chat Completions API that the
 * Decision Engine depends on. Keeping this narrow (rather than depending on
 * the full `openai` SDK type surface everywhere) makes the AI provider
 * trivially mockable in tests and insulates the rest of the codebase from SDK
 * version churn.
 *
 * Chat Completions (`/v1/chat/completions`), not the Responses API
 * (`/v1/responses`), is used deliberately. The decision engine's model may be
 * reached through an OpenAI-compatible gateway such as LiteLLM, and a
 * gateway's Responses-API passthrough for non-OpenAI backends can reject every
 * request with a bare `400 The request was invalid`. Chat Completions is the
 * endpoint such gateways support across everything they proxy, so it is the
 * one this client uses. Do not switch to `responses.create`: removing other
 * triggers (an unconditional `temperature`, `strict: true`) does not fix that
 * 400, and it then reads as "already fixed".
 */
export interface OpenAiChatClient {
  chat: {
    completions: {
      create(params: OpenAiChatCompletionCreateParams): Promise<OpenAiChatCompletionResult>;
    };
  };
}
