import type { TurnHistoryMessage } from "@lexi/agent";

/** The subset of a Slack message this module reads. */
export interface SlackHistoryMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
}

export interface SlackHistoryClient {
  conversations: {
    replies(args: {
      channel: string;
      ts: string;
      limit?: number;
      cursor?: string;
    }): Promise<{
      ok?: boolean;
      messages?: SlackHistoryMessage[];
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    }>;
  };
}

export interface FetchThreadHistoryArgs {
  channel: string;
  threadTs: string;
  /** The message the turn is about. It is the turn's text, not its history. */
  currentTs: string;
  botUserId: string;
  botId?: string;
  /** Keep at most this many messages, newest last. */
  limit: number;
  /** Per-message character cap. */
  maxChars?: number;
}

const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const DEFAULT_MAX_CHARS = 4000;
/** Subtypes that still carry something a person or bot said. */
const CONVERSATIONAL_SUBTYPES = new Set(["bot_message", "thread_broadcast", "file_share", "me_message"]);

/**
 * The thread so far, oldest first, as turn history.
 *
 * The agent's own messages become `assistant`; everything else is `user` with
 * its author attached. Authors are shown to the model for context only and are
 * never used for authorization — the turn's actor comes from the event.
 *
 * Messages from people that arrived after the current one are left out: they
 * are still queued and will get their own turn. The agent's replies that came
 * after it are kept, because they answer earlier queued messages the person
 * may be following up on.
 */
export async function fetchThreadHistory(
  client: SlackHistoryClient,
  args: FetchThreadHistoryArgs,
): Promise<TurnHistoryMessage[]> {
  if (args.limit <= 0) return [];

  const collected: SlackHistoryMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await client.conversations.replies({
      channel: args.channel,
      ts: args.threadTs,
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    collected.push(...(response.messages ?? []));
    cursor = response.response_metadata?.next_cursor || undefined;
    if (!response.has_more || !cursor) break;
  }

  const current = Number(args.currentTs);
  const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS;
  const history: TurnHistoryMessage[] = [];

  for (const message of collected) {
    if (!message.ts || message.ts === args.currentTs) continue;
    if (message.subtype && !CONVERSATIONAL_SUBTYPES.has(message.subtype)) continue;

    const fromAgent =
      (message.user !== undefined && message.user === args.botUserId) ||
      (args.botId !== undefined && message.bot_id === args.botId);
    if (!fromAgent && Number(message.ts) > current) continue;

    const text = stripMention(message.text ?? "", args.botUserId);
    if (!text) continue;

    history.push(
      fromAgent
        ? { role: "assistant", text: truncate(text, maxChars) }
        : { role: "user", text: truncate(text, maxChars), authorId: message.user ?? message.bot_id },
    );
  }

  return history.slice(-args.limit);
}

/**
 * Removes mentions of the agent. Slack delivers a mention as `<@U123>` or
 * `<@U123|Display Name>`; both forms are handled.
 */
export function stripMention(text: string, botUserId: string): string {
  if (!botUserId) return text.trim();
  return text.replace(new RegExp(`<@${escapeRegExp(botUserId)}(\\|[^>]*)?>`, "gi"), "").trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
