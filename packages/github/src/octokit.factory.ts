import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

/**
 * Which credential the factory authenticated with.
 *
 *  - "app"   → GitHub App installation token (preferred). Short-lived, scoped to
 *              the installation, and refreshed by @octokit/auth-app.
 *  - "token" → legacy personal access token. Retained as a fallback so the App
 *              rollout can deploy before the secret is populated and roll back
 *              without a code change.
 */
export type GithubAuthMode = "app" | "token";

/** Minimal subset of the Nest LoggerService shape the factory needs. */
export interface OctokitFactoryLogger {
  log(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  /** Optional so existing callers and test doubles need no change. */
  error?(message: string, ...args: unknown[]): void;
}

export interface OctokitFactoryOptions {
  /** Personal access token. Used only when App credentials are absent. */
  token?: string;
  baseUrl?: string;

  /** GitHub App id (numeric, e.g. "1234567"). */
  appId?: string | number;
  /**
   * GitHub App private key in PEM form. Because secrets are injected as env
   * vars, literal "\n" escape sequences are accepted and normalised — see
   * {@link normalizePrivateKey}.
   */
  privateKey?: string;
  /**
   * Optional. When set, the installation lookup is skipped entirely. Pinning
   * this is more predictable than resolving it on every boot, so prefer setting
   * it once the id is known.
   */
  installationId?: string | number;

  /** Used to resolve the installation id when it is not pinned. */
  owner?: string;
  repo?: string;

  logger?: OctokitFactoryLogger;
}

function isPresent(value: string | number | undefined): boolean {
  if (value === undefined || value === null) return false;
  return String(value).trim().length > 0;
}

/**
 * Normalises a PEM private key that arrived through an environment variable.
 *
 * Multi-line env vars are fragile (Kubernetes manifests, `docker --env-file`,
 * and shell `export` all mangle embedded newlines differently), so the secret
 * is expected to be stored single-line with "\n" escape sequences. This turns
 * those back into real newlines and tolerates the variants that show up in
 * practice: CRLF, a value wrapped in quotes, and stray surrounding whitespace.
 */
export function normalizePrivateKey(raw: string): string {
  let key = raw.trim();

  // Some secret stores round-trip the value with the quotes included.
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }

  key = key
    // Double-escaped first: a value escaped twice on its way into a base64
    // manifest arrives as "\\n", and collapsing the single-escape form first
    // would leave a stray backslash inside the PEM body.
    .replace(/\\\\r\\\\n/g, "\n")
    .replace(/\\\\n/g, "\n")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\r\n/g, "\n")
    .trim();

  // openssl and universal-github-app-jwt both expect a trailing newline.
  return `${key}\n`;
}

/**
 * Decides which credential to use. App auth wins whenever both the App id and
 * the private key are present; otherwise fall back to the PAT.
 */
export function resolveAuthMode(options: OctokitFactoryOptions): GithubAuthMode {
  return isPresent(options.appId) && isPresent(options.privateKey) ? "app" : "token";
}

/**
 * User PATs (classic, fine-grained, OAuth) mint signed `private-user-images`
 * URLs in issue HTML / GFM. GitHub App installation tokens (`ghs_`) do not —
 * `github.com/user-attachments` stays cookie-gated. Never log this value.
 */
export function isUserPatForEvidenceHtml(token: string): boolean {
  const trimmed = token.trim();
  return trimmed.startsWith("ghp_") || trimmed.startsWith("github_pat_") || trimmed.startsWith("gho_");
}

/** Token-mode Octokit used only to mint signed attachment CDN URLs. */
export function createEvidenceHtmlOctokit(options: { token?: string; baseUrl?: string }): Octokit | undefined {
  const token = options.token?.trim() ?? "";
  if (!isUserPatForEvidenceHtml(token)) return undefined;
  return new Octokit({ auth: token, baseUrl: normalizeBaseUrl(options.baseUrl) });
}

function normalizeBaseUrl(baseUrl?: string): string | undefined {
  return baseUrl && baseUrl.length > 0 ? baseUrl : undefined;
}

/**
 * Resolves the installation id using an app-level JWT. Prefers the
 * repository-scoped endpoint (unambiguous even when the App is installed on
 * several accounts) and falls back to listing installations, which is what a
 * single-installation App will hit.
 *
 * Exported (not just used internally at boot for the primary
 * GITHUB_OWNER/GITHUB_REPO): `OctokitGithubProvider`'s cross-repo dispatch
 * methods (dispatchWorkflow/findDispatchedRun) need this same
 * resolution per *target* repo, since a GitHub App installation token is
 * strictly scoped to the org it was minted for — see that class's own
 * `getClientForRepo` for why one fixed installationId cannot serve every
 * repo the quick-fix trigger might dispatch to.
 */
export async function resolveInstallationId(
  appOctokit: Octokit,
  owner: string | undefined,
  repo: string | undefined,
): Promise<number> {
  if (owner && repo) {
    try {
      const { data } = await appOctokit.request("GET /repos/{owner}/{repo}/installation", { owner, repo });
      const id = (data as { id?: number }).id;
      if (typeof id === "number") return id;
    } catch (error) {
      // 404/403 here means the App is not installed on that repo (or cannot see
      // it). Fall through to the account-level listing before giving up, so a
      // stale GITHUB_REPO is not fatal. Anything else is a real failure.
      const status = (error as { status?: number }).status;
      if (status !== 404 && status !== 403) throw error;
    }
  }

  const { data } = await appOctokit.request("GET /app/installations", { per_page: 100 });
  const installations = (data as Array<{ id: number; account?: { login?: string } | null }>) ?? [];
  if (installations.length === 0) {
    throw new Error(
      'GitHub App auth is configured but the App has no installations. Install the GitHub App ' +
        "on the target organisation, or set GITHUB_APP_INSTALLATION_ID.",
    );
  }

  const match = owner
    ? installations.find((i) => i.account?.login?.toLowerCase() === owner.toLowerCase())
    : undefined;

  return (match ?? installations[0]).id;
}

