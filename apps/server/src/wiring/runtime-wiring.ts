import type { App } from "@slack/bolt";
import { AgentRuntime, ToolRegistry, createLlmClient, type AgentTurnRunner, type ToolModule } from "@lexi/agent";
import { createDefaultToolModules, governanceAuthorizer, parseChannelPostAllowlist, registryRepoScope } from "@lexi/agent-tools";
import { AppBuildService, AuditLogAppBuildStore, createAppBuildToolModule } from "@lexi/app-build";
import { DecisionEngine, OpenAiProvider, createOpenAiClient } from "@lexi/ai";
import type { EnvConfig } from "@lexi/config";
import type { PrismaService } from "@lexi/database";
import type { GitHubMutationGateway } from "@lexi/github";
import { NoopReproductionProvider, type AuthorizationService } from "@lexi/governance";
import type { PinoLoggerService } from "@lexi/logger";
import { createPrismaMemoryFacade } from "@lexi/memory";
import { createPiiMasker, describePiiCounts, parsePiiPatternList, type PiiMaskingOption } from "@lexi/privacy";
import type { MetricsRegistry } from "@lexi/metrics";
import { OwnershipResolver, loadOwnershipConfig } from "@lexi/ownership";
import { BoltSlackProvider, SlackMutationGateway } from "@lexi/slack";
import { loadRepoRegistry, type RepoRegistry } from "@lexi/workitems";
import { PrismaWorkflowRepository, WorkflowOrchestrator } from "@lexi/workflows";
import { join } from "node:path";
import type { IssueTarget, IssueWorkflowPort } from "../ports/issue-workflow.port";
import { NotWiredError, UnknownRepositoryError } from "./errors";

export { NotWiredError, UnknownRepositoryError } from "./errors";

/**
 * The one place the server constructs the agent runtime, its tools and the
 * workflow engine.
 *
 * Everything else in the server depends only on the interfaces returned here
 * (`AgentTurnRunner`, `IssueWorkflowPort`). A piece whose prerequisites are
 * missing (no model key, no GitHub credentials) is replaced by one that fails
 * at call time with {@link NotWiredError}: the server still boots, health and
 * metrics work, and a request gets an honest error instead of a silent no-op.
 */

/** What the factories may use to build their pieces. */
export interface RuntimeWiringDeps {
  config: EnvConfig;
  logger: PinoLoggerService;
  /** Fail-closed: not ready means every governed action is refused. */
  authorization: AuthorizationService;
  prisma: PrismaService;
  metrics: MetricsRegistry;
  /** The Bolt app. Its Web API client works whether or not Socket Mode is connected. */
  slackApp: App;
  /** Absent when no GitHub credentials are configured. */
  github?: GitHubMutationGateway;
  /** Tool modules built elsewhere (the rebuild programme), registered alongside the defaults. */
  extraModules?: ToolModule[];
}

const LOG_CONTEXT = "RuntimeWiring";

/**
 * Reads are governed too: a person who can message the bot is not thereby
 * entitled to every issue, file and Actions log the GitHub credentials reach.
 * The example policy grants this to the lowest role, `viewer`.
 */
export const READ_PERMISSION = "issue.read";
export const ACTIONS_READ_PERMISSION = "actions.read";

