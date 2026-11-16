import { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/web-api";
import { PinoLoggerService } from "@lexi/logger";
import { SlackMessagePayload, SlackMessageResult, SlackProvider } from "./slack-provider.interface";
import { logOutboundSlackPost } from "./outbound-post-log";

/**
 * Our public SlackProvider interface deliberately keeps `blocks` as
 * `Record<string, unknown>[]` (rather than depending on Slack's Block Kit
 * types everywhere) so callers -- and tests -- don't need the full
 * `@slack/web-api` type surface. This single cast adapts that generic shape
 * onto the SDK's concrete `KnownBlock[]` at the API boundary.
 */
function toKnownBlocks(blocks?: Array<Record<string, unknown>>): KnownBlock[] | undefined {
  return blocks as unknown as KnownBlock[] | undefined;
}

/**
 * Production SlackProvider backed by @slack/bolt. We only use Bolt's
 * underlying WebClient (`app.client`) for outbound chat.postMessage /
 * chat.update calls; the orchestrator does not need to receive Slack events
 * today, but wiring a full Bolt App keeps the door open for slash commands
 * or interactivity later without swapping the adapter.
 */
export class BoltSlackProvider implements SlackProvider {
  constructor(private readonly app: App, private readonly logger: PinoLoggerService) {}

  async sendMessage(payload: SlackMessagePayload): Promise<SlackMessageResult> {
    try {
      const response = await this.app.client.chat.postMessage({
        channel: payload.channel,
        text: payload.text,
        blocks: toKnownBlocks(payload.blocks),
        thread_ts: payload.threadTs,
        // Every post is machine-written and may carry a URL from an issue,
        // a PR or an agent turn; never let Slack fetch and preview it.
        unfurl_links: false,
        unfurl_media: false,
      });
      // Replaces a bare "Sent Slack message to <channel>". That line is
      // useless when investigating a burst of posts: no thread, no ts, no
      // size, so it can be tied neither to a message in the channel nor to
      // the turn that produced it.
      logOutboundSlackPost(this.logger, {
        channel: payload.channel,
        threadTs: payload.threadTs,
        text: payload.text ?? "",
        blocks: payload.blocks,
        ok: Boolean(response.ok),
        ts: response.ts,
        origin: "slack_provider",
      });
      return { ok: Boolean(response.ok), channel: response.channel, ts: response.ts };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown Slack error";
      logOutboundSlackPost(this.logger, {
        channel: payload.channel,
        threadTs: payload.threadTs,
        text: payload.text ?? "",
        blocks: payload.blocks,
        ok: false,
        error: message,
        origin: "slack_provider",
      });
      return { ok: false, error: message };
    }
  }

  async updateMessage(
    channel: string,
    ts: string,
    text: string,
    blocks?: Array<Record<string, unknown>>,
  ): Promise<SlackMessageResult> {
    try {
      const response = await this.app.client.chat.update({ channel, ts, text, blocks: toKnownBlocks(blocks) });
      return { ok: Boolean(response.ok), channel: response.channel, ts: response.ts };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown Slack error";
      this.logger.error(`Failed to update Slack message ${ts} in ${channel}: ${message}`, "BoltSlackProvider");
      return { ok: false, error: message };
    }
  }
}
