import { createHash } from "node:crypto";
import type { PinoLoggerService } from "@lexi/logger";

/**
 * One structured record per outbound Slack post.
 *
 * When a thread shows a burst of messages inside a minute, the first question
 * is whether Lexi posted them or humans did. Without a record of every
 * outbound post, a burst is indistinguishable from ordinary channel traffic
 * and that question cannot be answered.
 *
 * Presence is the answer this gives. Every path that posts emits one of these,
 * so a Slack message with no matching line was not sent by us — and `ts` is the
 * exact join key from the log back to the message in the channel.
 *
 * What it must never do is carry the message. Slack text is the richest
 * concentration of user content in the service: it is the answer we composed
 * about the user's issue, usually quoting the user's own words. Destination,
 * size and a one-way fingerprint are enough to reconstruct the *event*, and a
 * burst of identical posts is still recognisable as identical because the
 * fingerprints match.
 */
export interface OutboundSlackPost {
  channel: string;
  threadTs?: string;
  /** Used for size and fingerprint only — never emitted. */
  text: string;
  blocks?: Array<Record<string, unknown>>;
  ok: boolean;
  /** The ts Slack assigned, when the post succeeded. The join key. */
  ts?: string;
  error?: string;
  /** Which code path posted, so a burst can be attributed to a cause. */
  origin: string;
}

export function formatOutboundSlackPost(post: OutboundSlackPost): string {
  const text = post.text ?? "";
  return JSON.stringify({
    channel: post.channel,
    ...(post.threadTs ? { threadTs: post.threadTs } : {}),
    origin: post.origin,
    ok: post.ok,
    ...(post.ts ? { ts: post.ts } : {}),
    chars: text.length,
    textHash: createHash("sha256").update(text).digest("hex").slice(0, 8),
    ...(post.blocks ? { blocks: post.blocks.length } : {}),
    ...(post.error ? { error: post.error } : {}),
  });
}

/**
 * Info for a delivered post, error for a failed one — the outcome, not the
 * event, decides the level. A post that failed is both rarer and more urgent,
 * and `LOG_LEVEL` is "info" in production so both actually leave the pod.
 */
export function logOutboundSlackPost(logger: PinoLoggerService, post: OutboundSlackPost): void {
  const line = `Slack post: ${formatOutboundSlackPost(post)}`;
  if (post.ok) {
    logger.log(line, "SlackOutbound");
    return;
  }
  logger.error(line, "SlackOutbound");
}
