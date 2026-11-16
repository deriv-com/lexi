import { addPiiCounts, emptyPiiCounts, maskStringLeaves, totalPiiCount, type PiiCounts, type PiiMasker } from "@lexi/privacy";
import type {
  LlmCompleteOptions,
  LlmCompletion,
  LlmContentBlock,
  LlmImageBlock,
  LlmMessage,
  LlmPort,
  LlmTextBlock,
  LlmToolDefinition,
} from "./types";

/**
 * Masks personal data out of every request before it reaches the model.
 *
 * Wraps any {@link LlmPort}, so it covers both transports and everything the
 * agent loop sends: the system prompt, the user's message, the thread history,
 * the model's own earlier turns and every tool result. What is masked is text:
 * text blocks, string content, tool-result content and the string values of
 * tool-call arguments. What is not touched is structure the provider needs to
 * pair calls with results and to validate them: tool names, tool-use ids and
 * tool schemas. Images pass through unchanged; a pattern masker cannot read
 * pixels.
 *
 * The caller's transcript is never mutated; only the copy that leaves the
 * process is masked. Masking is deterministic, so the masked prefix is
 * byte-identical from one request to the next and prompt caching still hits.
 *
 * A consequence worth knowing: the model never sees a masked value, so it
 * cannot pass one to a tool either. Asked to look something up by an email
 * address, it sees `[email]`.
 */
export class PiiMaskingLlmClient implements LlmPort {
  constructor(
    readonly inner: LlmPort,
    private readonly masker: PiiMasker,
    private readonly onMasked?: (counts: PiiCounts) => void,
  ) {}

  get model(): string {
    return this.inner.model;
  }

  get baseURL(): string {
    return this.inner.baseURL;
  }

  async complete(messages: LlmMessage[], tools: LlmToolDefinition[], options: LlmCompleteOptions = {}): Promise<LlmCompletion> {
    const counts = emptyPiiCounts();
    const maskedMessages = messages.map((message) => this.maskMessage(message, counts));
    const maskedOptions: LlmCompleteOptions = options.system
      ? { ...options, system: options.system.map((segment) => ({ ...segment, text: this.text(segment.text, counts) })) }
      : options;
    if (this.onMasked && totalPiiCount(counts) > 0) this.onMasked(counts);
    return this.inner.complete(maskedMessages, tools, maskedOptions);
  }

  private maskMessage(message: LlmMessage, counts: PiiCounts): LlmMessage {
    if (typeof message.content === "string") return { ...message, content: this.text(message.content, counts) };
    return { ...message, content: message.content.map((block) => this.maskBlock(block, counts)) };
  }

  private maskBlock(block: LlmContentBlock, counts: PiiCounts): LlmContentBlock {
    switch (block.type) {
      case "text":
        return { ...block, text: this.text(block.text, counts) };
      case "tool_use":
        return { ...block, input: maskStringLeaves(block.input, this.masker, counts) };
      case "tool_result":
        return {
          ...block,
          content:
            typeof block.content === "string"
              ? this.text(block.content, counts)
              : block.content.map((part): LlmTextBlock | LlmImageBlock =>
                  part.type === "text" ? { ...part, text: this.text(part.text, counts) } : part,
                ),
        };
      default:
        return block;
    }
  }

  private text(value: string, counts: PiiCounts): string {
    const result = this.masker.mask(value);
    addPiiCounts(counts, result.counts);
    return result.text;
  }
}
