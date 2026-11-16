import { WorkflowStatus } from "@lexi/database";
import {
  AuditLogInput,
  CreateDecisionInput,
  CreateNotificationInput,
  CreateReproductionAttemptInput,
  DecisionRecord,
  EvidenceInput,
  EvidenceRecord,
  IssueRecord,
  NotificationRecord,
  ReproductionAttemptRecord,
  UpdateIssueStatusInput,
  UpdateReproductionAttemptInput,
  UpsertIssueInput,
  WorkflowExecutionRecord,
} from "./types";

/**
 * Persistence port used by the workflow orchestrator. Abstracting the
 * database behind this narrow, domain-shaped interface (rather than
 * threading the full PrismaClient surface through orchestration logic)
 * keeps the orchestrator's business rules unit-testable with a simple
 * in-memory fake, while `PrismaWorkflowRepository` provides the real
 * implementation used in production and integration tests.
 */
export interface WorkflowRepository {
  upsertIssue(input: UpsertIssueInput): Promise<IssueRecord>;
  getIssueById(issueId: string): Promise<IssueRecord | null>;
  getIssueByGithubNumber(owner: string, repo: string, number: number): Promise<IssueRecord | null>;
  listIssues(filter?: { status?: WorkflowStatus; state?: "open" | "closed" }): Promise<IssueRecord[]>;
  updateIssue(issueId: string, patch: UpdateIssueStatusInput): Promise<IssueRecord>;
  recordIssueState(issueId: string, status: WorkflowStatus, metadata?: Record<string, unknown>, note?: string): Promise<void>;

  findActiveWorkflowExecution(issueId: string): Promise<WorkflowExecutionRecord | null>;
  /**
   * Reads one execution regardless of status. findActiveWorkflowExecution
   * excludes CLOSED/CANCELLED/FAILED, so it cannot be used to re-read a row
   * that has just been driven to a terminal state — it returns null and the
   * caller is left holding a stale pre-transition copy.
   */
  getWorkflowExecutionById(id: string): Promise<WorkflowExecutionRecord | null>;
  createWorkflowExecution(issueId: string, idempotencyKey: string): Promise<WorkflowExecutionRecord>;
  updateWorkflowExecution(
    id: string,
    patch: Partial<Pick<WorkflowExecutionRecord, "status" | "jobId" | "attempts" | "lastError" | "completedAt">>,
  ): Promise<WorkflowExecutionRecord>;
  listWorkflowExecutions(filter?: { status?: WorkflowStatus }): Promise<WorkflowExecutionRecord[]>;

  createReproductionAttempt(input: CreateReproductionAttemptInput): Promise<ReproductionAttemptRecord>;
  updateReproductionAttempt(id: string, patch: UpdateReproductionAttemptInput): Promise<ReproductionAttemptRecord>;
  getReproductionAttemptByExternalId(externalId: string): Promise<ReproductionAttemptRecord | null>;
  listActiveReproductionAttempts(): Promise<ReproductionAttemptRecord[]>;

  createDecision(input: CreateDecisionInput): Promise<DecisionRecord>;
  getLatestDecisionForIssue(issueId: string): Promise<DecisionRecord | null>;
  getReproductionAttemptById(id: string): Promise<ReproductionAttemptRecord | null>;
  getLatestReproductionAttemptForIssue(issueId: string): Promise<ReproductionAttemptRecord | null>;
  listEvidenceForIssue(issueId: string): Promise<EvidenceRecord[]>;
  createNotification(input: CreateNotificationInput): Promise<NotificationRecord>;
  createAuditLog(input: AuditLogInput): Promise<void>;
  createEvidence(input: EvidenceInput): Promise<void>;
}

export const WORKFLOW_REPOSITORY_TOKEN = Symbol("WORKFLOW_REPOSITORY_TOKEN");
