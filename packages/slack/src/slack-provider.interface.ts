export interface SlackMessagePayload {
  channel: string;
  text: string;
  blocks?: Array<Record<string, unknown>>;
  threadTs?: string;
}

export interface SlackMessageResult {
  ok: boolean;
  channel?: string;
  ts?: string;
  error?: string;
}

/**
 * Adapter interface for all outbound Slack interactions. Kept intentionally
 * narrow (send + update) since the orchestrator only needs to push
 * notifications; the underlying implementation may be swapped (Bolt, raw
 * Web API, or a test double) without touching callers.
 */
export interface SlackProvider {
  sendMessage(payload: SlackMessagePayload): Promise<SlackMessageResult>;
  updateMessage(channel: string, ts: string, text: string, blocks?: Array<Record<string, unknown>>): Promise<SlackMessageResult>;
}

export const SLACK_PROVIDER_TOKEN = Symbol("SLACK_PROVIDER_TOKEN");
