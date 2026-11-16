import { Module, type Provider } from "@nestjs/common";
import type { App } from "@slack/bolt";
import type { GitHubMutationGateway } from "@lexi/github";
import { loadConfig, type EnvConfig } from "@lexi/config";
import { PrismaService } from "@lexi/database";
import type { AuthorizationService } from "@lexi/governance";
import { PinoLoggerService } from "@lexi/logger";
import { MetricsRegistry } from "@lexi/metrics";
import { loadAuthorization } from "./authorization/load-authorization";
import { ActionsController } from "./http/actions.controller";
import { BearerTokenGuard } from "./http/bearer-token.guard";
import { HealthController } from "./http/health.controller";
import { MetricsController } from "./http/metrics.controller";
import { SlackSurface } from "./slack/slack-surface";
import {
  AGENT_TURN_RUNNER_TOKEN,
  AUTHORIZATION_SERVICE_TOKEN,
  CONFIG_TOKEN,
  ISSUE_WORKFLOW_PORT_TOKEN,
  LOGGER_TOKEN,
  GITHUB_GATEWAY_TOKEN,
  METRICS_REGISTRY_TOKEN,
  PRISMA_SERVICE_TOKEN,
  PROGRAMME_WIRING_TOKEN,
  SLACK_APP_TOKEN,
} from "./tokens";
import { createGithubGateway, createSlackApp } from "./wiring/infrastructure";
import { ProgrammeTicker } from "./wiring/programme-ticker";
import { createProgrammeWiring, type ProgrammeWiring } from "./wiring/programme-wiring";
import { ProgrammeController } from "./http/programme.controller";
import { PROGRAMME_HTTP_DEPS_TOKEN } from "./http/programme-http.deps";
import { ProgrammeBriefTokenGuard, ProgrammeEvidenceTokenGuard } from "./http/programme-token.guard";
import { BoltSlackProvider, SlackMutationGateway } from "@lexi/slack";
import { createPrismaMemoryFacade } from "@lexi/memory";
import { createAgentTurnRunner, createIssueWorkflowPort, tryLoadRepoRegistry, type RuntimeWiringDeps } from "./wiring/runtime-wiring";

const WIRING_DEPS = [
  CONFIG_TOKEN,
  LOGGER_TOKEN,
  AUTHORIZATION_SERVICE_TOKEN,
  PRISMA_SERVICE_TOKEN,
  METRICS_REGISTRY_TOKEN,
  SLACK_APP_TOKEN,
  GITHUB_GATEWAY_TOKEN,
];

function wiringDeps(
  config: EnvConfig,
  logger: PinoLoggerService,
  authorization: AuthorizationService,
  prisma: PrismaService,
  metrics: MetricsRegistry,
  slackApp: App,
  github: GitHubMutationGateway | null,
): RuntimeWiringDeps {
  return { config, logger, authorization, prisma, metrics, slackApp, github: github ?? undefined };
}

const providers: Provider[] = [
  // Validated at boot: a misconfigured deployment refuses to start and says why.
  { provide: CONFIG_TOKEN, useFactory: () => loadConfig() },
  {
    provide: LOGGER_TOKEN,
    inject: [CONFIG_TOKEN],
    useFactory: (config: EnvConfig) =>
      new PinoLoggerService({ level: config.LOG_LEVEL, name: config.AGENT_NAME.toLowerCase() }),
  },
  {
    provide: AUTHORIZATION_SERVICE_TOKEN,
    inject: [CONFIG_TOKEN, LOGGER_TOKEN],
    useFactory: (config: EnvConfig, logger: PinoLoggerService) => {
      const loaded = loadAuthorization(config.GOVERNANCE_CONFIG_DIR);
      if (loaded.loaded) {
        logger.log(`Authorization policy loaded from ${loaded.path}`, "Authorization");
      } else {
        logger.error(
          `Authorization policy unavailable (${loaded.error}); every governed action will be refused`,
          "Authorization",
        );
      }
      return loaded.service;
    },
  },
  {
    provide: PRISMA_SERVICE_TOKEN,
    inject: [CONFIG_TOKEN],
    useFactory: (config: EnvConfig) => new PrismaService(config.DATABASE_URL),
  },
  { provide: METRICS_REGISTRY_TOKEN, useFactory: () => new MetricsRegistry() },
  { provide: SLACK_APP_TOKEN, inject: [CONFIG_TOKEN], useFactory: (config: EnvConfig) => createSlackApp(config) },
  {
    provide: GITHUB_GATEWAY_TOKEN,
    inject: [CONFIG_TOKEN, LOGGER_TOKEN],
    // Nest treats an undefined provider value as missing; null stands for "not configured".
    useFactory: async (config: EnvConfig, logger: PinoLoggerService) => (await createGithubGateway(config, logger)) ?? null,
  },
  {
    provide: AGENT_TURN_RUNNER_TOKEN,
    inject: [...WIRING_DEPS, PROGRAMME_WIRING_TOKEN],
    useFactory: (...args: [...Parameters<typeof wiringDeps>, ProgrammeWiring]) => {
      const programme = args.pop() as ProgrammeWiring;
      const deps = wiringDeps(...(args as unknown as Parameters<typeof wiringDeps>));
      return createAgentTurnRunner({ ...deps, extraModules: programme.toolModule ? [programme.toolModule] : [] });
    },
  },
  {
    provide: ISSUE_WORKFLOW_PORT_TOKEN,
    inject: WIRING_DEPS,
    useFactory: (...deps: Parameters<typeof wiringDeps>) => createIssueWorkflowPort(wiringDeps(...deps)),
  },
  {
    provide: PROGRAMME_WIRING_TOKEN,
    inject: [CONFIG_TOKEN, LOGGER_TOKEN, AUTHORIZATION_SERVICE_TOKEN, PRISMA_SERVICE_TOKEN, SLACK_APP_TOKEN, GITHUB_GATEWAY_TOKEN],
    useFactory: (
      config: EnvConfig,
      logger: PinoLoggerService,
      authorization: AuthorizationService,
      prisma: PrismaService,
      slackApp: App,
      github: GitHubMutationGateway | null,
    ) =>
      createProgrammeWiring({
        config,
        logger,
        authorization,
        prisma,
        slackApp,
        slack: new SlackMutationGateway(
          new BoltSlackProvider(slackApp, logger),
          { writesEnabled: config.GOVERNED_WRITES_ENABLED, dryRun: config.GOVERNED_DRY_RUN },
          logger,
        ),
        github: github ?? undefined,
        registry: tryLoadRepoRegistry(config.GOVERNANCE_CONFIG_DIR, logger),
        memory: createPrismaMemoryFacade(prisma, { configDir: config.GOVERNANCE_CONFIG_DIR, logger }),
      }),
  },
  {
    provide: PROGRAMME_HTTP_DEPS_TOKEN,
    inject: [PROGRAMME_WIRING_TOKEN],
    useFactory: (programme: ProgrammeWiring) => programme.http,
  },
  BearerTokenGuard,
  ProgrammeBriefTokenGuard,
  ProgrammeEvidenceTokenGuard,
  ProgrammeTicker,
  SlackSurface,
];

@Module({
  controllers: [HealthController, MetricsController, ActionsController, ProgrammeController],
  providers,
})
export class AppModule {}
