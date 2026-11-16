/**
 * Capability Intelligence — aggregates verification capability gaps
 * into actionable intelligence.
 *
 * Answers:
 * - "Which verification capability are we missing most often?"
 * - "Why couldn't this be verified?"
 * - "What issues are blocked by the same capability gap?"
 *
 * Records every UNSUPPORTED verdict as a capability gap, then provides
 * aggregation queries for Lexi to explain patterns and prioritize
 * infrastructure investments.
 */

import type { CapabilityGap } from "./verification-policy";

export interface CapabilityGapSummary {
  capability: string;
  occurrences: number;
  recentExamples: Array<{ issueNumber: number; repository: string; title?: string }>;
  firstSeen: string;
  lastSeen: string;
  affectedTeams: string[];
}

export interface CapabilityIntelligenceReport {
  totalGaps: number;
  uniqueCapabilities: number;
  topGaps: CapabilityGapSummary[];
  recentGaps: CapabilityGap[];
  recommendation: string;
}

export interface CapabilityGapPersistence {
  recordGap(gap: CapabilityGap): Promise<void>;
  getGapsByCapability(capability: string, limit?: number): Promise<CapabilityGap[]>;
  getGapsByIssue(issueNumber: number, repository: string): Promise<CapabilityGap[]>;
  getAllGaps(limit?: number): Promise<CapabilityGap[]>;
  getGapAggregation(): Promise<Array<{ capability: string; count: number; firstSeen: string; lastSeen: string }>>;
}

/**
 * Capability Intelligence Service.
 */
export class CapabilityIntelligenceService {
  constructor(private readonly persistence: CapabilityGapPersistence) {}

  /**
   * Record a capability gap from an UNSUPPORTED verification result.
   */
  async recordGap(gap: CapabilityGap): Promise<void> {
    await this.persistence.recordGap(gap);
  }

  /**
   * Answer: "Why couldn't issue #X be verified?"
   */
  async explainVerificationFailure(
    issueNumber: number,
    repository: string,
  ): Promise<{ gaps: CapabilityGap[]; explanation: string }> {
    const gaps = await this.persistence.getGapsByIssue(issueNumber, repository);

    if (gaps.length === 0) {
      return {
        gaps: [],
        explanation: `Issue #${issueNumber} has no recorded capability gaps. It was either verified successfully or has not been evaluated.`,
      };
    }

    const reasons = gaps.map((g) => g.reason);
    const capabilities = [...new Set(gaps.map((g) => g.requiredCapability))];

    return {
      gaps,
      explanation: `Issue #${issueNumber} could not be verified because: ${reasons.join("; ")}. Required capabilities: ${capabilities.join(", ")}.`,
    };
  }

  /**
   * Answer: "Which verification capability are we missing most often?"
   */
  async getCapabilityReport(limit = 10): Promise<CapabilityIntelligenceReport> {
    const aggregation = await this.persistence.getGapAggregation();
    const recentGaps = await this.persistence.getAllGaps(20);

    const totalGaps = aggregation.reduce((sum, a) => sum + a.count, 0);
    const uniqueCapabilities = aggregation.length;

    const topGaps: CapabilityGapSummary[] = [];
    for (const agg of aggregation.slice(0, limit)) {
      const examples = await this.persistence.getGapsByCapability(agg.capability, 3);
      topGaps.push({
        capability: agg.capability,
        occurrences: agg.count,
        recentExamples: examples.map((g) => ({
          issueNumber: g.issueNumber,
          repository: g.repository,
          title: g.issueTitle,
        })),
        firstSeen: agg.firstSeen,
        lastSeen: agg.lastSeen,
        affectedTeams: [], // Would be enriched from issue labels
      });
    }

    const recommendation = topGaps.length > 0
      ? `Top capability gap: "${topGaps[0].capability}" (${topGaps[0].occurrences} occurrences). Investing in this capability would unblock verification for the most issues.`
      : "No capability gaps recorded. All evaluated issues have available verification paths.";

    return {
      totalGaps,
      uniqueCapabilities,
      topGaps,
      recentGaps,
      recommendation,
    };
  }

  /**
   * Format the capability report for Slack/Lexi display.
   */
  formatReportForDisplay(report: CapabilityIntelligenceReport): string {
    if (report.totalGaps === 0) {
      return "📊 *Capability Intelligence*\n\nNo verification capability gaps recorded. All evaluated issues have available verification paths.";
    }

    const lines: string[] = [
      `📊 *Capability Intelligence*`,
      ``,
      `Total gaps: ${report.totalGaps} across ${report.uniqueCapabilities} capabilities`,
      ``,
      `*Top missing capabilities:*`,
    ];

    for (const gap of report.topGaps.slice(0, 5)) {
      lines.push(`• *${gap.capability}*: ${gap.occurrences} issues (last: ${gap.lastSeen.split("T")[0]})`);
      if (gap.recentExamples.length > 0) {
        lines.push(`  Recent: ${gap.recentExamples.map((e) => `#${e.issueNumber}`).join(", ")}`);
      }
    }

    lines.push(``);
    lines.push(`💡 ${report.recommendation}`);

    return lines.join("\n");
  }
}
