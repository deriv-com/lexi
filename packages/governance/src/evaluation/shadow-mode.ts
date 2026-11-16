/**
 * Shadow Mode — capture Lexi decisions alongside real decisions without executing.
 *
 * Records what Lexi WOULD have done for each issue, then compares against
 * what actually happened (human QA decision). Used to measure disagreement
 * before enabling live writes.
 */

export interface ShadowDecision {
  issueNumber: number;
  repository: string;
  /** What Lexi would have done. */
  lexiDecision: {
    classification: string;
    policyAction: string;
    confidence: number;
    reasoning: string;
  };
  /** What actually happened (human/existing process). */
  realOutcome?: {
    finalState: string;
    closedBy?: string;
    closedAt?: string;
    labels?: string[];
  };
  /** Comparison result (populated after real outcome is known). */
  comparison?: {
    agreed: boolean;
    disagreementCategory?: string;
    detail?: string;
  };
  capturedAt: string;
  comparedAt?: string;
}

export interface ShadowModeConfig {
  enabled: boolean;
  /** Capture every Nth issue (sampling rate). 1 = capture all. */
  sampleRate: number;
  /** How long to retain shadow decisions before comparison (hours). */
  comparisonWindowHours: number;
}

export interface ShadowModePersistence {
  captureShadowDecision(decision: ShadowDecision): Promise<void>;
  getUncomparedDecisions(olderThanHours: number): Promise<ShadowDecision[]>;
  updateComparison(issueNumber: number, repository: string, comparison: ShadowDecision["comparison"]): Promise<void>;
  getDisagreementSummary(since: Date): Promise<{
    total: number;
    agreed: number;
    disagreed: number;
    byCategory: Record<string, number>;
  }>;
}

/**
 * Shadow mode service — captures and compares without executing.
 */
export class ShadowModeService {
  private captureCount = 0;

  constructor(
    private readonly persistence: ShadowModePersistence | null,
    private readonly config: ShadowModeConfig,
  ) {}

  /**
   * Capture what Lexi would have decided (called from the workflow path).
   */
  async capture(
    issueNumber: number,
    repository: string,
    lexiDecision: ShadowDecision["lexiDecision"],
  ): Promise<void> {
    if (!this.config.enabled || !this.persistence) return;

    // Sampling
    this.captureCount++;
    if (this.captureCount % this.config.sampleRate !== 0) return;

    await this.persistence.captureShadowDecision({
      issueNumber,
      repository,
      lexiDecision,
      capturedAt: new Date().toISOString(),
    });
  }

  /**
   * Compare shadow decisions against real outcomes (called periodically).
   */
  async runComparison(): Promise<{ compared: number; agreed: number; disagreed: number }> {
    if (!this.persistence) return { compared: 0, agreed: 0, disagreed: 0 };

    const uncompared = await this.persistence.getUncomparedDecisions(this.config.comparisonWindowHours);
    let agreed = 0;
    let disagreed = 0;

    for (const decision of uncompared) {
      if (!decision.realOutcome) continue;

      const comparison = this.compare(decision);
      await this.persistence.updateComparison(decision.issueNumber, decision.repository, comparison);

      if (comparison.agreed) agreed++;
      else disagreed++;
    }

    return { compared: uncompared.length, agreed, disagreed };
  }

  /**
   * Get disagreement summary for reporting.
   */
  async getDisagreementReport(since: Date): Promise<{
    total: number;
    agreed: number;
    disagreed: number;
    agreementRate: number;
    byCategory: Record<string, number>;
  } | null> {
    if (!this.persistence) return null;
    const summary = await this.persistence.getDisagreementSummary(since);
    return {
      ...summary,
      agreementRate: summary.total > 0 ? summary.agreed / summary.total : 0,
    };
  }

  private compare(decision: ShadowDecision): NonNullable<ShadowDecision["comparison"]> {
    const real = decision.realOutcome!;
    const lexi = decision.lexiDecision;

    // Simple agreement: did Lexi's policy action match what happened?
    const lexiWouldClose = lexi.policyAction === "auto_close" || lexi.policyAction === "pending_closure";
    const realClosed = real.finalState === "closed";

    if (lexiWouldClose === realClosed) {
      return { agreed: true };
    }

    if (lexiWouldClose && !realClosed) {
      return { agreed: false, disagreementCategory: "false_closure", detail: `Lexi would close but issue remains ${real.finalState}` };
    }

    return { agreed: false, disagreementCategory: "missed_closure", detail: `Issue was closed but Lexi would not have closed it (action: ${lexi.policyAction})` };
  }
}
