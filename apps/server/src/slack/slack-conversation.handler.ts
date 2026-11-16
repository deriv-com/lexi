import type { AgentTurnRunner, TurnHistoryMessage, TurnInput, TurnResult } from "@lexi/agent";
import { toSlackMrkdwn } from "./slack-mrkdwn";
import { chunkMessage } from "./slack-message-chunks";
import { fetchThreadHistory, stripMention, type SlackHistoryClient } from "./slack-thread-history";
import { runTurnWithTimeout } from "./run-turn-with-timeout";
import { DEFAULT_QUEUED_TTL_MS, ThreadTurnQueue, type SubmitResult } from "./thread-turn-queue";

/**
 * The Slack conversation surface: turns an `app_mention` (or a direct message)
 * into one agent turn and posts the answer in the thread.
 *
 * Responsibilities, and nothing more:
 * - decide whether an event is a message to answer at all (people only — never
 *   bots, never the agent itself, never edits or joins);
 * - refuse, before any model call, a person the access policy refuses
 *   everything, and a person over their turn rate limit;
 * - serialise turns per thread through {@link ThreadTurnQueue};
 * - build the {@link TurnInput}, taking the actor from the Slack event's
 *   `user` field and never from anything in the message text;
 * - run the turn under a timeout that aborts rather than abandons it;
 * - post the reply as Slack mrkdwn with broadcast mentions and disguised
 *   links neutralised and unfurls off, and acknowledge with reactions.
 */

/** Acknowledgement while the turn runs, and its terminal replacements. */
export const REACTION_PENDING = "eyes";
export const REACTION_SUCCESS = "white_check_mark";
export const REACTION_FAILURE = "x";

/** Posted only when a thread's queue is genuinely full, so it is never a false promise. */
export const THREAD_QUEUE_FULL_REPLY =
  "I've got too many messages stacked up in this thread to take another. Give me a moment to catch up, then send this one again.";

/** Posted for a queued message that waited so long that answering it would be worse than saying so. */
export const THREAD_QUEUE_STALE_REPLY =
  "This sat in my queue too long while I was working, so I'm not going to answer it late and out of context. Send it again if you still need it.";

export const EMPTY_MENTION_REPLY = "Hi! Ask me something here and I'll answer in this thread.";

/** Posted once per window to someone over their turn rate limit; later messages in the window are dropped silently. */
export function rateLimitedReply(maxTurns: number, windowMs: number): string {
  const minutes = Math.max(1, Math.round(windowMs / 60_000));
  return (
    `You've asked me ${maxTurns} things in the last ${minutes} minute${minutes === 1 ? "" : "s"}, which is my limit ` +
    "per person. I'll ignore new messages from you for a little while; send it again in a few minutes."
  );
}

/** Per-person turn rate limit. `maxTurns` 0 turns it off. */
export interface UserTurnRateLimit {
  maxTurns: number;
  windowMs: number;
}

/** The Slack event fields this handler reads (`app_mention` and `message`). */
export interface SlackMessageEvent {
  type: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  channel_type?: string;
}

