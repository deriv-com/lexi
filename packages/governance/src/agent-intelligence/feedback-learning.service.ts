/**
 * FeedbackLearningService — persists human corrections and generates
 * recommendations WITHOUT self-modifying policy.
 *
 * Captures:
 * - Duplicate was wrong (false positive)
 * - Ownership routing was wrong
 * - Priority/severity was wrong
 * - Classification was wrong
 * - Unnecessary reproduction
 * - Missed PR / implementation link
 * - Closure cancelled (premature close)
 *
 * Generates recommendations like:
 * "Ownership for Cashier mobile issues was corrected 17% of the time
 * this month. The current routing rule may need review."
 *
 * INVARIANT: Lexi NEVER self-edits policy or prompts.
 * Feedback generates human-readable recommendations only.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Feedback types
// ---------------------------------------------------------------------------

export type FeedbackCategory =
  | "duplicate_wrong"
  | "ownership_wrong"
  | "priority_wrong"
  | "classification_wrong"
  | "unnecessary_reproduction"
  | "missed_implementation_link"
  | "premature_closure"
  | "missed_regression"
  | "wrong_component"
  | "other";

export interface FeedbackRecord {
  id: string;
  issueNumber: number;
  repository: string;
  category: FeedbackCategory;
  /** What Lexi did / decided. */
  originalDecision: string;
  /** What the human corrected it to. */
  correction: string;
  /** Who provided the correction. */
  correctedBy: string;
  /** Additional context from the human. */
  reason?: string;
  /** Which Lexi decision/action ID this corrects. */
  decisionId?: string;
  /** Timestamp. */
  createdAt: string;
  /** Labels/team for aggregation. */
  team?: string;
  component?: string;
}

export interface FeedbackRecommendation {
  category: FeedbackCategory;
  occurrences: number;
  correctionRate: number;
  period: string;
  recommendation: string;
  examples: Array<{ issueNumber: number; original: string; corrected: string }>;
}

export interface FeedbackReport {
  period: string;
  totalCorrections: number;
  byCategory: Array<{ category: FeedbackCategory; count: number; rate: number }>;
  recommendations: FeedbackRecommendation[];
}

// ---------------------------------------------------------------------------
// Persistence interface
// ---------------------------------------------------------------------------

