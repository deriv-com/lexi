import type { PiiMaskingOption } from "@lexi/privacy";
import OpenAI from "openai";
import { OpenAiChatClient, OpenAiChatCompletionCreateParams, OpenAiChatCompletionResult } from "./openai-client.types";
import { withPiiMasking } from "./pii-masking-chat-client";

export interface OpenAiClientFactoryOptions {
  apiKey: string;
  baseURL?: string;
  /**
   * Personal-data masking for every prompt sent. On when omitted; `false`
   * turns it off (MODEL_PII_MASKING=false).
   */
  piiMasking?: PiiMaskingOption;
}

/**
 * Builds an OpenAiChatClient backed by the real OpenAI SDK. The single type
 * assertion below is confined to this boundary: it adapts our narrow,
 * test-friendly `OpenAiChatCompletionCreateParams` contract onto the SDK's
 * actual (much larger) request type, and narrows the SDK's response object
 * down to the one field the Decision Engine actually reads.
 *
 * Targets `chat.completions`, not `responses` — see the endpoint note in
 * `openai-client.types.ts`.
 *
 * The client masks personal data out of every prompt unless
 * `piiMasking: false` is passed; see {@link withPiiMasking}.
 */
export function createOpenAiClient(options: OpenAiClientFactoryOptions): OpenAiChatClient {
  const sdkClient = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL && options.baseURL.length > 0 ? options.baseURL : undefined,
  });

  const client: OpenAiChatClient = {
    chat: {
      completions: {
        create: async (params: OpenAiChatCompletionCreateParams): Promise<OpenAiChatCompletionResult> => {
          const request = params as unknown as Parameters<typeof sdkClient.chat.completions.create>[0];
          const response = await sdkClient.chat.completions.create(request);
          const typed = response as unknown as OpenAiChatCompletionResult;
          return { choices: typed.choices };
        },
      },
    },
  };
  return withPiiMasking(client, options.piiMasking);
}
