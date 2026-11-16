/**
 * CrossIssueReasoningService — reason over aggregates from the full corpus.
 *
 * Answers portfolio-level questions:
 * - "Which component is regressing?"
 * - "Which duplicate cluster grew fastest this week?"
 * - "Which product is generating the most manual-review debt?"
 * - "Which reproduction capability gap is most expensive?"
 *
 * Returns aggregates and evidence — NOT thousands of rows to the model.
 * The agent can then explain patterns and make recommendations.
 */

export interface ComponentHotspot {
  component: string;
  team: string;
  openCount: number;
  recentCount: number;
  regressionCount: number;
  manualReviewCount: number;
  avgAge: number;
  trend: "increasing" | "stable" | "decreasing";
}

export interface DuplicateClusterGrowth {
  canonicalIssueNumber: number;
  canonicalTitle: string;
  memberCount: number;
  growthThisWeek: number;
  latestMember: { issueNumber: number; addedAt: string };
}

export interface ManualReviewDebt {
  team: string;
  pendingCount: number;
  avgWaitHours: number;
  oldestItem: { issueNumber: number; waitingHours: number };
  topReasons: Array<{ reason: string; count: number }>;
}

export interface PortfolioInsight {
  type: "regression_cluster" | "component_hotspot" | "capability_gap_cost" | "manual_review_debt" | "stale_p1";
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  affectedIssues: number[];
  recommendation: string;
}

export interface CrossIssueReport {
  generatedAt: string;
  corpusSize: number;
  insights: PortfolioInsight[];
  hotspots: ComponentHotspot[];
  manualReviewDebt: ManualReviewDebt[];
}

// ---------------------------------------------------------------------------
// Persistence interface for corpus queries
// ---------------------------------------------------------------------------

export interface CrossIssueQueryPort {
  getComponentHotspots(since: Date): Promise<ComponentHotspot[]>;
  getDuplicateClusterGrowth(since: Date): Promise<DuplicateClusterGrowth[]>;
  getManualReviewDebt(): Promise<ManualReviewDebt[]>;
  getStaleHighPriorityIssues(maxAgeDays: number): Promise<Array<{ issueNumber: number; title: string; priority: string; ageDays: number; team: string }>>;
  getCapabilityGapCost(): Promise<Array<{ capability: string; issueCount: number; totalManualHours: number }>>;
  getCorpusSize(): Promise<number>;
}

/**
 * Cross-issue reasoning service.
 */
export class CrossIssueReasoningService {
  constructor(private readonly queries: CrossIssueQueryPort) {}

  /**
   * Generate a full portfolio report with insights.
   */
  async generateReport(lookbackDays = 14): Promise<CrossIssueReport> {
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
    const corpusSize = await this.queries.getCorpusSize();

    const [hotspots, manualReviewDebt] = await Promise.all([
      this.queries.getComponentHotspots(since),
      this.queries.getManualReviewDebt(),
    ]);

    const insights = await this.generateInsights(hotspots, manualReviewDebt, since);

    return {
      generatedAt: new Date().toISOString(),
      corpusSize,
      insights,
      hotspots,
      manualReviewDebt,
    };
  }

  /**
   * Answer: "Which component is regressing?"
   */
  async identifyRegressions(lookbackDays = 14): Promise<ComponentHotspot[]> {
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
    const hotspots = await this.queries.getComponentHotspots(since);
    return hotspots.filter((h) => h.trend === "increasing" || h.regressionCount > 0);
  }

  /**
   * Answer: "Which capability gap costs the most?"
   */
  async analyzeCapabilityGapCost(): Promise<Array<{ capability: string; issueCount: number; totalManualHours: number; recommendation: string }>> {
    const gaps = await this.queries.getCapabilityGapCost();
    return gaps.map((g) => ({
      ...g,
      recommendation: g.totalManualHours > 40
        ? `Investing in ${g.capability} would save approximately ${g.totalManualHours}h of manual review per month.`
        : `${g.capability}: ${g.issueCount} issues affected but manual effort is manageable.`,
    }));
  }

  // ---------------------------------------------------------------------------
  // Insight generation
  // ---------------------------------------------------------------------------

  private async generateInsights(
    hotspots: ComponentHotspot[],
    debt: ManualReviewDebt[],
    since: Date,
  ): Promise<PortfolioInsight[]> {
    const insights: PortfolioInsight[] = [];

    // Component hotspots
    for (const hotspot of hotspots) {
      if (hotspot.trend === "increasing" && hotspot.recentCount > 5) {
        insights.push({
          type: "component_hotspot",
          severity: "warning",
          title: `${hotspot.component} (${hotspot.team}) has ${hotspot.recentCount} new issues — trending up`,
          detail: `${hotspot.openCount} total open, avg age ${hotspot.avgAge} days. ${hotspot.regressionCount} regressions.`,
          affectedIssues: [],
          recommendation: `Review ${hotspot.component} with ${hotspot.team} — increasing issue rate suggests systemic problem.`,
        });
      }
    }

    // Manual review debt
    for (const team of debt) {
      if (team.avgWaitHours > 48) {
        insights.push({
          type: "manual_review_debt",
          severity: "warning",
          title: `${team.team} has ${team.pendingCount} items waiting avg ${Math.round(team.avgWaitHours)}h for manual review`,
          detail: `Oldest: #${team.oldestItem.issueNumber} waiting ${Math.round(team.oldestItem.waitingHours)}h. Top reasons: ${team.topReasons.map((r) => r.reason).join(", ")}.`,
          affectedIssues: [],
          recommendation: "Redistribute manual review load or invest in automation for top reasons.",
        });
      }
    }

    // Stale P1 issues
    const staleP1 = await this.queries.getStaleHighPriorityIssues(14);
    if (staleP1.length > 0) {
      insights.push({
        type: "stale_p1",
        severity: "critical",
        title: `${staleP1.length} high-priority issues have no activity in 14+ days`,
        detail: staleP1.slice(0, 5).map((i) => `#${i.issueNumber}: ${i.title} (${i.ageDays}d)`).join("; "),
        affectedIssues: staleP1.map((i) => i.issueNumber),
        recommendation: "Investigate ownership and engineering progress for stale P1/P0 issues.",
      });
    }

    return insights.sort((a, b) => {
      const severityOrder = { critical: 0, warning: 1, info: 2 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });
  }

  /**
   * Format the report for Slack display.
   */
  formatReportForDisplay(report: CrossIssueReport): string {
    const lines: string[] = [];
    lines.push(`📊 *Portfolio Intelligence Report*`);
    lines.push(`Corpus: ${report.corpusSize} issues | Generated: ${report.generatedAt.split("T")[0]}`);
    lines.push(``);

    if (report.insights.length === 0) {
      lines.push(`✅ No critical insights. Portfolio is stable.`);
    } else {
      lines.push(`*Insights (${report.insights.length}):*`);
      for (const insight of report.insights.slice(0, 5)) {
        const icon = insight.severity === "critical" ? "🔴" : insight.severity === "warning" ? "🟡" : "🔵";
        lines.push(`${icon} ${insight.title}`);
        lines.push(`   ${insight.detail.slice(0, 150)}`);
        lines.push(`   💡 ${insight.recommendation.slice(0, 150)}`);
        lines.push(``);
      }
    }

    return lines.join("\n");
  }
}
