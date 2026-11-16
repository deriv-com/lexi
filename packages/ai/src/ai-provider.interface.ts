import { AiDecisionInput, Decision } from "./types";

/**
 * Adapter interface for the AI reasoning backend. Implementations must
 * return a fully-formed Decision object -- they must never perform GitHub,
 * Slack, or database mutations themselves.
 */
export interface AiProvider {
  generateDecision(input: AiDecisionInput): Promise<Decision>;
}

export const AI_PROVIDER_TOKEN = Symbol("AI_PROVIDER_TOKEN");