/** The agent loop the Slack surface calls once per message. */
export function createAgentTurnRunner(deps: RuntimeWiringDeps): AgentTurnRunner {
  const { config, logger } = deps;
  const apiKey = config.LITELLM_API_KEY || config.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn("No model API key is configured; the agent will refuse every message", LOG_CONTEXT);
    return notWiredRunner("The agent runtime (no model API key)");
  }

  const registry = new ToolRegistry({ authorizer: governanceAuthorizer(deps.authorization) });
  const policy = { writesEnabled: config.GOVERNED_WRITES_ENABLED, dryRun: config.GOVERNED_DRY_RUN };
  const repoRegistry = tryLoadRepoRegistry(config.GOVERNANCE_CONFIG_DIR, logger);
  const modules = createDefaultToolModules({
    github: deps.github,
    memory: createPrismaMemoryFacade(deps.prisma, { configDir: config.GOVERNANCE_CONFIG_DIR, logger }),
    registry: repoRegistry,
    ...(repoRegistry ? {} : { repositories: [`${config.GITHUB_OWNER}/${config.GITHUB_REPO}`] }),
    slackReader: deps.slackApp.client,
    slackPoster: new SlackMutationGateway(new BoltSlackProvider(deps.slackApp, logger), policy, logger),
    channelAllowlist: config.SLACK_CHANNEL_POST_ENABLED ? parseChannelPostAllowlist(config.SLACK_CHANNEL_POST_ALLOWLIST) : [],
    options: { agentName: config.AGENT_NAME, readPermission: READ_PERMISSION },
  });
  if (config.APP_BUILD_ENABLED && deps.github && repoRegistry) {
    const appBuild = new AppBuildService({
      github: deps.github,
      store: new AuditLogAppBuildStore(deps.prisma),
      ...(config.APP_BUILD_WORKFLOW_REF ? { workflowRef: config.APP_BUILD_WORKFLOW_REF } : {}),
      displayName: (actorId) => deps.authorization.describeCaller(actorId).name ?? actorId,
      logger,
    });
    modules.push(
      createAppBuildToolModule({
        service: appBuild,
        repositories: registryRepoScope(repoRegistry, "code"),
        ...(config.APP_BUILD_DEFAULT_REPOSITORY ? { defaultRepository: config.APP_BUILD_DEFAULT_REPOSITORY } : {}),
        readPermission: ACTIONS_READ_PERMISSION,
      }),
    );
  } else if (config.APP_BUILD_ENABLED) {
    logger.warn("APP_BUILD_ENABLED needs GitHub credentials and repos.yaml; app-build tools are off", LOG_CONTEXT);
  }
  modules.push(...(deps.extraModules ?? []).filter((module) => module.tools.length > 0));
  for (const module of modules) registry.register(module);
  logger.log(
    `Agent tools: ${modules.map((m) => `${m.name} (${m.tools.length})`).join(", ") || "none"}`,
    LOG_CONTEXT,
  );

  const model = config.SLACK_AGENT_MODEL || config.LITELLM_CLAUDE_MODEL;
  const llm = createLlmClient({
    apiKey,
    baseURL: config.LITELLM_BASE_URL || config.OPENAI_BASE_URL,
    model,
    piiMasking: modelPiiMasking(config, logger, "agent"),
  });
  return new AgentRuntime({
    llm,
    registry,
    prompt: { agentName: config.AGENT_NAME },
    limits: { wallClockMs: Math.max(1, config.SLACK_TURN_TIMEOUT_MS - 5_000) },
  });
}

/** The workflow engine behind POST /process, /reprocess and /retest. */
export function createIssueWorkflowPort(deps: RuntimeWiringDeps): IssueWorkflowPort {
  const { config, logger, github } = deps;
  if (!github) {
    logger.warn("No GitHub credentials are configured; issue actions will be refused", LOG_CONTEXT);
    return notWiredWorkflows("The workflow engine (no GitHub credentials)");
  }

  const decisionKey = config.OPENAI_API_KEY || config.LITELLM_API_KEY;
  if (!decisionKey) {
    logger.warn("No model API key is configured; issue actions will be refused", LOG_CONTEXT);
    return notWiredWorkflows("The workflow engine (no model API key)");
  }
  const repository = new PrismaWorkflowRepository(deps.prisma);
  const decisionEngine = new DecisionEngine(
    new OpenAiProvider(
      createOpenAiClient({
        apiKey: decisionKey,
        baseURL: (config.OPENAI_API_KEY ? config.OPENAI_BASE_URL : config.LITELLM_BASE_URL) || undefined,
        piiMasking: modelPiiMasking(config, logger, "decision-engine"),
      }),
      { model: config.OPENAI_MODEL },
      logger,
    ),
    logger,
  );
  const ownership = new OwnershipResolver(loadOwnershipConfig(join(config.GOVERNANCE_CONFIG_DIR, "ownership.yaml")));
  // Through the write gate, so GOVERNED_WRITES_ENABLED / GOVERNED_DRY_RUN stop
  // workflow notifications exactly as they stop agent posts.
  const slack = new SlackMutationGateway(
    new BoltSlackProvider(deps.slackApp, logger),
    { writesEnabled: config.GOVERNED_WRITES_ENABLED, dryRun: config.GOVERNED_DRY_RUN },
    logger,
  );
  const orchestrator = new WorkflowOrchestrator(
    repository,
    github,
    new NoopReproductionProvider(),
    decisionEngine,
    ownership,
    slack,
    deps.metrics,
    logger,
    undefined,
    undefined,
    { writesEnabled: config.GOVERNED_WRITES_ENABLED },
  );

  const repoRegistry = tryLoadRepoRegistry(config.GOVERNANCE_CONFIG_DIR, logger);
  const resolveIssueId = async (target: IssueTarget): Promise<string> => {
    const [owner, repo] = resolveRepository(target, config, repoRegistry);
    const existing = await repository.getIssueByGithubNumber(owner, repo, target.issueNumber);
    if (existing) return existing.id;
    const issue = await github.getIssue(owner, repo, target.issueNumber);
    const created = await repository.upsertIssue({
      githubIssueId: issue.githubIssueId,
      githubNumber: issue.githubNumber,
      repoOwner: issue.repoOwner,
      repoName: issue.repoName,
      title: issue.title,
      body: issue.body,
      url: issue.url,
      authorLogin: issue.authorLogin,
      labels: issue.labels,
      state: issue.state,
      githubCreatedAt: new Date(issue.githubCreatedAt),
      githubUpdatedAt: new Date(issue.githubUpdatedAt),
    });
    return created.id;
  };

  return {
    process: async (target) => orchestrator.processIssue(await resolveIssueId(target)),
    reprocess: async (target) => orchestrator.reprocessIssue(await resolveIssueId(target)),
    retest: async (target) => orchestrator.retest(await resolveIssueId(target)),
  };
}

