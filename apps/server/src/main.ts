import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { EnvConfig } from "@lexi/config";
import type { PinoLoggerService } from "@lexi/logger";
import { AppModule } from "./app.module";
import { CONFIG_TOKEN, LOGGER_TOKEN } from "./tokens";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get<PinoLoggerService>(LOGGER_TOKEN);
  app.useLogger(logger);
  // SIGTERM/SIGINT run the shutdown hooks: Slack disconnects first, running
  // turns get a moment to finish, then the database closes.
  app.enableShutdownHooks();

  const config = app.get<EnvConfig>(CONFIG_TOKEN);
  await app.listen(config.PORT);
  logger.log(`${config.AGENT_NAME} server listening on port ${config.PORT}`, "Bootstrap");
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet, so this one goes to stderr directly.
  console.error("Fatal error during bootstrap:", error);
  process.exit(1);
});
