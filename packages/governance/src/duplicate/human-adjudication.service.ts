/**
 * Human adjudication service for medium-confidence duplicate candidates.
 *
 * INVARIANT: Medium-confidence duplicate decisions REQUIRE human adjudication.
 * The system may not auto-close a duplicate when confidence is between the
 * medium and high thresholds.
 *
 * Flow:
 * 1. DuplicateEngine identifies a medium-confidence candidate
 * 2. This service posts a Slack message requesting human review
 * 3. Human responds with confirm/reject/reject-with-reason
 * 4. Reporter can also reject the proposed duplicate
 * 5. Resolution is recorded and further pipeline steps proceed
 */

export type AdjudicationStatus = "pending" | "confirmed" | "rejected" | "expired" | "reporter_rejected";

export interface HumanAdjudicationInput {
  sourceIssueNumber: number;
  sourceRepository: string;
  sourceTitle: string;
  candidateIssueNumber: number;
  candidateRepository: string;
  candidateTitle: string;
  confidence: number;
  reasoning: string;
  reporterSlackId?: string;
}

export interface HumanAdjudicationRecord {
  id: string;
  sourceIssueNumber: number;
  sourceRepository: string;
  candidateIssueNumber: number;
  candidateRepository: string;
  confidence: number;
  reasoning: string;
  status: AdjudicationStatus;
  slackChannel?: string;
  slackMessageTs?: string;
  resolution?: string;
  resolvedBy?: string;
  resolvedAt?: Date;
  reporterRejection: boolean;
  reporterRejectionReason?: string;
}

export interface HumanAdjudicationSlackAdapter {
  postAdjudicationRequest(
    channel: string,
    input: HumanAdjudicationInput,
  ): Promise<{ messageTs: string }>;
  
  notifyReporter(
    reporterSlackId: string,
    input: HumanAdjudicationInput,
  ): Promise<{ messageTs: string }>;
}

export interface HumanAdjudicationPersistence {
  createRequest(record: Omit<HumanAdjudicationRecord, "id">): Promise<string>;
  updateRequest(id: string, update: Partial<HumanAdjudicationRecord>): Promise<void>;
  getRequest(id: string): Promise<HumanAdjudicationRecord | null>;
  getPendingForIssue(issueNumber: number, repository: string): Promise<HumanAdjudicationRecord[]>;
}

export interface HumanAdjudicationConfig {
  /** Slack channel for adjudication requests. */
  adjudicationChannel: string;
  /** How long before an unanswered request expires (ms). Default 72 hours. */
  expirationMs: number;
  /** Whether to notify the reporter directly. */
  notifyReporter: boolean;
}

/**
 * Manages the human adjudication lifecycle for duplicate candidates.
 */
export class HumanAdjudicationService {
  constructor(
    private readonly slack: HumanAdjudicationSlackAdapter,
    private readonly persistence: HumanAdjudicationPersistence,
    private readonly config: HumanAdjudicationConfig,
  ) {}

  /**
   * Request human adjudication for a medium-confidence duplicate candidate.
   */
  async requestAdjudication(input: HumanAdjudicationInput): Promise<string> {
    // Post to adjudication channel
    const { messageTs } = await this.slack.postAdjudicationRequest(
      this.config.adjudicationChannel,
      input,
    );

    const expiresAt = new Date(Date.now() + this.config.expirationMs);

    const id = await this.persistence.createRequest({
      sourceIssueNumber: input.sourceIssueNumber,
      sourceRepository: input.sourceRepository,
      candidateIssueNumber: input.candidateIssueNumber,
      candidateRepository: input.candidateRepository,
      confidence: input.confidence,
      reasoning: input.reasoning,
      status: "pending",
      slackChannel: this.config.adjudicationChannel,
      slackMessageTs: messageTs,
      reporterRejection: false,
    });

    // Optionally notify reporter
    if (this.config.notifyReporter && input.reporterSlackId) {
      await this.slack.notifyReporter(input.reporterSlackId, input);
    }

    return id;
  }

  /**
   * Record a human's confirmation that the candidate is indeed a duplicate.
   */
  async confirmDuplicate(requestId: string, actor: string): Promise<void> {
    await this.persistence.updateRequest(requestId, {
      status: "confirmed",
      resolution: "confirmed_duplicate",
      resolvedBy: actor,
      resolvedAt: new Date(),
    });
  }

  /**
   * Record a human's rejection — the candidate is NOT a duplicate.
   */
  async rejectDuplicate(requestId: string, actor: string, reason?: string): Promise<void> {
    await this.persistence.updateRequest(requestId, {
      status: "rejected",
      resolution: reason ?? "rejected_not_duplicate",
      resolvedBy: actor,
      resolvedAt: new Date(),
    });
  }

  /**
   * Record the original reporter's rejection of the proposed duplicate.
   * Reporters have the ability to reject a proposed duplicate with a reason.
   */
  async reporterReject(requestId: string, reporterId: string, reason: string): Promise<void> {
    await this.persistence.updateRequest(requestId, {
      status: "reporter_rejected",
      resolution: "reporter_rejected",
      resolvedBy: reporterId,
      resolvedAt: new Date(),
      reporterRejection: true,
      reporterRejectionReason: reason,
    });
  }

  /**
   * Expire pending requests that have exceeded their TTL.
   */
  async expireStalePending(): Promise<number> {
    // This would be called by a scheduler
    // Implementation depends on the persistence layer's query capabilities
    return 0;
  }

  /**
   * Check if there's a pending adjudication for this issue pair.
   */
  async hasPendingAdjudication(
    sourceIssueNumber: number,
    sourceRepository: string,
  ): Promise<boolean> {
    const pending = await this.persistence.getPendingForIssue(sourceIssueNumber, sourceRepository);
    return pending.length > 0;
  }
}

/**
 * Format the adjudication request as a Slack Block Kit message.
 */
export function formatAdjudicationSlackMessage(input: HumanAdjudicationInput): {
  text: string;
  blocks: unknown[];
} {
  const confidencePct = (input.confidence * 100).toFixed(0);
  const text = `Possible duplicate: #${input.sourceIssueNumber} ↔ #${input.candidateIssueNumber} (${confidencePct}% confidence)`;

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "🔍 Duplicate Review Required" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*New issue:* #${input.sourceIssueNumber} — ${input.sourceTitle}\n*Candidate:* #${input.candidateIssueNumber} — ${input.candidateTitle}\n*Confidence:* ${confidencePct}%`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Reasoning:*\n${input.reasoning.slice(0, 500)}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Confirm Duplicate" },
          action_id: "adjudication_confirm",
          style: "primary",
          value: JSON.stringify({
            source: input.sourceIssueNumber,
            candidate: input.candidateIssueNumber,
          }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ Not a Duplicate" },
          action_id: "adjudication_reject",
          style: "danger",
          value: JSON.stringify({
            source: input.sourceIssueNumber,
            candidate: input.candidateIssueNumber,
          }),
        },
      ],
    },
  ];

  return { text, blocks };
}