/** The Slack Web API calls this handler makes. Bolt's `client` satisfies it. */
export interface SlackConversationClient extends SlackHistoryClient {
  chat: {
    postMessage(args: {
      channel: string;
      thread_ts?: string;
      text: string;
      unfurl_links?: boolean;
      unfurl_media?: boolean;
    }): Promise<{
      ok?: boolean;
      ts?: string;
      error?: string;
    }>;
  };
  reactions: {
    add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
    remove(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  };
}

export interface ConversationLogger {
  log(message: string, context?: string): void;
  warn(message: string, context?: string): void;
  error(message: string, context?: string): void;
}

export interface SlackConversationHandlerOptions {
  runner: AgentTurnRunner;
  logger: ConversationLogger;
  /** The agent's own Slack user id, from `auth.test`. */
  botUserId: string;
  /** The agent's bot id, from `auth.test`. Recognises its own posts in history. */
  botId?: string;
  turnTimeoutMs: number;
  abortGraceMs: number;
  maxQueuedPerThread: number;
  queuedTtlMs?: number;
  historyLimit: number;
  /** Acknowledge with reactions. Defaults to true; failures are always ignored. */
  reactions?: boolean;
  /**
   * Decides, before any model call, whether this person may start a turn at
   * all. Returns the refusal to post, or undefined to let them through.
   * Absent, everyone is let through (tools still refuse per call).
   */
  admit?: (actorId: string) => string | undefined;
  /** Turns one person may start per window. Absent or `maxTurns` 0: no limit. */
  userRateLimit?: UserTurnRateLimit;
  /** Hosts whose masked links keep their label in replies, besides github.com. */
  linkHosts?: readonly string[];
}

export type HandleEventResult = "ignored" | "duplicate" | "empty" | "refused" | "rate_limited" | SubmitResult;

interface PendingTurn {
  channel: string;
  threadTs: string;
  messageTs: string;
  actorId: string;
  text: string;
  client: SlackConversationClient;
}

const LOG_CONTEXT = "SlackConversation";
const DEDUPE_WINDOW_MS = 30_000;
const DEDUPE_MAX_ENTRIES = 500;
/** Past this many tracked people, the rate limiter drops those idle for a whole window. */
const RATE_LIMIT_MAX_TRACKED = 1_000;
/** Subtypes that are a person posting, not an edit, join, deletion or bot post. */
const PERSON_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

export class SlackConversationHandler {
  private readonly queue: ThreadTurnQueue<PendingTurn>;
  private readonly seen = new Map<string, number>();
  /** Per person: when their recent turns started, and when they were last told they are limited. */
  private readonly turnLog = new Map<string, { starts: number[]; notifiedAt?: number }>();

  constructor(private readonly options: SlackConversationHandlerOptions) {
    this.queue = new ThreadTurnQueue<PendingTurn>({
      run: (turn) => this.runTurn(turn),
      maxQueuedPerThread: options.maxQueuedPerThread,
      queuedTtlMs: options.queuedTtlMs ?? DEFAULT_QUEUED_TTL_MS,
      onStale: (turn, waitedMs) => this.refuseStale(turn, waitedMs),
      onError: (turn, error) =>
        options.logger.error(
          `Turn for ${turn.channel} thread=${turn.threadTs} failed outside the runner: ${describe(error)}`,
          LOG_CONTEXT,
        ),
    });
  }

  /** Wires the handler to a Bolt app. Each listener returns once the turn is queued. */
  register(app: {
    event(name: string, listener: (args: { event: unknown; client: unknown }) => Promise<void>): unknown;
  }): void {
    const listener = async ({ event, client }: { event: unknown; client: unknown }): Promise<void> => {
      await this.handleEvent(event as SlackMessageEvent, client as SlackConversationClient);
    };
    app.event("app_mention", listener);
    app.event("message", listener);
  }

  /**
   * Accepts one Slack event. Returns as soon as the turn is started, queued or
   * refused; the turn itself runs in the background.
   */
  async handleEvent(event: SlackMessageEvent, client: SlackConversationClient): Promise<HandleEventResult> {
    if (!this.isAddressedByPerson(event)) return "ignored";
    // One message can arrive as both `app_mention` and `message`, and Slack
    // redelivers events it thinks were not acknowledged.
    if (!this.claim(event.channel, event.ts)) return "duplicate";

    const actorId = event.user as string;
    const threadTs = event.thread_ts ?? event.ts;

    // Both checks come before the model, so neither a flood of messages nor a
    // person the policy refuses everything costs a model turn.
    const limited = this.checkRateLimit(actorId);
    if (limited !== "ok") {
      this.options.logger.warn(`Rate-limited ${actorId} in ${event.channel} (thread=${threadTs})`, LOG_CONTEXT);
      if (limited === "notify") {
        const { maxTurns, windowMs } = this.options.userRateLimit as UserTurnRateLimit;
        await this.post(client, event.channel, threadTs, rateLimitedReply(maxTurns, windowMs), "rate_limited");
      }
      return "rate_limited";
    }

    const refusal = this.options.admit?.(actorId);
    if (refusal !== undefined) {
      this.options.logger.log(`Refused ${actorId} in ${event.channel} before the model: not admitted`, LOG_CONTEXT);
      await this.post(client, event.channel, threadTs, refusal, "not_admitted");
      return "refused";
    }

    const text = stripMention(event.text ?? "", this.options.botUserId);
    if (!text) {
      await this.post(client, event.channel, threadTs, EMPTY_MENTION_REPLY, "empty_mention");
      return "empty";
    }

    this.options.logger.log(
      `Inbound ${event.type} from ${actorId} in ${event.channel} (chars=${text.length}, thread=${threadTs})`,
      LOG_CONTEXT,
    );
    await this.react(client, event.channel, event.ts, REACTION_PENDING);

    const result = this.queue.submit(threadKey(event.channel, threadTs), {
      channel: event.channel,
      threadTs,
      messageTs: event.ts,
      actorId,
      text,
      client,
    });

    if (result === "queued") {
      this.options.logger.log(
        `Queued behind the turn in flight on ${event.channel} thread=${threadTs} ` +
          `(depth=${this.queue.queuedCount(threadKey(event.channel, threadTs))})`,
        LOG_CONTEXT,
      );
    } else if (result === "rejected") {
      this.options.logger.warn(
        `Refused on ${event.channel} thread=${threadTs}: queue full (${this.options.maxQueuedPerThread})`,
        LOG_CONTEXT,
      );
      await this.post(client, event.channel, threadTs, THREAD_QUEUE_FULL_REPLY, "queue_full");
      await this.swapReaction(client, event.channel, event.ts, REACTION_FAILURE);
    }
    return result;
  }

