/**
 * Downloads Slack file bytes from a `url_private` link. Slack's file URLs are
 * not signed/public — retrieving them requires the same bot token used for
 * the Web API, sent as a Bearer auth header rather than as a query param (per
 * Slack's own file-download docs). This is deliberately a plain `fetch` call
 * rather than going through `@slack/web-api`'s `WebClient`, which has no
 * method for arbitrary file URLs.
 */

/**
 * Thrown when a Slack file download fails. `status` is the HTTP status Slack
 * responded with (0 when the fetch itself failed, e.g. network error).
 *
 * Unlike Web API calls (`conversations.replies`, `reactions.add`, ...), a file
 * download failure has no JSON `{ok:false, error:"missing_scope"}` body to
 * inspect — Slack returns a plain 403/401 HTML/text response instead. Scope
 * problems are therefore inferred from the status code (see
 * `isLikelyMissingScopeError`) rather than a machine-readable error code.
 */
export class SlackFileDownloadError extends Error {
  constructor(
    public readonly status: number,
    public readonly fileId: string,
    message: string,
  ) {
    super(message);
    this.name = "SlackFileDownloadError";
  }
}

/**
 * Hosts Slack serves private files from. The bot token is sent to these and
 * nowhere else: a `url_private` comes from an event payload, and a URL that
 * pointed anywhere else would hand the token to whoever runs that host.
 */
const MAX_REDIRECTS = 3;

export const SLACK_FILE_HOSTS: readonly string[] = ["files.slack.com", "files-pri.slack.com", "files-edu.slack.com"];

/** True when `url` is an https URL on one of Slack's file hosts, with no credentials or port. */
export function isSlackFileUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    SLACK_FILE_HOSTS.includes(parsed.hostname.toLowerCase()) &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

/**
 * Downloads a Slack file's bytes.
 *
 * @param urlPrivate Slack file object's `url_private` (or `url_private_download`).
 * @param botToken   The bot's OAuth token (`xoxb-...`); requires `files:read`.
 * @param fileId     Slack file id, carried onto any thrown error for logging context.
 */
export async function downloadSlackFile(
  urlPrivate: string,
  botToken: string,
  fileId = "unknown",
): Promise<Buffer> {
  if (!isSlackFileUrl(urlPrivate)) {
    throw new SlackFileDownloadError(
      0,
      fileId,
      `Refused to download a file from a URL that is not on Slack's file hosts (${SLACK_FILE_HOSTS.join(", ")}); the bot token was not sent.`,
    );
  }
  // Redirects are followed by hand, and only while they stay on Slack's file
  // hosts: an automatic redirect would carry the Authorization header to
  // wherever the Location points.
  let url = urlPrivate;
  let response: Response;
  for (let hop = 0; ; hop += 1) {
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${botToken}` },
        redirect: "manual",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown network error";
      throw new SlackFileDownloadError(0, fileId, `Slack file download request failed: ${message}`);
    }
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers?.get?.("location") ?? "";
    let next = "";
    try {
      next = location ? new URL(location, url).toString() : "";
    } catch {
      next = "";
    }
    if (!next || !isSlackFileUrl(next) || hop >= MAX_REDIRECTS) {
      throw new SlackFileDownloadError(
        response.status,
        fileId,
        `Slack file download was redirected ${next && !isSlackFileUrl(next) ? "off Slack's file hosts" : "without a usable location"} (HTTP ${response.status}); not followed.`,
      );
    }
    url = next;
  }

  if (!response.ok) {
    const bodyPreview = await safeReadText(response);
    throw new SlackFileDownloadError(
      response.status,
      fileId,
      `Slack file download failed (HTTP ${response.status})${bodyPreview ? `: ${bodyPreview.slice(0, 200)}` : ""}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * 401/403 on a file download almost always means the bot token lacks
 * `files:read` (or the file belongs to a workspace/channel the token cannot
 * see). Not a certainty — Slack does not hand back a machine-readable code
 * here the way the Web API does — but a reliable enough signal to name the
 * scope in a log line instead of surfacing a bare HTTP error.
 */
export function isLikelyMissingScopeError(error: unknown): boolean {
  return error instanceof SlackFileDownloadError && (error.status === 401 || error.status === 403);
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
