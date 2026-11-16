import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import type { App } from "@slack/bolt";
import type { AgentTurnRunner } from "@lexi/agent";
import type { EnvConfig } from "@lexi/config";
import type { AuthorizationService } from "@lexi/governance";
import {
  AGENT_TURN_RUNNER_TOKEN,
  AUTHORIZATION_SERVICE_TOKEN,
  CONFIG_TOKEN,
  LOGGER_TOKEN,
  SLACK_APP_TOKEN,
} from "../tokens";
import { SlackConversationHandler, type ConversationLogger } from "./slack-conversation.handler";
import { readSlackSafetySettings } from "./slack-safety-settings";

const LOG_CONTEXT = "SlackSurface";
/** How long shutdown waits for in-flight turns before closing anyway. */
const SHUTDOWN_DRAIN_MS = 10_000;

/**
 * Owns the Bolt app: connects over Socket Mode after the rest of the server is
 * up, and disconnects first on shutdown so no new turn starts while the
 * running ones finish.
 *
 * Off unless both `SLACK_AGENT_ENABLED=true` and `SLACK_APP_TOKEN` is set; the
 * HTTP surface works either way.
 */
@Injectable()
export class SlackSurface implements OnApplicationBootstrap, OnApplicationShutdown {
  private app?: App;
  private handler?: SlackConversationHandler;

  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: EnvConfig,
    @Inject(LOGGER_TOKEN) private readonly logger: ConversationLogger,
    @Inject(AGENT_TURN_RUNNER_TOKEN) private readonly runner: AgentTurnRunner,
    @Inject(SLACK_APP_TOKEN) private readonly slackApp: App,
    @Inject(AUTHORIZATION_SERVICE_TOKEN) private readonly authorization: AuthorizationService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.SLACK_AGENT_ENABLED) {
      this.logger.warn("SLACK_AGENT_ENABLED is false — not connecting to Slack", LOG_CONTEXT);
      return;
    }
    if (!this.config.SLACK_APP_TOKEN) {
      this.logger.warn("SLACK_APP_TOKEN is not set — Socket Mode needs an app-level token", LOG_CONTEXT);
      return;
    }

    const app = this.slackApp;
    const auth = await app.client.auth.test();
    const safety = readSlackSafetySettings(this.config);
    if (!auth.user_id) throw new Error("Slack auth.test returned no user id; check SLACK_BOT_TOKEN");

    this.handler = new SlackConversationHandler({
      runner: this.runner,
      logger: this.logger,
      botUserId: auth.user_id,
      botId: auth.bot_id,
      turnTimeoutMs: this.config.SLACK_TURN_TIMEOUT_MS,
      abortGraceMs: this.config.SLACK_TURN_ABORT_GRACE_MS,
      maxQueuedPerThread: this.config.SLACK_THREAD_QUEUE_MAX,
      historyLimit: this.config.SLACK_THREAD_HISTORY_LIMIT,
      // Someone every tool would refuse (not listed, unknownUserRole: denied)
      // is refused here, before a model turn is spent on them.
      admit: (actorId) => this.authorization.accessRefusal(actorId),
      userRateLimit: safety.userRateLimit,
      linkHosts: safety.linkHosts,
    });
    this.handler.register(app as unknown as Parameters<SlackConversationHandler["register"]>[0]);
    await app.start();
    this.app = app;
    this.logger.log(`${this.config.AGENT_NAME} connected to Slack in Socket Mode as ${auth.user_id}`, LOG_CONTEXT);
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.app) return;
    await this.app.stop().catch((error: unknown) => {
      this.logger.warn(`Stopping the Slack app failed: ${String(error)}`, LOG_CONTEXT);
    });
    this.app = undefined;
    if (this.handler) {
      const drained = await Promise.race([
        this.handler.idle().then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), SHUTDOWN_DRAIN_MS).unref()),
      ]);
      if (!drained) this.logger.warn("Shut down with Slack turns still running", LOG_CONTEXT);
    }
  }
}
