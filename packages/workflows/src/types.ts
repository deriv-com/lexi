import { DecisionClassification, NotificationTemplate, ReproductionStatus, WorkflowStatus } from "@lexi/database";

export interface UpsertIssueInput {
  githubIssueId: number;
  githubNumber: number;
  repoOwner: string;
  repoName: string;
  title: string;
  body: string | null;
  url: string;
  authorLogin: string | null;
  labels: string[];
  state: "open" | "closed";
  githubCreatedAt: Date;
  githubUpdatedAt: Date;
}

export interface IssueRecord {
  id: string;
  githubIssueId: number;
  githubNumber: number;
  repoOwner: string;
  repoName: string;
  title: string;
  body: string | null;
  url: string;
  authorLogin: string | null;
  labels: string[];
  state: string;
  currentStatus: WorkflowStatus;
  assignedOwner: string | null;
  assignedTeam: string | null;
  githubCreatedAt: Date;
  githubUpdatedAt: Date;
  updatedAt: Date;
}

export interface WorkflowExecutionRecord {
  id: string;
  issueId: string;
  status: WorkflowStatus;
  idempotencyKey: string;
  jobId: string | null;
  attempts: number;
  lastError: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface ReproductionAttemptRecord {
  id: string;
  issueId: string;
  workflowExecutionId: string | null;
  providerName: string;
  externalId: string;
  status: ReproductionStatus;
  resultSummary: string | null;
  resultDetails: Record<string, unknown> | null;
  logsUrl: string | null;
  retryCount: number;
  submittedAt: Date;
  completedAt: Date | null;
}

export interface DecisionRecord {
  id: string;
  issueId: string;
  reproductionAttemptId: string | null;
  classification: DecisionClassification;
  component: string;
  team: string;
  owner: string | null;
  confidence: number;
  labels: string[];
  summary: string;
  reasoning: string;
  nextAction: string;
  createdAt: Date;
}

export interface NotificationRecord {
  id: string;
  issueId: string;
  decisionId: string | null;
  template: NotificationTemplate;
  channel: string;
  messageTs: string | null;
  success: boolean;
  error: string | null;
  sentAt: Date;
}

export interface AuditLogInput {
  issueId?: string;
  actor: string;
  action: string;
  details?: Record<string, unknown>;
}

export interface EvidenceInput {
  issueId: string;
  type: string;
  url?: string;
  description?: string;
}

export interface EvidenceRecord {
  id: string;
  issueId: string;
  type: string;
  url: string | null;
  description: string | null;
  createdAt: Date;
}

export interface CreateReproductionAttemptInput {
  issueId: string;
  workflowExecutionId: string | null;
  providerName: string;
  externalId: string;
  status: ReproductionStatus;
}

export interface UpdateReproductionAttemptInput {
  status?: ReproductionStatus;
  resultSummary?: string | null;
  resultDetails?: Record<string, unknown> | null;
  logsUrl?: string | null;
  retryCount?: number;
  completedAt?: Date | null;
}

export interface CreateDecisionInput {
  issueId: string;
  reproductionAttemptId: string | null;
  classification: DecisionClassification;
  component: string;
  team: string;
  owner: string | null;
  confidence: number;
  labels: string[];
  summary: string;
  reasoning: string;
  nextAction: string;
  rawModelOutput?: Record<string, unknown>;
}

export interface CreateNotificationInput {
  issueId: string;
  decisionId: string | null;
  template: NotificationTemplate;
  channel: string;
  messageTs: string | null;
  success: boolean;
  error?: string | null;
}

export interface UpdateIssueStatusInput {
  currentStatus?: WorkflowStatus;
  assignedOwner?: string | null;
  assignedTeam?: string | null;
  labels?: string[];
  state?: "open" | "closed";
}

/**
 * The slice of a governance run context that `cleanupBacklog` needs.
 *
 * Structural, not an import: @lexi/workflows must not depend on @lexi/governance
 * (the dependency runs the other way), and the sweep only needs to ask and
 * consume. `recordOutcome` is optional so a caller with a simpler counter can
 * still supply a ceiling.
 */
export interface BacklogSweepBudget {
  checkBudget(resource: "issuesModified" | "slackMessages"): { allowed: boolean; reason?: string };
  consume(resource: "issuesModified" | "slackMessages", count?: number): unknown;
  recordOutcome?(outcome: {
    issueNumber: number;
    action: string;
    result: string;
    reason: string;
  }): void;
}
