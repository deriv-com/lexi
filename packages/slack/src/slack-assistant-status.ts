import type { PinoLoggerService } from "@lexi/logger";
import { extractSlackErrorCode, type SlackReactionPolicy } from "./slack-reaction.gateway";

/**
 * Slack's native "App is thinking…" footer plus rotating italic loader
 * (`Analyzing…`). Uses `assistant.threads.setStatus`.
 *
 * Slack auto-clears the status when the bot posts a reply, or after two
 * minutes if nothing is posted. Sending `status: ""` would also clear it;
 * we never need that on the happy path.
 *
 * Requires the Slack app's Agents feature (or the older Assistants toggle)
 * so the method is allowed. Without it Slack returns `feature_disabled` or
 * `missing_scope`. That is cosmetic — same contract as reactions: never throw,
 * never delay the reply.
 */
export interface SlackAssistantStatusClient {
  apiCall?(
    method: string,
    args: Record<string, unknown>,
  ): Promise<{ ok?: boolean; error?: string }>;
}

export type AssistantStatusKind = "diagnostics" | "lookup" | "action" | "help" | "general";

/** Slack prepends the app name: status `"is thinking..."` renders as `Lexi is thinking...`. */
export const ASSISTANT_THINKING_STATUS = "is thinking...";

export function loadingMessagesFor(kind: AssistantStatusKind): string[] {
  switch (kind) {
    case "diagnostics":
      return ["Checking the pod...", "Running diagnostics..."];
    case "lookup":
      return ["Looking this up...", "Analyzing..."];
    case "action":
      return ["Working on it...", "Running that..."];
    case "help":
      return ["Pulling this together..."];
    default:
      return ["Analyzing...", "Thinking it through..."];
  }
}

export interface SetAssistantThreadStatusArgs {
  channel: string;
  threadTs: string;
  kind: AssistantStatusKind;
}

/**
 * Pushes Slack's thread loading UX. Fail-soft and write-gated, matching
 * `SlackReactionGateway`: a missing Agents feature must not fail the turn.
 */
export async function setAssistantThreadStatus(
  client: SlackAssistantStatusClient,
  policy: SlackReactionPolicy,
  logger: PinoLoggerService,
  args: SetAssistantThreadStatusArgs,
): Promise<"applied" | "suppressed" | "failed"> {
  if (!policy.writesEnabled || policy.dryRun) {
    return "suppressed";
  }
  if (typeof client.apiCall !== "function") {
    return "failed";
  }

  try {
    const response = await client.apiCall("assistant.threads.setStatus", {
      channel_id: args.channel,
      thread_ts: args.threadTs,
      status: ASSISTANT_THINKING_STATUS,
      loading_messages: loadingMessagesFor(args.kind),
    });
    if (response?.ok === false || response?.error) {
      const code = response.error ?? "unknown";
      logger.warn(
        `assistant.threads.setStatus returned ${code} — thinking indicator skipped, reply unaffected${
          code === "missing_scope" || code === "feature_disabled"
            ? " (enable Agents on the Slack app, or grant chat:write / assistant:write)"
            : ""
        }`,
        "SlackAssistantStatus",
      );
      return "failed";
    }
    return "applied";
  } catch (error) {
    const code = extractSlackErrorCode(error);
    logger.warn(
      `assistant.threads.setStatus failed (${code}) — thinking indicator skipped, reply unaffected${
        code === "missing_scope" || code === "feature_disabled"
          ? " (enable Agents on the Slack app, or grant chat:write / assistant:write)"
          : ""
      }`,
      "SlackAssistantStatus",
    );
    return "failed";
  }
}
