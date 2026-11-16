import { resolvePiiMasking, type PiiMaskingOption } from "@lexi/privacy";
import { AnthropicLlmClient, type LlmClientOptions } from "./anthropic-client";
import { normalizeAnthropicBaseUrl, normalizeOpenAiCompatBaseUrl } from "./base-url";
import { OpenAiCompatLlmClient } from "./openai-compat-client";
import { PiiMaskingLlmClient } from "./pii-masking-client";
import type { LlmPort } from "./types";

/** Claude models are spoken to over the Anthropic Messages API, never a compatibility shim. */
export function isClaudeModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("claude-");
}

export interface LlmFactoryOptions extends LlmClientOptions {
  /**
   * Personal-data masking for everything sent to the model. On when omitted;
   * `false` turns it off (MODEL_PII_MASKING=false).
   */
  piiMasking?: PiiMaskingOption;
}

/**
 * Picks the client for a model and normalises the base URL for that client's
 * transport, so one configured gateway URL works for both. The client is
 * wrapped in {@link PiiMaskingLlmClient} unless masking is turned off.
 */
export function createLlmClient(options: LlmFactoryOptions): LlmPort {
  const { piiMasking, ...clientOptions } = options;
  const client = isClaudeModel(clientOptions.model)
    ? new AnthropicLlmClient({ ...clientOptions, baseURL: normalizeAnthropicBaseUrl(clientOptions.baseURL) })
    : new OpenAiCompatLlmClient({ ...clientOptions, baseURL: normalizeOpenAiCompatBaseUrl(clientOptions.baseURL) });
  const masking = resolvePiiMasking(piiMasking);
  return masking ? new PiiMaskingLlmClient(client, masking.masker, masking.onMasked) : client;
}
