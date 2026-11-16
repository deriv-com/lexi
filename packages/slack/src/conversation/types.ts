/** Slack-side conversation state — conversational UX only; EIO owns workflow truth. */
export type SlackConversationStatus =
  | "RECEIVED"
  | "ACKNOWLEDGED"
  | "PLANNING"
  | "REPRODUCING"
  | "AWAITING_HUMAN_INPUT"
  | "ANALYSING"
  | "POLICY_EVALUATION"
  | "ACTION_EXECUTED"
  | "ACTION_BLOCKED"
  | "COMPLETED";

export type SlackInvestigationVerdict = "REPRODUCED" | "NOT_OBSERVED" | "INCONCLUSIVE" | "BLOCKED";

export type SlackAccountType = "anonymous" | "demo" | "real";

export type SlackBlockedBy = "otp" | "kyc" | "payment" | "credentials" | "environment";

/**
 * Structured contract for manual Slack reproduction replies.
 * Free text is parsed into this shape; missing fields trigger follow-up prompts.
 */
export interface SlackInvestigationResponse {
  issueNumber: number;
  verdict: SlackInvestigationVerdict;
  accountType?: SlackAccountType;
  lifecycleCoverage: {
    requiredStates: string[];
    reachedStates: string[];
    coverageComplete: boolean;
  };
  environment?: {
    browser?: string;
    os?: string;
    url?: string;
    build?: string;
  };
  blockedBy?: SlackBlockedBy;
  evidenceUrls: string[];
  notes?: string;
  responderUserId: string;
  slackThreadTs: string;
}

export interface WorkflowConversationEvent {
  issueId: string;
  githubNumber: number;
  stage: SlackConversationStatus;
  detail?: string;
  classification?: string;
  confidence?: number;
  writeBlocked?: boolean;
  closeRecommended?: boolean;
  writesEnabled?: boolean;
  executionSummary?: string;
}

export interface ReproductionReplyContext {
  issueNumber: number;
  externalId: string;
  channel: string;
  threadTs: string;
  text: string;
  reproUserId: string;
  incompleteEvidence: boolean;
}