export interface FeedbackPersistence {
  recordFeedback(record: FeedbackRecord): Promise<void>;
  getFeedbackForIssue(issueNumber: number, repository: string): Promise<FeedbackRecord[]>;
  getFeedbackByCategory(category: FeedbackCategory, since: Date): Promise<FeedbackRecord[]>;
  getAggregation(since: Date): Promise<Array<{ category: FeedbackCategory; count: number }>>;
  getRecentFeedback(limit: number): Promise<FeedbackRecord[]>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FeedbackLearningService {
  constructor(private readonly persistence: FeedbackPersistence) {}

  /**
   * Record a human correction.
   */
  async recordCorrection(input: {
    issueNumber: number;
    repository: string;
    category: FeedbackCategory;
    originalDecision: string;
    correction: string;
    correctedBy: string;
    reason?: string;
    decisionId?: string;
    team?: string;
    component?: string;
  }): Promise<string> {
    const record: FeedbackRecord = {
      id: randomUUID(),
      ...input,
      createdAt: new Date().toISOString(),
    };
    await this.persistence.recordFeedback(record);
    return record.id;
  }

  /**
   * Generate recommendations from accumulated feedback.
   * Does NOT modify any policy — produces human-readable insights only.
   */
  async generateRecommendations(lookbackDays = 30): Promise<FeedbackReport> {
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
    const aggregation = await this.persistence.getAggregation(since);
    const totalCorrections = aggregation.reduce((sum, a) => sum + a.count, 0);

    // Estimate total decisions (corrections / assumed error rate)
    // Conservative: assume we see all corrections
    const recommendations: FeedbackRecommendation[] = [];

    for (const agg of aggregation) {
      if (agg.count >= 3) {
        const examples = await this.persistence.getFeedbackByCategory(agg.category, since);
        recommendations.push({
          category: agg.category,
          occurrences: agg.count,
          correctionRate: agg.count / Math.max(totalCorrections, 1),
          period: `${lookbackDays} days`,
          recommendation: this.buildRecommendation(agg.category, agg.count, lookbackDays),
          examples: examples.slice(0, 3).map((e) => ({
            issueNumber: e.issueNumber,
            original: e.originalDecision,
            corrected: e.correction,
          })),
        });
      }
    }

    return {
      period: `${lookbackDays} days`,
      totalCorrections,
      byCategory: aggregation.map((a) => ({
        category: a.category,
        count: a.count,
        rate: a.count / Math.max(totalCorrections, 1),
      })),
      recommendations: recommendations.sort((a, b) => b.occurrences - a.occurrences),
    };
  }

  /**
   * Answer: "What has been corrected recently for this issue?"
   */
  async getIssueCorrections(issueNumber: number, repository: string): Promise<FeedbackRecord[]> {
    return this.persistence.getFeedbackForIssue(issueNumber, repository);
  }

  /**
   * Lessons for the next similar act: this issue first, then recent
   * corrections elsewhere so a miss on cashier routing is visible the
   * next time cashier comes up.
   */
  async getLessonsForContext(input: {
    issueNumber?: number;
    repository: string;
    limit?: number;
  }): Promise<FeedbackRecord[]> {
    const limit = Math.min(Math.max(input.limit ?? 6, 1), 12);
    const forIssue = input.issueNumber
      ? await this.persistence.getFeedbackForIssue(input.issueNumber, input.repository)
      : [];
    const recent = await this.persistence.getRecentFeedback(limit);
    const seen = new Set<string>();
    const out: FeedbackRecord[] = [];
    for (const row of [...forIssue, ...recent]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
      if (out.length >= limit) break;
    }
    return out;
  }

  private buildRecommendation(category: FeedbackCategory, count: number, days: number): string {
    switch (category) {
      case "ownership_wrong":
        return `Ownership routing was corrected ${count} times in ${days} days. Review the ownership rules in config/ownership.yaml for the affected teams.`;
      case "duplicate_wrong":
        return `${count} duplicate matches were rejected in ${days} days. The duplicate similarity thresholds or adjudication logic may be too aggressive.`;
      case "priority_wrong":
        return `Priority/severity was corrected ${count} times. Review the severity policy or consider whether the label inference is calibrated.`;
      case "classification_wrong":
        return `Classification was wrong ${count} times. The AI decision engine may need prompt tuning or the escalation policy may be mis-calibrated.`;
      case "unnecessary_reproduction":
        return `${count} reproductions were unnecessary. The reproduction-necessity policy may be triggering too eagerly for certain issue classes.`;
      case "premature_closure":
        return `${count} issues were prematurely closed. Auto-close confidence thresholds or lifecycle coverage requirements may need tightening.`;
      case "missed_implementation_link":
        return `${count} implementation links were missed. The cross-repo search may need broader PR/issue reference patterns.`;
      case "missed_regression":
        return `${count} regressions were missed. Release-to-issue correlation may need improvement.`;
      case "wrong_component":
        return `Component assignment was wrong ${count} times. Review component inference from labels and issue content.`;
      default:
        return `${count} corrections in category "${category}" over ${days} days. Review the relevant policy.`;
    }
  }

  /**
   * Format the report for Slack/Lexi display.
   */
  formatReportForDisplay(report: FeedbackReport): string {
    const lines: string[] = [];
    lines.push(`📝 *Feedback & Corrections Report (${report.period})*`);
    lines.push(`Total corrections: ${report.totalCorrections}`);
    lines.push(``);

    if (report.recommendations.length === 0) {
      lines.push(`✅ No significant patterns detected. Lexi's decisions are holding up well.`);
    } else {
      lines.push(`*Recommendations:*`);
      for (const rec of report.recommendations.slice(0, 5)) {
        lines.push(`• *${rec.category}* (${rec.occurrences}x): ${rec.recommendation}`);
      }
    }

    return lines.join("\n");
  }
}
