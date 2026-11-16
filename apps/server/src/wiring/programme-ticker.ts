import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import type { EnvConfig } from "@lexi/config";
import type { PinoLoggerService } from "@lexi/logger";
import { CONFIG_TOKEN, LOGGER_TOKEN, PROGRAMME_WIRING_TOKEN } from "../tokens";
import type { ProgrammeWiring } from "./programme-wiring";

const LOG_CONTEXT = "ProgrammeTicker";

/**
 * Advances live rebuild programmes on a fixed interval. Does nothing when the
 * programme is off. A tick never overlaps the previous one, and a failed tick
 * is logged and retried on the next interval.
 */
@Injectable()
export class ProgrammeTicker implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    @Inject(CONFIG_TOKEN) private readonly config: EnvConfig,
    @Inject(LOGGER_TOKEN) private readonly logger: PinoLoggerService,
    @Inject(PROGRAMME_WIRING_TOKEN) private readonly programme: ProgrammeWiring,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.programme.advance) return;
    this.timer = setInterval(() => void this.tick(), this.config.PROGRAMME_TICK_MS);
    this.timer.unref();
    this.logger.log(`Advancing programmes every ${this.config.PROGRAMME_TICK_MS} ms`, LOG_CONTEXT);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** One step. Exposed for tests. */
  tick(): Promise<void> {
    const advance = this.programme.advance;
    if (!advance) return Promise.resolve();
    if (this.running) return this.running;
    this.running = advance()
      .then(() => undefined)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Programme tick failed: ${message}`, LOG_CONTEXT);
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
}
