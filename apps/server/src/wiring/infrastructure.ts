import type { App } from "@slack/bolt";
import type { EnvConfig } from "@lexi/config";
import { GitHubMutationGateway, OctokitGithubProvider, createOctokitClient, normalizePrivateKey } from "@lexi/github";
import type { PinoLoggerService } from "@lexi/logger";
import { createBoltApp } from "@lexi/slack";

const LOG_CONTEXT = "Infrastructure";

/**
 * The Bolt app shared by the Slack surface (which connects it over Socket
 * Mode) and the tools and workflow engine (which only use its Web API client).
 * Construction makes no network call.
 */
export function createSlackApp(config: EnvConfig): App {
  return createBoltApp({
    token: config.SLACK_BOT_TOKEN,
    signingSecret: config.SLACK_SIGNING_SECRET,
    appToken: config.SLACK_APP_TOKEN,
    socketMode: true,
  });
}

/**
 * The GitHub client every write goes through. The gateway enforces
 * GOVERNED_WRITES_ENABLED and GOVERNED_DRY_RUN on top of authorization.
 * Returns undefined, rather than throwing, when no credentials are configured
 * or they do not work, so the rest of the server still starts.
 */
export async function createGithubGateway(
  config: EnvConfig,
  logger: PinoLoggerService,
): Promise<GitHubMutationGateway | undefined> {
  const hasApp = Boolean(config.GITHUB_APP_ID && config.GITHUB_APP_PRIVATE_KEY);
  if (!hasApp && !config.GITHUB_TOKEN) {
    logger.warn("No GitHub credentials configured; GitHub tools and issue actions are off", LOG_CONTEXT);
    return undefined;
  }
  const baseUrl = config.GITHUB_API_BASE_URL || undefined;
  try {
    const octokit = await createOctokitClient({
      token: config.GITHUB_TOKEN || undefined,
      baseUrl,
      appId: config.GITHUB_APP_ID || undefined,
      privateKey: config.GITHUB_APP_PRIVATE_KEY || undefined,
      installationId: config.GITHUB_APP_INSTALLATION_ID || undefined,
      owner: config.GITHUB_OWNER,
      repo: config.GITHUB_REPO,
      logger,
    });
    const provider = new OctokitGithubProvider(
      octokit,
      logger,
      hasApp
        ? { appId: config.GITHUB_APP_ID, privateKey: normalizePrivateKey(config.GITHUB_APP_PRIVATE_KEY), baseUrl: baseUrl ?? "https://api.github.com" }
        : undefined,
    );
    return new GitHubMutationGateway(
      provider,
      { writesEnabled: config.GOVERNED_WRITES_ENABLED, dryRun: config.GOVERNED_DRY_RUN },
      logger,
    );
  } catch (error) {
    // Never log the error object itself: it can carry request headers.
    const message = error instanceof Error ? error.message : "unknown error";
    logger.error(`GitHub client could not be created (${message}); GitHub tools and issue actions are off`, LOG_CONTEXT);
    return undefined;
  }
}
