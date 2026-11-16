import type { UserTurnRateLimit } from "./slack-conversation.handler";

/**
 * Settings for the Slack surface's pre-model limits, read from the validated
 * config (where they are kept as text).
 *
 * `SLACK_USER_TURN_LIMIT` turns per `SLACK_USER_TURN_WINDOW_MS` per person
 * (default 12 per 10 minutes; `SLACK_USER_TURN_LIMIT=0` turns the limit off).
 * `SLACK_LINK_HOSTS` is a comma-separated list of hosts whose masked links
 * keep their label in replies, besides github.com.
 *
 * A malformed value falls back to the default rather than switching the limit
 * off, so a typo cannot remove it.
 */
export const DEFAULT_USER_TURN_LIMIT = 12;
export const DEFAULT_USER_TURN_WINDOW_MS = 600_000;

export interface SlackSafetySettings {
  userRateLimit: UserTurnRateLimit;
  linkHosts: string[];
}

export function readSlackSafetySettings(
  env: Partial<Record<"SLACK_USER_TURN_LIMIT" | "SLACK_USER_TURN_WINDOW_MS" | "SLACK_LINK_HOSTS", string>>,
): SlackSafetySettings {
  return {
    userRateLimit: {
      maxTurns: nonNegativeInt(env.SLACK_USER_TURN_LIMIT, DEFAULT_USER_TURN_LIMIT),
      windowMs: positiveInt(env.SLACK_USER_TURN_WINDOW_MS, DEFAULT_USER_TURN_WINDOW_MS),
    },
    linkHosts: (env.SLACK_LINK_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter((host) => /^[a-z0-9.-]+$/.test(host) && host.includes(".")),
  };
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = nonNegativeInt(raw, fallback);
  return value > 0 ? value : fallback;
}
