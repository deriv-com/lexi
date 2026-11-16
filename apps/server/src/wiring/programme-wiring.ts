import type { App } from "@slack/bolt";
import type { ToolModule } from "@lexi/agent";
import type { EnvConfig } from "@lexi/config";
import type { PrismaService } from "@lexi/database";
import type { GitHubMutationGateway } from "@lexi/github";
import type { AuthorizationService } from "@lexi/governance";
import type { PinoLoggerService } from "@lexi/logger";
import type { MemoryFacade } from "@lexi/memory";
import {
  MILESTONE_REVIEW_ACTION_PREFIX,
  PrismaProgrammeSpecReader,
  PrismaProgrammeStore,
  PrismaRunEvidenceStore,
  ProgrammeBuildService,
  ProgrammeMilestoneReviewService,
  createProgrammeToolModule,
  loadProgrammePolicy,
  type ProgrammePolicy,
} from "@lexi/programme";
import type { SlackMutationGateway } from "@lexi/slack";
import type { RepoRegistry } from "@lexi/workitems";
import { join } from "node:path";
import type { ProgrammeHttpDeps } from "../http/programme-http.deps";

const LOG_CONTEXT = "ProgrammeWiring";

export interface ProgrammeWiringDeps {
  config: EnvConfig;
  logger: PinoLoggerService;
  authorization: AuthorizationService;
  prisma: PrismaService;
  slackApp: App;
  /** Gated: GOVERNED_WRITES_ENABLED / GOVERNED_DRY_RUN apply to programme posts. */
  slack: SlackMutationGateway;
  github?: GitHubMutationGateway;
  registry?: RepoRegistry;
  memory?: MemoryFacade;
}

export interface ProgrammeWiring {
  /** The agent tools. Empty module when the programme is off. */
  toolModule?: ToolModule;
  /** What the programme HTTP routes need. Always present so the routes refuse honestly. */
  http: ProgrammeHttpDeps;
  /** Advances every live programme one step. Absent when the programme is off. */
  advance?: () => Promise<unknown>;
}

/**
 * Builds the rebuild programme when PROGRAMME_ENABLED is on and its
 * prerequisites exist (GitHub credentials, repos.yaml, programme-policy.yaml).
 * Otherwise returns only the HTTP dependencies, all of which refuse.
 */
export function createProgrammeWiring(deps: ProgrammeWiringDeps): ProgrammeWiring {
  const { config, logger, prisma } = deps;
  const evidence = new PrismaRunEvidenceStore(prisma);
  const store = new PrismaProgrammeStore(prisma);
  const http: ProgrammeHttpDeps = {
    programmeEnabled: false,
    briefToken: config.PROGRAMME_BRIEF_TOKEN,
    evidenceEnabled: config.EVIDENCE_INGEST_ENABLED,
    evidenceToken: config.EVIDENCE_WEBHOOK_TOKEN,
    build: null,
    store: null,
    evidence: config.EVIDENCE_INGEST_ENABLED ? evidence : null,
    isKnownAttempt: async (attemptId) => Boolean(await prisma.quickFixAttempt.findUnique({ where: { id: attemptId } })),
    // Every programme attempt (build task and sweep) records the repository it
    // was dispatched to, so evidence for it must come from that repository.
    repositoryOfAttempt: async (attemptId) =>
      (await prisma.quickFixAttempt.findUnique({ where: { id: attemptId }, select: { repository: true } }))?.repository ?? null,
    logger,
  };

  if (!config.PROGRAMME_ENABLED) return { http };
  if (!deps.github || !deps.registry) {
    logger.warn("PROGRAMME_ENABLED needs GitHub credentials and repos.yaml; the programme is off", LOG_CONTEXT);
    return { http };
  }
  let policy: ProgrammePolicy;
  try {
    policy = loadProgrammePolicy(join(config.GOVERNANCE_CONFIG_DIR, "programme-policy.yaml"));
  } catch (error) {
    logger.error(`programme-policy.yaml could not be loaded (${String(error)}); the programme is off`, LOG_CONTEXT);
    return { http };
  }

  const registry = deps.registry;
  const build = new ProgrammeBuildService({
    store,
    specs: new PrismaProgrammeSpecReader(prisma),
    evidence,
    github: deps.github,
    attempts: prisma,
    registry,
    policy,
    authz: deps.authorization,
    notifier: deps.slack,
    ...(deps.memory ? { memory: deps.memory } : {}),
    ...(config.PROGRAMME_FINDINGS_REPO ? { findingsRepoSlug: config.PROGRAMME_FINDINGS_REPO } : {}),
    flags: {
      programmeEnabled: true,
      dispatchEnabled: config.PROGRAMME_DISPATCH_ENABLED,
      autoMergeEnabled: config.PROGRAMME_AUTO_MERGE_ENABLED,
      publicBaseUrl: config.PROGRAMME_PUBLIC_BASE_URL,
      reviewChannel: config.PROGRAMME_REVIEW_CHANNEL,
    },
    logger,
  });

  // Milestone approval and the hardening conclusion are human clicks on a
  // review card, never agent tools. The service re-checks authorization.
  const review = new ProgrammeMilestoneReviewService({
    store,
    build,
    authz: deps.authorization,
    policy,
    programmeEnabled: true,
    logger,
  });
  deps.slackApp.action(new RegExp(`^${MILESTONE_REVIEW_ACTION_PREFIX}`), async ({ ack, action, body, respond }) => {
    await ack();
    const actionId = "action_id" in action ? action.action_id : "";
    const value = "value" in action && typeof action.value === "string" ? action.value : "";
    const result = await review.handleAction(actionId, value, body.user.id);
    await respond({ text: result.text, replace_original: false, response_type: "ephemeral" });
  });

  // A placeholder repo is never writable; reposWithRole already leaves it out.
  const writable = new Set(registry.reposWithRole("code").map((repo) => repo.key));
  const allowedRepoKeys = (policy.programmes?.allowedRepoKeys ?? []).filter(
    (key) => writable.has(key) && registry.isAutonomous(key),
  );

  return {
    toolModule: createProgrammeToolModule({ build, programmeEnabled: true, allowedRepoKeys }),
    http: { ...http, programmeEnabled: true, build, store },
    advance: () => build.advance(),
  };
}
