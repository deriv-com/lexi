import { PinoLoggerService } from "@lexi/logger";
import { SlackMessagePayload, SlackMessageResult, SlackProvider } from "./slack-provider.interface";

const WRITE_GATE_REASON = "GOVERNED_WRITES_ENABLED=false";

interface MutationAuditEntry {
  action: string;
  timestamp: string;
  reason: string;
  wouldExecute: boolean;
}

interface MutationPolicy {
  writesEnabled: boolean;
  dryRun: boolean;
}

/**
 * Gates outbound Slack notifications when global writes are disabled.
 */
export class SlackMutationGateway implements SlackProvider {
  readonly dryRunAudit: MutationAuditEntry[] = [];

  constructor(
    private readonly inner: SlackProvider,
    private readonly policy: MutationPolicy,
    private readonly logger: PinoLoggerService,
  ) {}

  private async gateMutation<T>(action: string, operation: () => Promise<T>): Promise<{
    executed: boolean;
    wouldExecute: boolean;
    action: string;
    result?: T;
    reason?: string;
  }> {
    if (!this.policy.writesEnabled || this.policy.dryRun) {
      const reason = this.policy.dryRun ? "GOVERNED_DRY_RUN=true" : WRITE_GATE_REASON;
      this.dryRunAudit.push({
        action,
        timestamp: new Date().toISOString(),
        reason,
        wouldExecute: true,
      });
      this.logger.warn(`Would execute Slack mutation: ${action} — ${reason}`, "SlackMutationGateway");
      return {
        executed: false,
        wouldExecute: true,
        action,
        reason,
      };
    }
    const result = await operation();
    return { executed: true, wouldExecute: false, action, result };
  }

  async sendMessage(payload: SlackMessagePayload): Promise<SlackMessageResult> {
    const gated = await this.gateMutation("slack.sendMessage", () => this.inner.sendMessage(payload));
    if (!gated.executed) {
      return { ok: false, error: gated.reason ?? WRITE_GATE_REASON };
    }
    return gated.result as SlackMessageResult;
  }

  async updateMessage(
    channel: string,
    ts: string,
    text: string,
    blocks?: Array<Record<string, unknown>>,
  ): Promise<SlackMessageResult> {
    const gated = await this.gateMutation("slack.updateMessage", () =>
      this.inner.updateMessage(channel, ts, text, blocks),
    );
    if (!gated.executed) {
      return { ok: false, error: gated.reason ?? WRITE_GATE_REASON };
    }
    return gated.result as SlackMessageResult;
  }
}
