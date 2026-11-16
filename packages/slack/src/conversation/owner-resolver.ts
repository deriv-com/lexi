import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolves a GitHub username to a Slack member ID by scanning the ownership
 * config comments. The Slack IDs are stored as comments after each owner line
 * in the format: `- github-login  # Name SLACK_ID`
 */
export class SlackOwnerResolver {
  private readonly slackIdMap = new Map<string, string>();

  constructor(configPath: string) {
    try {
      const content = readFileSync(resolve(configPath), "utf8");
      // Parse comment-embedded Slack IDs: `- github-login  # Name UXXXXXXXXXX`
      for (const line of content.split("\n")) {
        const match = line.match(/^\s*-\s+(\S+)\s+#.*?(U[A-Z0-9]{8,})/);
        if (match) {
          this.slackIdMap.set(match[1], match[2]);
        }
      }
    } catch {
      // Config not found — resolve will return undefined
    }
  }

  /** Resolve a GitHub login to a Slack member ID, or undefined if not found. */
  resolve(githubLogin: string): string | undefined {
    return this.slackIdMap.get(githubLogin);
  }

  /** Format a Slack @mention for a GitHub login, or fall back to the login name. */
  mention(githubLogin: string): string {
    const slackId = this.resolve(githubLogin);
    return slackId ? `<@${slackId}>` : githubLogin;
  }
}