  /** Resolves when no turn is running or queued. Used at shutdown and in tests. */
  idle(): Promise<void> {
    return this.queue.idle();
  }

  private isAddressedByPerson(event: SlackMessageEvent): boolean {
    if (!event || !event.channel || !event.ts) return false;
    if (!event.user || event.bot_id) return false;
    if (event.user === this.options.botUserId) return false;
    if (event.subtype && !PERSON_SUBTYPES.has(event.subtype)) return false;
    if (event.type === "app_mention") return true;
    // Plain messages are answered only in direct messages; in channels the
    // same message also arrives as `app_mention` when the agent is tagged.
    return event.type === "message" && event.channel_type === "im";
  }

  private async runTurn(turn: PendingTurn): Promise<void> {
    const { options } = this;
    let history: TurnHistoryMessage[] = [];
    try {
      history = await fetchThreadHistory(turn.client, {
        channel: turn.channel,
        threadTs: turn.threadTs,
        currentTs: turn.messageTs,
        botUserId: options.botUserId,
        botId: options.botId,
        limit: options.historyLimit,
      });
    } catch (error) {
      options.logger.warn(
        `Could not read thread history for ${turn.channel} thread=${turn.threadTs}: ${describe(error)}`,
        LOG_CONTEXT,
      );
    }

    const input: TurnInput = {
      actorId: turn.actorId,
      conversation: { channel: turn.channel, threadTs: turn.threadTs },
      text: turn.text,
      ...(history.length > 0 ? { history } : {}),
    };

    const outcome = await runTurnWithTimeout(options.runner, input, {
      timeoutMs: options.turnTimeoutMs,
      abortGraceMs: options.abortGraceMs,
      onLateResult: (late) => {
        options.logger.warn(
          `Late answer on ${turn.channel} thread=${turn.threadTs} after the timeout notice — posting it`,
          LOG_CONTEXT,
        );
        void this.deliver(turn, late, "agent_late_reply");
      },
    });

    if (outcome.error !== undefined) {
      options.logger.error(
        `Agent turn failed on ${turn.channel} thread=${turn.threadTs}: ${describe(outcome.error)}`,
        LOG_CONTEXT,
      );
    } else if (outcome.timedOut) {
      options.logger.warn(
        `Agent turn on ${turn.channel} thread=${turn.threadTs} timed out after ${options.turnTimeoutMs}ms ` +
          `(${outcome.detached ? "runner did not return after abort" : `runner returned ${outcome.result.outcome}`})`,
        LOG_CONTEXT,
      );
    }

    await this.deliver(turn, outcome.result, outcome.timedOut ? "agent_timeout" : "agent_reply");
  }

