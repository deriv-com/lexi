import pino, { Logger as PinoInstance, LoggerOptions } from "pino";
import { LoggerService as NestLoggerService } from "@nestjs/common";

/**
 * The single name for "the log text", used BOTH as pino's `messageKey` and as
 * the key `PinoLoggerService.format()` emits. Exported so the contract is
 * assertable rather than duplicated as two string literals that can drift.
 *
 * Common log platforms map `message` as the log text and do not recognise
 * pino's default `msg`, which is why it is this value and not the default.
 */
export const MESSAGE_KEY = "message" as const;

export interface LoggerConfig {
  level: string;
  prettyPrint?: boolean;
  name?: string;
}

/**
 * Creates a raw Pino logger instance. Used by non-Nest contexts (e.g.
 * BullMQ processors instantiated outside the Nest DI container, scripts).
 */
export function createLogger(config: LoggerConfig): PinoInstance {
  const options: LoggerOptions = {
    level: config.level,
    name: config.name ?? "lexi",
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Emit the log text as `message`, not pino's default `msg`. Several log
    // platforms map `message` to the searchable message field and leave `msg`
    // as an ordinary attribute, so a phrase search would otherwise find
    // nothing. Setting it here travels with the code to every environment.
    messageKey: MESSAGE_KEY,
  };

  if (config.prettyPrint) {
    return pino({
      ...options,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      },
    });
  }

  return pino(options);
}

/**
 * Nest-compatible LoggerService implementation backed by Pino. Can be
 * injected anywhere in the Nest application via the LOGGER token or used
 * directly as `app.useLogger(new PinoLoggerService(...))`.
 */
export class PinoLoggerService implements NestLoggerService {
  private readonly pino: PinoInstance;

  constructor(config: LoggerConfig, private context?: string) {
    this.pino = createLogger(config);
  }

  withContext(context: string): PinoLoggerService {
    const clone = Object.create(PinoLoggerService.prototype) as PinoLoggerService;
    (clone as unknown as { pino: PinoInstance }).pino = this.pino;
    clone.context = context;
    return clone;
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.pino.info(this.format(message, optionalParams));
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.pino.error(this.format(message, optionalParams));
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.pino.warn(this.format(message, optionalParams));
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.pino.debug(this.format(message, optionalParams));
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.pino.trace(this.format(message, optionalParams));
  }

  child(bindings: Record<string, unknown>): PinoInstance {
    return this.pino.child(bindings);
  }

  private format(message: unknown, optionalParams: unknown[]): Record<string, unknown> {
    const context = optionalParams.length > 0 ? optionalParams[optionalParams.length - 1] : this.context;
    return {
      // MUST match `messageKey` in createLogger. These two are one decision
      // expressed in two places, and splitting them silently empties the log.
      //
      // This method passes an OBJECT to pino, so pino takes the message from
      // whichever key `messageKey` names. Emitting `msg` while the option said
      // `message` meant pino found no message key at all: `msg` degraded to an
      // ordinary field and every line went out with an EMPTY message — which
      // is the same symptom as the bug the option was meant to fix, so changing
      // only the option looked like a fix and changed nothing observable.
      [MESSAGE_KEY]: typeof message === "string" ? message : JSON.stringify(message),
      context: this.context ?? context,
    };
  }
}
