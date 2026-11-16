import { PinoLoggerService } from "@lexi/logger";
import { AiProvider } from "./ai-provider.interface";
import { decisionJsonSchema, decisionSchema } from "./decision.schema";
import { buildSystemPrompt, buildUserPrompt, DecisionTaxonomy } from "./prompt-builder";
import { OpenAiChatClient } from "./openai-client.types";
import { AiDecisionInput, Decision } from "./types";

export interface OpenAiProviderOptions {
  model: string;
  temperature?: number;
  /** Labels and owning areas the model may name. Defaults to `DEFAULT_DECISION_TAXONOMY`. */
  taxonomy?: DecisionTaxonomy;
}

/**
 * Production AiProvider implementation. Calls the OpenAI-compatible Chat
 * Completions API with a JSON schema, validates the result with Zod, and
 * returns a fully typed Decision. This class performs reasoning only: it never
 * touches GitHub, Slack, or the database.
 */
export class OpenAiProvider implements AiProvider {
  constructor(
    private readonly client: OpenAiChatClient,
    private readonly options: OpenAiProviderOptions,
    private readonly logger: PinoLoggerService,
  ) {}

  async generateDecision(input: AiDecisionInput): Promise<Decision> {
    // Only include `temperature` when the caller explicitly configured one.
    // Some models reject a non-default temperature with an opaque 400, and
    // a hard-coded default would make every decision call fail and fall back
    // to a 0%-confidence NEEDS_MANUAL_INVESTIGATION comment. Omitting the
    // field lets the model or gateway use its own default temperature
    // instead of guessing which models tolerate a custom one.
    const temperature = this.options.temperature;
    const response = await this.client.chat.completions.create({
      model: this.options.model,
      ...(temperature !== undefined ? { temperature } : {}),
      messages: [
        { role: "system", content: buildSystemPrompt(this.options.taxonomy) },
        { role: "user", content: buildUserPrompt(input) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: decisionJsonSchema.name,
          schema: decisionJsonSchema.schema as unknown as Record<string, unknown>,
          // `strict: true` is an OpenAI-specific structured-output guarantee. Some
          // OpenAI-compatible gateways in front of other model providers reject it
          // with a bare "400 The request was invalid", so it is left off and the
          // response is validated against the schema here instead.
        },
      },
    });

    const rawText = this.extractText(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      this.logger.error(`AI Decision Engine returned invalid JSON: ${rawText}`, "OpenAiProvider");
      throw new Error("AI Decision Engine returned a response that could not be parsed as JSON");
    }

    const result = decisionSchema.safeParse(this.unwrapParametersEnvelope(parsed));
    if (!result.success) {
      this.logger.error(
        `AI Decision Engine output failed schema validation: ${result.error.message}`,
        "OpenAiProvider",
      );
      throw new Error(`AI Decision Engine output failed validation: ${result.error.message}`);
    }

    return {
      ...result.data,
      confidence: Math.min(1, Math.max(0, result.data.confidence)),
    };
  }

  /**
   * An OpenAI-compatible gateway that implements `json_schema` structured
   * output as a forced tool call may wrap the payload in a
   * `{"parameters": {...}}` envelope (where a tool's arguments conventionally
   * live) or return it flat, and not always the same way. Accept both shapes
   * rather than failing schema validation whenever the wrapped one appears.
   */
  private unwrapParametersEnvelope(value: unknown): unknown {
    if (
      typeof value === "object" &&
      value !== null &&
      "parameters" in value &&
      typeof (value as { parameters: unknown }).parameters === "object" &&
      (value as { parameters: unknown }).parameters !== null
    ) {
      return (value as { parameters: unknown }).parameters;
    }
    return value;
  }

  private extractText(response: { choices?: Array<{ message?: { content?: string | null } }> }): string {
    const content = response.choices?.[0]?.message?.content;
    if (content && content.length > 0) {
      return content;
    }
    throw new Error("AI Decision Engine response did not contain any message content");
  }
}
