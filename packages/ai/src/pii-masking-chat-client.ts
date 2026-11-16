import { addPiiCounts, emptyPiiCounts, resolvePiiMasking, totalPiiCount, type PiiMaskingOption } from "@lexi/privacy";
import type { OpenAiChatClient } from "./openai-client.types";

/**
 * Wraps a Chat Completions client so the content of every message — the system
 * prompt and the user prompt with the issue's title, body, comments and
 * evidence — is masked before it is sent. The model name and the
 * `response_format` schema are not touched. Returns the client unchanged when
 * masking is turned off.
 *
 * Structural, so any client of the same shape (the evidence pipeline's
 * `AnalysisLLMClient`, for one) can be wrapped too.
 */
export function withPiiMasking(client: OpenAiChatClient, option?: PiiMaskingOption): OpenAiChatClient {
  const masking = resolvePiiMasking(option);
  if (!masking) return client;
  const { masker, onMasked } = masking;
  return {
    chat: {
      completions: {
        create: (params) => {
          const counts = emptyPiiCounts();
          const messages = params.messages.map((message) => {
            const result = masker.mask(message.content);
            addPiiCounts(counts, result.counts);
            return { ...message, content: result.text };
          });
          if (onMasked && totalPiiCount(counts) > 0) onMasked(counts);
          return client.chat.completions.create({ ...params, messages });
        },
      },
    },
  };
}
