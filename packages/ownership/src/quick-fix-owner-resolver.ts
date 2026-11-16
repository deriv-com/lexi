import { QuickFixOwnersConfig } from "./quick-fix-owners-config.schema";

export interface ShipAnnouncementTarget {
  channel: string;
  /** Already formatted Slack mrkdwn (`<@U…>` or `<!subteam^S…>`). */
  teamMention: string;
}

/**
 * Resolves Slack user IDs for a shipped quick-fix PR from
 * `config/quick-fix-owners.yaml`.
 *
 * Two different people can be involved, and they must not be collapsed:
 *
 *   * `resolveMergeReviewer` — platform team lead. Tagged "please review and
 *     merge." Bob on Home web, Dave on Home mobile, Olivia on P2P. Asking a
 *     category PIC to merge is how Grace (KYC developer) was tagged to land a
 *     web-app PR that Bob (web team lead) should have reviewed.
 *   * `resolve` — category PIC for that platform. Mentioned as code owner
 *     only when they are a different person from the merge reviewer.
 *
 * Deliberately never throws — a missing config, unrecognised category, or
 * "other" classification all degrade to `null` (no individual tag), since a
 * wrong or absent owner tag should never block or corrupt the ship-time
 * announcement itself. Callers fall back to the platform team mention
 * when this returns `null`.
 */
export class QuickFixOwnerResolver {
  constructor(private readonly config: QuickFixOwnersConfig) {}

  resolveMergeReviewer(platform: string): string | null {
    return this.config.mergeReviewers[platform] ?? null;
  }

  resolve(category: string | null | undefined, platform: string): string | null {
    if (!category) return null;
    const entry = this.config.categories[category];
    if (!entry) return null;
    const id = (entry as Record<string, string | undefined>)[platform];
    return typeof id === "string" && id.length > 0 ? id : null;
  }

  resolveAnnouncement(platform: string): ShipAnnouncementTarget | null {
    const entry = this.config.announcements?.[platform];
    if (!entry) return null;
    const teamMention =
      entry.mentionKind === "subteam" ? `<!subteam^${entry.mentionId}>` : `<@${entry.mentionId}>`;
    return { channel: entry.channel, teamMention };
  }

  /**
   * Slack mrkdwn mention for the PIC of a Vision-analyse / "Fix this issue"
   * reply in this channel. Unknown or unconfigured channels return null —
   * never invent a person.
   */
  resolveAnalysisMention(channelId: string): string | null {
    const id = this.config.analysisReply?.channels[channelId]?.mentionId;
    return typeof id === "string" && id.length > 0 ? `<@${id}>` : null;
  }

  resolveAnalysisVisionUserId(): string | null {
    const id = this.config.analysisReply?.visionUserId;
    return typeof id === "string" && id.length > 0 ? id : null;
  }

  listCategories(): string[] {
    return Object.keys(this.config.categories);
  }
}