/**
 * Builds an Octokit client.
 *
 * App mode returns an installation-scoped client whose token refresh is owned
 * by @octokit/auth-app (installation tokens expire hourly — do not cache or
 * renew them by hand). Async because the installation id may have to be
 * resolved over the network first.
 */
export async function createOctokitClient(options: OctokitFactoryOptions): Promise<Octokit> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const mode = resolveAuthMode(options);
  const logger = options.logger;

  if (mode === "token") {
    if (!isPresent(options.token)) {
      throw new Error(
        "No GitHub credentials configured: set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (preferred) or GITHUB_TOKEN.",
      );
    }
    // Never log the token value.
    logger?.warn(
      "GitHub auth mode: token (personal access token). Set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY to use App auth.",
    );
    return new Octokit({ auth: options.token, baseUrl });
  }

  // App auth is attempted, never assumed. This factory runs inside Nest's DI
  // graph, so anything thrown here kills the whole process — Slack, the
  // scheduler and the HTTP API included. A malformed private key must not take
  // the orchestrator down when a usable PAT is sitting right there, so failures
  // degrade to the token path instead of crash-looping the pod.
  try {
    return await createAppClient(options, baseUrl);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!isPresent(options.token)) {
      throw new Error(
        `GitHub App auth failed and no GITHUB_TOKEN is set to fall back to: ${reason}`,
      );
    }
    // Prefer error(), but a logger that only implements warn() must still see this.
    const report = logger?.error?.bind(logger) ?? logger?.warn?.bind(logger);
    report?.(
      `GitHub App auth failed, falling back to the personal access token: ${reason}. ` +
        "Check GITHUB_APP_PRIVATE_KEY is a valid PEM (single-line with literal \\n escapes) " +
        "and that the App is installed on the target org.",
    );
    return new Octokit({ auth: options.token, baseUrl });
  }
}

/**
 * Minimal GraphQL callable surface.
 *
 * Declared structurally rather than re-exporting Octokit's own `graphql` type so
 * that consumers (and their test doubles) do not have to depend on
 * `@octokit/graphql`. `octokit.graphql` satisfies this shape as-is.
 */
export type GithubGraphqlClient = <TResponse>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<TResponse>;

/**
 * Narrows an existing Octokit client down to its GraphQL entry point.
 *
 * Prefer this over {@link createGithubGraphqlClient} when a client has already
 * been built: App-mode construction may perform an installation lookup over the
 * network, and the returned function shares the caller's token refresh (so the
 * hourly installation-token rotation is still owned by @octokit/auth-app).
 */
export function graphqlFromOctokit(octokit: Octokit): GithubGraphqlClient {
  return ((query: string, variables?: Record<string, unknown>) =>
    octokit.graphql(query, variables)) as GithubGraphqlClient;
}

/**
 * Builds a GraphQL client using the same credential resolution as
 * {@link createOctokitClient} — deliberately delegating rather than
 * re-implementing auth, so App installation tokens (and the documented PAT
 * degradation) behave identically on the REST and GraphQL surfaces.
 *
 * GitHub's GraphQL API is the only way to reach Projects v2; there is no REST
 * equivalent.
 */
export async function createGithubGraphqlClient(
  options: OctokitFactoryOptions,
): Promise<GithubGraphqlClient> {
  return graphqlFromOctokit(await createOctokitClient(options));
}

/** The App-auth path, extracted so the caller can degrade on failure. */
async function createAppClient(options: OctokitFactoryOptions, baseUrl?: string): Promise<Octokit> {
  const logger = options.logger;
  const appId = String(options.appId).trim();
  const privateKey = normalizePrivateKey(String(options.privateKey));

  // Fail with something a human can act on. jsonwebtoken's own message for a
  // mangled key is "secretOrPrivateKey must be an asymmetric key when using
  // RS256", which says nothing about which env var is at fault.
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY does not look like a PEM private key after normalisation " +
        "(no -----BEGIN ... PRIVATE KEY----- header found). It may be base64-encoded twice, " +
        "truncated, or storing the key id rather than the key.",
    );
  }

  const pinnedInstallationId = isPresent(options.installationId)
    ? Number(String(options.installationId).trim())
    : undefined;
  if (pinnedInstallationId !== undefined && !Number.isFinite(pinnedInstallationId)) {
    throw new Error("GITHUB_APP_INSTALLATION_ID must be numeric when set.");
  }

  let installationId = pinnedInstallationId;
  let resolvedFrom: "config" | "lookup" = "config";

  if (installationId === undefined) {
    // App-level JWT client — can read App metadata only, not repo content.
    const appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId, privateKey },
      baseUrl,
    });
    installationId = await resolveInstallationId(appOctokit, options.owner, options.repo);
    resolvedFrom = "lookup";
  }

  // Never log the PEM. The App id and installation id are not secrets.
  logger?.log(
    `GitHub auth mode: app (appId=${appId}, installationId=${installationId}, resolved via ${resolvedFrom})`,
  );

  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey, installationId },
    baseUrl,
  });
}
