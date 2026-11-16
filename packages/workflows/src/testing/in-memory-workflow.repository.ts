import { randomUUID } from "crypto";
import { WorkflowStatus } from "@lexi/database";
import { WorkflowRepository } from "../workflow-repository.interface";
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
} from "../types";

/**
 * Simple in-memory implementation of WorkflowRepository used only in unit
 * tests, so WorkflowOrchestrator's business logic can be exercised without
 * a real database.
 */
export class InMemoryWorkflowRepository implements WorkflowRepository {
  readonly issues = new Map<string, IssueRecord>();
  readonly executions = new Map<string, WorkflowExecutionRecord>();
  readonly reproductionAttempts = new Map<string, ReproductionAttemptRecord>();
  readonly decisions = new Map<string, DecisionRecord>();
  readonly notifications = new Map<string, NotificationRecord>();
  readonly auditLogs: AuditLogInput[] = [];
  readonly evidence: EvidenceInput[] = [];
  readonly evidenceRecords: EvidenceRecord[] = [];
  readonly issueStates: Array<{ issueId: string; status: WorkflowStatus }> = [];

  async upsertIssue(input: UpsertIssueInput): Promise<IssueRecord> {
    const existing = Array.from(this.issues.values()).find((issue) => issue.githubIssueId === input.githubIssueId);
    if (existing) {
      const updated: IssueRecord = { ...existing, ...input, updatedAt: new Date() };
      this.issues.set(existing.id, updated);
      return updated;
    }
    const record: IssueRecord = {
      id: randomUUID(),
      ...input,
      currentStatus: WorkflowStatus.NEW,
      assignedOwner: null,
      assignedTeam: null,
      updatedAt: new Date(),
    };
    this.issues.set(record.id, record);
    return record;
  }

  async getIssueById(issueId: string): Promise<IssueRecord | null> {
    return this.issues.get(issueId) ?? null;
  }

  async getIssueByGithubNumber(owner: string, repo: string, number: number): Promise<IssueRecord | null> {
    return (
      Array.from(this.issues.values()).find(
        (issue) => issue.repoOwner === owner && issue.repoName === repo && issue.githubNumber === number,
      ) ?? null
    );
  }

  async listIssues(filter?: { status?: WorkflowStatus; state?: "open" | "closed" }): Promise<IssueRecord[]> {
    return Array.from(this.issues.values()).filter((issue) => {
      if (filter?.status && issue.currentStatus !== filter.status) return false;
      if (filter?.state && issue.state !== filter.state) return false;
      return true;
    });
  }

  async updateIssue(issueId: string, patch: UpdateIssueStatusInput): Promise<IssueRecord> {
    const existing = this.issues.get(issueId);
    if (!existing) {
      throw new Error(`Issue not found: ${issueId}`);
    }
    const updated: IssueRecord = {
      ...existing,
      ...patch,
      currentStatus: patch.currentStatus ?? existing.currentStatus,
      updatedAt: new Date(),
    };
    this.issues.set(issueId, updated);
    return updated;
  }

  async recordIssueState(issueId: string, status: WorkflowStatus): Promise<void> {
    this.issueStates.push({ issueId, status });
  }

  async findActiveWorkflowExecution(issueId: string): Promise<WorkflowExecutionRecord | null> {
    const terminalStatuses: WorkflowStatus[] = [WorkflowStatus.CLOSED, WorkflowStatus.CANCELLED, WorkflowStatus.FAILED];
    return (
      Array.from(this.executions.values())
        .filter((execution) => execution.issueId === issueId && !terminalStatuses.includes(execution.status))
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null
    );
  }

  async getWorkflowExecutionById(id: string): Promise<WorkflowExecutionRecord | null> {
    return this.executions.get(id) ?? null;
  }

  async createWorkflowExecution(issueId: string, idempotencyKey: string): Promise<WorkflowExecutionRecord> {
    const record: WorkflowExecutionRecord = {
      id: randomUUID(),
      issueId,
      status: WorkflowStatus.NEW,
      idempotencyKey,
      jobId: null,
      attempts: 0,
      lastError: null,
      startedAt: new Date(),
      completedAt: null,
    };
    this.executions.set(record.id, record);
    return record;
  }

