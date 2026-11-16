import { z } from "zod";

export const quickFixCategoryConfigSchema = z.object({
  description: z.string().optional(),
  web: z.string().min(1),
  mobile: z.string().min(1),
});

/**
 * Home web/mobile are required (every existing category PIC and every
 * fallback path names them). Extra keys (`p2p_web`, `p2p_mobile`, …) are
 * allowed so adding a product is a YAML edit, not a schema change.
 */
export const quickFixMergeReviewersSchema = z
  .object({
    web: z.string().min(1),
    mobile: z.string().min(1),
  })
  .catchall(z.string().min(1));

/**
 * Where a shipped fix is announced, and who is tagged the way Home tags the
 * team usergroup. `user` renders `<@id>`; `subteam` renders `<!subteam^id>`.
 */
export const quickFixAnnouncementSchema = z.object({
  channel: z.string().min(1),
  mentionKind: z.enum(["user", "subteam"]),
  mentionId: z.string().min(1),
});

/**
 * Channel PIC tagged when Lexi offers a "Fix this issue" button after a
 * code analysis (Vision, or anyone asking for a read of the code). Optional
 * so existing fixtures that only exercise category PICs still parse.
 */
export const quickFixAnalysisChannelSchema = z.object({
  mentionId: z.string().min(1),
});

export const quickFixAnalysisReplySchema = z.object({
  visionUserId: z.string().min(1).optional(),
  channels: z.record(z.string().min(1), quickFixAnalysisChannelSchema),
});

export const quickFixOwnersConfigSchema = z.object({
  /**
   * Platform team leads tagged to review and merge. Distinct from category
   * PICs: a KYC bug still belongs to Grace, but the merge ask on web is Bob.
   */
  mergeReviewers: quickFixMergeReviewersSchema,
  /**
   * Optional so unit fixtures that only exercise category PICs still parse.
   * Production config always sets this — without it P2P has nowhere to post.
   */
  announcements: z.record(z.string().min(1), quickFixAnnouncementSchema).optional(),
  /**
   * Optional: Vision-analyse replies attach a Fix-this-issue button and tag
   * the PIC named here for that Slack channel. Unknown channels mention nobody.
   */
  analysisReply: quickFixAnalysisReplySchema.optional(),
  categories: z.record(z.string(), quickFixCategoryConfigSchema),
});

export type QuickFixCategoryConfig = z.infer<typeof quickFixCategoryConfigSchema>;
export type QuickFixMergeReviewers = z.infer<typeof quickFixMergeReviewersSchema>;
export type QuickFixAnnouncement = z.infer<typeof quickFixAnnouncementSchema>;
export type QuickFixAnalysisChannel = z.infer<typeof quickFixAnalysisChannelSchema>;
export type QuickFixAnalysisReply = z.infer<typeof quickFixAnalysisReplySchema>;
export type QuickFixOwnersConfig = z.infer<typeof quickFixOwnersConfigSchema>;