/**
 * The request may name a repository, but only the default one or one listed
 * in the repository registry: the bearer token authorizes the caller, not any
 * repository the GitHub credentials happen to reach.
 */
export function resolveRepository(
  target: IssueTarget,
  config: Pick<EnvConfig, "GITHUB_OWNER" | "GITHUB_REPO">,
  registry: Pick<RepoRegistry, "listRepos"> | undefined,
): [string, string] {
  const fallback = `${config.GITHUB_OWNER}/${config.GITHUB_REPO}`;
  const requested = target.repository ?? fallback;
  const known =
    requested.toLowerCase() === fallback.toLowerCase() ||
    (registry?.listRepos() ?? []).some((entry) => entry.slug.toLowerCase() === requested.toLowerCase());
  if (!known) throw new UnknownRepositoryError(requested);
  const [owner, repo] = requested.split("/");
  return [owner, repo];
}

const maskers = new WeakMap<object, ReturnType<typeof createPiiMasker> | false>();

/**
 * What the model clients do with personal data, from MODEL_PII_MASKING and
 * MODEL_PII_EXTRA_PATTERNS. One masker per config, so a bad extra pattern is
 * reported once at boot rather than once per client. Each request that masked
 * something is logged at debug level with counts per kind — never the values.
 */
export function modelPiiMasking(
  config: Pick<EnvConfig, "MODEL_PII_MASKING" | "MODEL_PII_EXTRA_PATTERNS">,
  logger: PinoLoggerService,
  path: string,
): PiiMaskingOption {
  let masker = maskers.get(config);
  if (masker === undefined) {
    // Only an explicit false turns it off; a config without the field masks.
    if (config.MODEL_PII_MASKING === false) {
      logger.warn("MODEL_PII_MASKING=false: personal data is sent to the model unmasked", LOG_CONTEXT);
      masker = false;
    } else {
      masker = createPiiMasker({
        extraPatterns: parsePiiPatternList(config.MODEL_PII_EXTRA_PATTERNS),
        onInvalidPattern: (pattern, reason) =>
          logger.warn(`MODEL_PII_EXTRA_PATTERNS: ignoring pattern ${JSON.stringify(pattern)} (${reason})`, LOG_CONTEXT),
      });
      logger.log(`Model PII masking: on (${masker.extraPatternCount} extra pattern(s))`, LOG_CONTEXT);
    }
    maskers.set(config, masker);
  }
  if (masker === false) return false;
  return {
    masker,
    onMasked: (counts) => logger.debug(`Masked before model call (${path}): ${describePiiCounts(counts)}`, LOG_CONTEXT),
  };
}

export function tryLoadRepoRegistry(configDir: string, logger: PinoLoggerService): RepoRegistry | undefined {
  try {
    return loadRepoRegistry(configDir);
  } catch (error) {
    logger.warn(`No repository registry (${String(error)}); using GITHUB_OWNER/GITHUB_REPO only`, LOG_CONTEXT);
    return undefined;
  }
}

function notWiredRunner(component: string): AgentTurnRunner {
  return {
    async runTurn() {
      throw new NotWiredError(component);
    },
  };
}

function notWiredWorkflows(component: string): IssueWorkflowPort {
  const notWired = async (): Promise<never> => {
    throw new NotWiredError(component);
  };
  return { process: notWired, reprocess: notWired, retest: notWired };
}
