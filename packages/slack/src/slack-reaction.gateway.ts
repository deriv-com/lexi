import type { PinoLoggerService } from "@lexi/logger";

/**
 * Minimal shape of the Slack Web API surface we need for reactions. Declared
 * structurally (rather than importing `WebClient`) so callers can pass Bolt's
 * per-event `client` and tests can pass a plain object with two spies.
 */
export interface SlackReactionClient {
  reactions: {
    add(args: { channel: string; timestamp: string; name: string }): Promise<{ ok?: boolean; error?: string }>;
    remove(args: { channel: string; timestamp: string; name: string }): Promise<{ ok?: boolean; error?: string }>;
  };
}

export interface SlackReactionPolicy {
  writesEnabled: boolean;
  dryRun: boolean;
}

export interface SlackReactionTarget {
  channel: string;
  /** `ts` of the message being reacted to (Slack calls this `timestamp`). */
  messageTs: string;
}

export type SlackReactionStatus =
  /** The reaction call succeeded. */
  | "applied"
  /** Slack reported an expected no-op (already_reacted / no_reaction). */
  | "benign"
  /** The write gate blocked the call (writes disabled or dry-run). */
  | "suppressed"
  /** The call failed (missing scope, channel not found, network, ...). Swallowed. */
  | "failed";

export interface SlackReactionOutcome {
  status: SlackReactionStatus;
  emoji: string;
  reason?: string;
}

export interface SlackReactionAuditEntry {
  action: string;
  emoji: string;
  timestamp: string;
  reason: string;
  wouldExecute: boolean;
}

/**
 * Slack reports these as errors, but for our purposes they mean "the desired
 * end state is already true":
 *  - `already_reacted` — we (or a retry) already added this emoji.
 *  - `no_reaction`     — nothing to remove, e.g. the ack add was suppressed.
 */
const BENIGN_ERROR_CODES = new Set(["already_reacted", "no_reaction"]);

const WRITE_GATE_REASON = "GOVERNED_WRITES_ENABLED=false";
const DRY_RUN_REASON = "GOVERNED_DRY_RUN=true";

/**
 * Adds/removes emoji reactions on Slack messages as progress feedback.
 *
 * Two invariants, both deliberate:
 *
 * 1. NEVER throws. Reactions are cosmetic acknowledgements; a missing OAuth
 *    scope, a rate limit or a network blip must not delay or fail the reply
 *    the user actually asked for. Every failure is logged and swallowed, and
 *    the caller gets a status back instead of an exception.
 *
 * 2. Goes THROUGH the write gate (`SlackMutationGateway`'s policy), it does not
 *    bypass it. Reactions arguably aren't state changes to a tracked artifact,
 *    so a "cosmetic writes are exempt" carve-out would be defensible — but this
 *    codebase gates every outbound Slack/GitHub mutation for governance and
 *    auditability reasons, and has a standing bug class about ungated Slack
 *    writes. Consistency wins over convenience: when GOVERNED_WRITES_ENABLED is
 *    false or GOVERNED_DRY_RUN is true, the reaction is not sent, and an audit
 *    entry records what would have been written. Operators who want visible
 *    acknowledgements in a read-only deployment should get a dedicated flag
 *    rather than a silent exemption here.
 *
 * Requires the `reactions:write` OAuth scope. Without it Slack returns
 * `missing_scope`, which is logged once per call and otherwise ignored.
 */
export class SlackReactionGateway {
  readonly dryRunAudit: SlackReactionAuditEntry[] = [];

  constructor(
    private readonly policy: SlackReactionPolicy,
    private readonly logger: PinoLoggerService,
  ) {}

  async add(
    client: SlackReactionClient,
    target: SlackReactionTarget,
    emoji: string,
  ): Promise<SlackReactionOutcome> {
    return await this.run("reactions.add", emoji, () =>
      client.reactions.add({ channel: target.channel, timestamp: target.messageTs, name: emoji }),
    );
  }

  async remove(
    client: SlackReactionClient,
    target: SlackReactionTarget,
    emoji: string,
  ): Promise<SlackReactionOutcome> {
    return await this.run("reactions.remove", emoji, () =>
      client.reactions.remove({ channel: target.channel, timestamp: target.messageTs, name: emoji }),
    );
  }

  /**
   * Replaces the in-flight acknowledgement with the outcome emoji. The remove
   * is best-effort and independent of the add: if the ack was never applied
   * (gate suppressed it, or the scope is missing) we still try the outcome, and
   * a leftover ack emoji is strictly better than no outcome emoji.
   */
  async replace(
    client: SlackReactionClient,
    target: SlackReactionTarget,
    from: string,
    to: string,
  ): Promise<SlackReactionOutcome> {
    if (from !== to) {
      await this.remove(client, target, from);
    }
    return await this.add(client, target, to);
  }

  private async run(
    action: string,
    emoji: string,
    operation: () => Promise<{ ok?: boolean; error?: string }>,
  ): Promise<SlackReactionOutcome> {
    if (!this.policy.writesEnabled || this.policy.dryRun) {
      const reason = this.policy.dryRun ? DRY_RUN_REASON : WRITE_GATE_REASON;
      this.dryRunAudit.push({
        action,
        emoji,
        timestamp: new Date().toISOString(),
        reason,
        wouldExecute: true,
      });
      this.logger.warn(`Would execute Slack mutation: ${action} :${emoji}: — ${reason}`, "SlackReactionGateway");
      return { status: "suppressed", emoji, reason };
    }

    try {
      const response = await operation();
      const code = response?.error;
      if (code && BENIGN_ERROR_CODES.has(code)) {
        return { status: "benign", emoji, reason: code };
      }
      if (code) {
        this.logger.warn(`${action} :${emoji}: returned ${code} — ignored`, "SlackReactionGateway");
        return { status: "failed", emoji, reason: code };
      }
      return { status: "applied", emoji };
    } catch (error) {
      const code = extractSlackErrorCode(error);
      if (BENIGN_ERROR_CODES.has(code)) {
        return { status: "benign", emoji, reason: code };
      }
      // Swallowed on purpose — see invariant (1) above.
      this.logger.warn(
        `${action} :${emoji}: failed (${code}) — reaction skipped, reply unaffected${
          code === "missing_scope" ? " (grant the reactions:write OAuth scope)" : ""
        }`,
        "SlackReactionGateway",
      );
      return { status: "failed", emoji, reason: code };
    }
  }
}

/**
 * Slack SDK errors carry the machine-readable code on `data.error`; the
 * `message` is prose like "An API error occurred: missing_scope".
 */
export function extractSlackErrorCode(error: unknown): string {
  const data = (error as { data?: { error?: string } } | null)?.data;
  if (data?.error) {
    return data.error;
  }
  const message = error instanceof Error ? error.message : String(error ?? "unknown");
  const match = /([a-z][a-z0-9_]{3,})\s*$/.exec(message.trim());
  return match ? match[1] : message || "unknown";
}