  async updateWorkflowExecution(
    id: string,
    patch: Partial<Pick<WorkflowExecutionRecord, "status" | "jobId" | "attempts" | "lastError" | "completedAt">>,
  ): Promise<WorkflowExecutionRecord> {
    const existing = this.executions.get(id);
    if (!existing) {
      throw new Error(`Workflow execution not found: ${id}`);
    }
    const updated: WorkflowExecutionRecord = { ...existing, ...patch };
    this.executions.set(id, updated);
    return updated;
  }

  async listWorkflowExecutions(filter?: { status?: WorkflowStatus }): Promise<WorkflowExecutionRecord[]> {
    return Array.from(this.executions.values()).filter((execution) => !filter?.status || execution.status === filter.status);
  }

  async createReproductionAttempt(input: CreateReproductionAttemptInput): Promise<ReproductionAttemptRecord> {
    const record: ReproductionAttemptRecord = {
      id: randomUUID(),
      issueId: input.issueId,
      workflowExecutionId: input.workflowExecutionId,
      providerName: input.providerName,
      externalId: input.externalId,
      status: input.status,
      resultSummary: null,
      resultDetails: null,
      logsUrl: null,
      retryCount: 0,
      submittedAt: new Date(),
      completedAt: null,
    };
    this.reproductionAttempts.set(record.id, record);
    return record;
  }

  async updateReproductionAttempt(id: string, patch: UpdateReproductionAttemptInput): Promise<ReproductionAttemptRecord> {
    const existing = this.reproductionAttempts.get(id);
    if (!existing) {
      throw new Error(`Reproduction attempt not found: ${id}`);
    }
    const updated: ReproductionAttemptRecord = { ...existing, ...patch };
    this.reproductionAttempts.set(id, updated);
    return updated;
  }

  async getReproductionAttemptByExternalId(externalId: string): Promise<ReproductionAttemptRecord | null> {
    return Array.from(this.reproductionAttempts.values()).find((attempt) => attempt.externalId === externalId) ?? null;
  }

  async listActiveReproductionAttempts(): Promise<ReproductionAttemptRecord[]> {
    return Array.from(this.reproductionAttempts.values()).filter(
      (attempt) => attempt.status === "PENDING" || attempt.status === "RUNNING",
    );
  }

  async createDecision(input: CreateDecisionInput): Promise<DecisionRecord> {
    const record: DecisionRecord = {
      id: randomUUID(),
      issueId: input.issueId,
      reproductionAttemptId: input.reproductionAttemptId,
      classification: input.classification,
      component: input.component,
      team: input.team,
      owner: input.owner,
      confidence: input.confidence,
      labels: input.labels,
      summary: input.summary,
      reasoning: input.reasoning,
      nextAction: input.nextAction,
      createdAt: new Date(),
    };
    this.decisions.set(record.id, record);
    return record;
  }

  async getLatestDecisionForIssue(issueId: string): Promise<DecisionRecord | null> {
    const matches = Array.from(this.decisions.values())
      .filter((d) => d.issueId === issueId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return matches[0] ?? null;
  }

  async getReproductionAttemptById(id: string): Promise<ReproductionAttemptRecord | null> {
    return this.reproductionAttempts.get(id) ?? null;
  }

  async getLatestReproductionAttemptForIssue(issueId: string): Promise<ReproductionAttemptRecord | null> {
    const matches = Array.from(this.reproductionAttempts.values())
      .filter((a) => a.issueId === issueId)
      .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());
    return matches[0] ?? null;
  }

  async listEvidenceForIssue(issueId: string): Promise<EvidenceRecord[]> {
    return this.evidenceRecords.filter((e) => e.issueId === issueId);
  }

  async createNotification(input: CreateNotificationInput): Promise<NotificationRecord> {
    const record: NotificationRecord = {
      id: randomUUID(),
      issueId: input.issueId,
      decisionId: input.decisionId,
      template: input.template,
      channel: input.channel,
      messageTs: input.messageTs,
      success: input.success,
      error: input.error ?? null,
      sentAt: new Date(),
    };
    this.notifications.set(record.id, record);
    return record;
  }

  async createAuditLog(input: AuditLogInput): Promise<void> {
    this.auditLogs.push(input);
  }

  async createEvidence(input: EvidenceInput): Promise<void> {
    this.evidence.push(input);
    this.evidenceRecords.push({
      id: randomUUID(),
      issueId: input.issueId,
      type: input.type,
      url: input.url ?? null,
      description: input.description ?? null,
      createdAt: new Date(),
    });
  }
}
