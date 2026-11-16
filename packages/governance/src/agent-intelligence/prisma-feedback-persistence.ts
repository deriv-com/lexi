import type { PrismaClient } from "@lexi/database";
import type { FeedbackCategory, FeedbackPersistence, FeedbackRecord } from "./feedback-learning.service";

/**
 * Upper bound on free-text columns. A correction is a sentence or two; this
 * keeps one pasted log from turning a feedback row into a blob that every
 * later aggregation has to read.
 */
const TEXT_LIMIT = 2000;
/** Short identifying columns: repository slugs, people, labels. */
const NAME_LIMIT = 200;
const LABEL_LIMIT = 80;

/** Rows returned per lookup. Feedback is read to inform a decision, not exported. */
const ISSUE_LOOKUP_LIMIT = 20;
const CATEGORY_LOOKUP_LIMIT = 50;
const RECENT_LOOKUP_LIMIT = 20;

/** The one delegate this persistence uses. `PrismaService` satisfies it. */
export type FeedbackCorrectionPrisma = Pick<PrismaClient, "feedbackCorrection">;

/**
 * `FeedbackPersistence` over the `feedback_corrections` table: human
 * corrections to agent decisions, read back to steer later ones.
 *
 * Values are truncated on the way in rather than validated, because a
 * correction is recorded at the moment someone pushes back and refusing it for
 * being long would lose exactly the signal this table exists to keep.
 */
export class PrismaFeedbackPersistence implements FeedbackPersistence {
  constructor(private readonly prisma: FeedbackCorrectionPrisma) {}

  async recordFeedback(record: FeedbackRecord): Promise<void> {
    await this.prisma.feedbackCorrection.create({
      data: {
        id: record.id,
        issueNumber: record.issueNumber,
        repository: record.repository.slice(0, NAME_LIMIT),
        category: record.category.slice(0, LABEL_LIMIT),
        originalDecision: record.originalDecision.slice(0, TEXT_LIMIT),
        correction: record.correction.slice(0, TEXT_LIMIT),
        correctedBy: record.correctedBy.slice(0, NAME_LIMIT),
        reason: record.reason?.slice(0, TEXT_LIMIT) ?? null,
        decisionId: record.decisionId ?? null,
        team: record.team?.slice(0, LABEL_LIMIT) ?? null,
        component: record.component?.slice(0, LABEL_LIMIT) ?? null,
        createdAt: new Date(record.createdAt),
      },
    });
  }

  async getFeedbackForIssue(issueNumber: number, repository: string): Promise<FeedbackRecord[]> {
    const rows = await this.prisma.feedbackCorrection.findMany({
      where: { issueNumber, repository },
      orderBy: { createdAt: "desc" },
      take: ISSUE_LOOKUP_LIMIT,
    });
    return rows.map(toRecord);
  }

  async getFeedbackByCategory(category: FeedbackCategory, since: Date): Promise<FeedbackRecord[]> {
    const rows = await this.prisma.feedbackCorrection.findMany({
      where: { category, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: CATEGORY_LOOKUP_LIMIT,
    });
    return rows.map(toRecord);
  }

  async getAggregation(since: Date): Promise<Array<{ category: FeedbackCategory; count: number }>> {
    const grouped = await this.prisma.feedbackCorrection.groupBy({
      by: ["category"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });
    return grouped.map((row) => ({
      category: row.category as FeedbackCategory,
      count: row._count._all,
    }));
  }

  async getRecentFeedback(limit: number): Promise<FeedbackRecord[]> {
    const take = Math.min(Math.max(Math.floor(limit), 1), RECENT_LOOKUP_LIMIT);
    const rows = await this.prisma.feedbackCorrection.findMany({
      orderBy: { createdAt: "desc" },
      take,
    });
    return rows.map(toRecord);
  }
}

interface FeedbackCorrectionRow {
  id: string;
  issueNumber: number;
  repository: string;
  category: string;
  originalDecision: string;
  correction: string;
  correctedBy: string;
  reason: string | null;
  decisionId: string | null;
  team: string | null;
  component: string | null;
  createdAt: Date;
}

function toRecord(row: FeedbackCorrectionRow): FeedbackRecord {
  return {
    id: row.id,
    issueNumber: row.issueNumber,
    repository: row.repository,
    category: row.category as FeedbackCategory,
    originalDecision: row.originalDecision,
    correction: row.correction,
    correctedBy: row.correctedBy,
    ...(row.reason !== null ? { reason: row.reason } : {}),
    ...(row.decisionId !== null ? { decisionId: row.decisionId } : {}),
    ...(row.team !== null ? { team: row.team } : {}),
    ...(row.component !== null ? { component: row.component } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}