  private async deliver(turn: PendingTurn, result: TurnResult, origin: string): Promise<void> {
    const posted = await this.post(turn.client, turn.channel, turn.threadTs, result.text, origin);
    const ok = posted && result.outcome === "answered";
    await this.swapReaction(turn.client, turn.channel, turn.messageTs, ok ? REACTION_SUCCESS : REACTION_FAILURE);
  }

  private async refuseStale(turn: PendingTurn, waitedMs: number): Promise<void> {
    this.options.logger.log(
      `Queued message on ${turn.channel} thread=${turn.threadTs} expired after ${waitedMs}ms — not answering late`,
      LOG_CONTEXT,
    );
    await this.post(turn.client, turn.channel, turn.threadTs, THREAD_QUEUE_STALE_REPLY, "queue_stale");
    await this.swapReaction(turn.client, turn.channel, turn.messageTs, REACTION_FAILURE);
  }

  /** Posts in-thread as mrkdwn, split across messages when long. True when every piece landed. */
  private async post(
    client: SlackConversationClient,
    channel: string,
    threadTs: string,
    text: string,
    origin: string,
  ): Promise<boolean> {
    const pieces = chunkMessage(toSlackMrkdwn(text, { linkHosts: this.options.linkHosts }));
    let allOk = pieces.length > 0;
    for (const piece of pieces) {
      try {
        // No unfurls: a reply can carry a URL the model was led to include,
        // and an unfurl would fetch it and render the attacker's preview.
        const response = await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: piece,
          unfurl_links: false,
          unfurl_media: false,
        });
        if (!response.ok) {
          allOk = false;
          this.options.logger.error(
            `Slack post (${origin}) to ${channel} failed: ${response.error ?? "unknown"}`,
            LOG_CONTEXT,
          );
        }
      } catch (error) {
        allOk = false;
        this.options.logger.error(`Slack post (${origin}) to ${channel} threw: ${describe(error)}`, LOG_CONTEXT);
      }
    }
    return allOk;
  }

  private async react(client: SlackConversationClient, channel: string, timestamp: string, name: string): Promise<void> {
    if (this.options.reactions === false) return;
    try {
      await client.reactions.add({ channel, timestamp, name });
    } catch {
      // Cosmetic. A missing scope or an already-present reaction must not
      // affect the turn.
    }
  }

  private async swapReaction(
    client: SlackConversationClient,
    channel: string,
    timestamp: string,
    name: string,
  ): Promise<void> {
    if (this.options.reactions === false) return;
    try {
      await client.reactions.remove({ channel, timestamp, name: REACTION_PENDING });
    } catch {
      // Cosmetic, as above.
    }
    await this.react(client, channel, timestamp, name);
  }

  /**
   * Records a turn for this person and says whether it may start: "ok", or
   * "notify" the first time they exceed the limit in a window, "silent" after.
   */
  private checkRateLimit(actorId: string): "ok" | "notify" | "silent" {
    const limit = this.options.userRateLimit;
    if (!limit || limit.maxTurns <= 0 || limit.windowMs <= 0) return "ok";
    const now = Date.now();
    const entry = this.turnLog.get(actorId) ?? { starts: [] };
    entry.starts = entry.starts.filter((at) => now - at < limit.windowMs);
    this.turnLog.set(actorId, entry);
    if (this.turnLog.size > RATE_LIMIT_MAX_TRACKED) {
      for (const [id, e] of this.turnLog) {
        if (id !== actorId && e.starts.every((at) => now - at >= limit.windowMs)) this.turnLog.delete(id);
      }
    }
    if (entry.starts.length >= limit.maxTurns) {
      if (entry.notifiedAt !== undefined && now - entry.notifiedAt < limit.windowMs) return "silent";
      entry.notifiedAt = now;
      return "notify";
    }
    entry.starts.push(now);
    return "ok";
  }

  private claim(channel: string, ts: string): boolean {
    const key = `${channel}:${ts}`;
    const now = Date.now();
    const seenAt = this.seen.get(key);
    if (seenAt !== undefined && now - seenAt < DEDUPE_WINDOW_MS) return false;
    this.seen.set(key, now);
    if (this.seen.size > DEDUPE_MAX_ENTRIES) {
      for (const [k, at] of this.seen) {
        if (now - at >= DEDUPE_WINDOW_MS) this.seen.delete(k);
      }
    }
    return true;
  }
}

function threadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
