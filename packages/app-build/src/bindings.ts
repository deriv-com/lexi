/**
 * Chat channel → repository bindings for app-build
 * (`APP_BUILD_CHANNEL_REPOS`): which channel each repository's build reports
 * are relayed to (`AppBuildWatcher` targets).
 *
 * Format: `C0TEST01:markets_web,C0TEST02:markets_mobile`. Order matters: the
 * first binding is the primary one. An empty value falls back to a single
 * binding built from the deployment's default channel and repository key, so
 * an unset variable changes nothing.
 *
 * Parsed once at boot and thrown on: a malformed binding is a deploy mistake,
 * not something to half-apply.
 */

export interface AppBuildBinding {
  /** Slack channel id (C…, G… or D…). */
  channel: string;
  /** Repository key from the repository registry. */
  repoKey: string;
}

const CHANNEL_ID = /^[CDG][A-Z0-9]{6,}$/;
const REPO_KEY = /^[a-z][a-z0-9_]*$/;

export function parseAppBuildBindings(
  value: string | undefined | null,
  fallback: { channel?: string | null; repoKey: string },
): AppBuildBinding[] {
  const raw = (value ?? "").trim();
  if (!raw) {
    // One binding even when no channel is configured, so the primary
    // repository still has a target. An empty channel never matches a Slack
    // channel, so nothing is relayed to it (the watcher skips it).
    return [{ channel: (fallback.channel ?? "").trim(), repoKey: fallback.repoKey }];
  }
  const bindings: AppBuildBinding[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(",")) {
    const text = entry.trim();
    if (!text) continue;
    const at = text.indexOf(":");
    if (at <= 0 || at === text.length - 1) {
      throw new Error(`APP_BUILD_CHANNEL_REPOS: "${text}" is not "<channel id>:<repository key>".`);
    }
    const channel = text.slice(0, at).trim();
    const repoKey = text.slice(at + 1).trim();
    if (!CHANNEL_ID.test(channel)) throw new Error(`APP_BUILD_CHANNEL_REPOS: "${channel}" is not a Slack channel id.`);
    if (!REPO_KEY.test(repoKey)) throw new Error(`APP_BUILD_CHANNEL_REPOS: "${repoKey}" is not a repository key.`);
    if (seen.has(channel)) throw new Error(`APP_BUILD_CHANNEL_REPOS: channel ${channel} is bound twice.`);
    seen.add(channel);
    bindings.push({ channel, repoKey });
  }
  if (bindings.length === 0) throw new Error("APP_BUILD_CHANNEL_REPOS is set but holds no binding.");
  return bindings;
}
