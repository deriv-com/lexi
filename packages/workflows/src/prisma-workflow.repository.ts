import { Prisma, PrismaService, WorkflowStatus } from "@lexi/database";
import { isGithubIssueNumber } from "./github-issue-number";
import { WorkflowRepository } from "./workflow-repository.interface";
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

function toJsonInput(value: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return value as unknown as Prisma.InputJsonValue;
}

function fromJson(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * GitHub's platform-wide issue id is stored as Postgres BIGINT (it exceeds
 * INT4 range) and comes back from Prisma as a JS `bigint`. It's always
 * within Number.MAX_SAFE_INTEGER, so we narrow it back to `number` here --
 * the one place that conversion happens -- rather than letting a raw
 * `bigint` leak into IssueRecord (which would break JSON.stringify).
 */
function mapIssueRow<T extends { githubIssueId: bigint }>(issue: T): T & { githubIssueId: number } {
  return { ...issue, githubIssueId: Number(issue.githubIssueId) };
}

/**
 * Production implementation of WorkflowRepository backed by Prisma /
 * PostgreSQL. Kept as a thin mapping layer: no business logic lives here,
 * only persistence.
 */
export class PrismaWorkflowRepository implements WorkflowRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upsertIssue(input: UpsertIssueInput): Promise<IssueRecord> {
    const issue = await this.prisma.issue.upsert({
      where: { githubIssueId: BigInt(input.githubIssueId) },
      create: {
        githubIssueId: BigInt(input.githubIssueId),
        githubNumber: input.githubNumber,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        title: input.title,
        body: input.body,
        url: input.url,
        authorLogin: input.authorLogin,
        labels: input.labels,
        state: input.state,
        githubCreatedAt: input.githubCreatedAt,
        githubUpdatedAt: input.githubUpdatedAt,
      },
      update: {
        title: input.title,
        body: input.body,
        labels: input.labels,
        state: input.state,
        githubUpdatedAt: input.githubUpdatedAt,
        lastSyncedAt: new Date(),
      },
    });
    return mapIssueRow(issue) as unknown as IssueRecord;
  }

  async getIssueById(issueId: string): Promise<IssueRecord | null> {
    const issue = await this.prisma.issue.findUnique({ where: { id: issueId } });
    return issue ? (mapIssueRow(issue) as unknown as IssueRecord) : null;
  }

  async getIssueByGithubNumber(owner: string, repo: string, number: number): Promise<IssueRecord | null> {
    // Actions run ids overflow INT4. Refuse before Prisma throws ConversionError.
    if (!isGithubIssueNumber(number)) {
      return null;
    }
    const issue = await this.prisma.issue.findFirst({
      where: { repoOwner: owner, repoName: repo, githubNumber: number },
    });
    return issue ? (mapIssueRow(issue) as unknown as IssueRecord) : null;
  }

  async listIssues(filter?: { status?: WorkflowStatus; state?: "open" | "closed" }): Promise<IssueRecord[]> {
    const issues = await this.prisma.issue.findMany({
      where: {
        currentStatus: filter?.status,
        state: filter?.state,
      },
    });
    return issues.map((issue) => mapIssueRow(issue) as unknown as IssueRecord);
  }

  async updateIssue(issueId: string, patch: UpdateIssueStatusInput): Promise<IssueRecord> {
    const issue = await this.prisma.issue.update({
      where: { id: issueId },
      data: {
        currentStatus: patch.currentStatus,
        assignedOwner: patch.assignedOwner,
        assignedTeam: patch.assignedTeam,
        labels: patch.labels,
        state: patch.state,
      },
    });
    return mapIssueRow(issue) as unknown as IssueRecord;
  }

  async recordIssueState(
    issueId: string,
    status: WorkflowStatus,
    metadata?: Record<string, unknown>,
    note?: string,
  ): Promise<void> {
    await this.prisma.issueState.create({
      data: { issueId, status, metadata: toJsonInput(metadata), note },
    });
  }

  async findActiveWorkflowExecution(issueId: string): Promise<WorkflowExecutionRecord | null> {
    const execution = await this.prisma.workflowExecution.findFirst({
      where: {
        issueId,
        status: { notIn: [WorkflowStatus.CLOSED, WorkflowStatus.CANCELLED, WorkflowStatus.FAILED] },
      },
      orderBy: { createdAt: "desc" },
    });
    return (execution as unknown as WorkflowExecutionRecord) ?? null;
  }

  async getWorkflowExecutionById(id: string): Promise<WorkflowExecutionRecord | null> {
    const execution = await this.prisma.workflowExecution.findUnique({ where: { id } });
    return (execution as unknown as WorkflowExecutionRecord) ?? null;
  }

  async createWorkflowExecution(issueId: string, idempotencyKey: string): Promise<WorkflowExecutionRecord> {
    const execution = await this.prisma.workflowExecution.create({
      data: { issueId, idempotencyKey, status: WorkflowStatus.NEW },
    });
    return execution as unknown as WorkflowExecutionRecord;
  }

  async updateWorkflowExecution(
    id: string,
    patch: Partial<Pick<WorkflowExecutionRecord, "status" | "jobId" | "attempts" | "lastError" | "completedAt">>,
  ): Promise<WorkflowExecutionRecord> {
    const execution = await this.prisma.workflowExecution.update({
      where: { id },
      data: {
        status: patch.status,
        jobId: patch.jobId,
        attempts: patch.attempts,
        lastError: patch.lastError,
        completedAt: patch.completedAt,
      },
    });
    return execution as unknown as WorkflowExecutionRecord;
  }

  async listWorkflowExecutions(filter?: { status?: WorkflowStatus }): Promise<WorkflowExecutionRecord[]> {
    const executions = await this.prisma.workflowExecution.findMany({
      where: { status: filter?.status },
      orderBy: { createdAt: "desc" },
    });
    return executions as unknown as WorkflowExecutionRecord[];
  }

  async createReproductionAttempt(input: CreateReproductionAttemptInput): Promise<ReproductionAttemptRecord> {
    const attempt = await this.prisma.reproductionAttempt.create({
      data: {
        issueId: input.issueId,
        workflowExecutionId: input.workflowExecutionId,
        providerName: input.providerName,
        externalId: input.externalId,
        status: input.status,
      },
    });
    return attempt as unknown as ReproductionAttemptRecord;
  }

  async updateReproductionAttempt(id: string, patch: UpdateReproductionAttemptInput): Promise<ReproductionAttemptRecord> {
    const attempt = await this.prisma.reproductionAttempt.update({
      where: { id },
      data: {
        status: patch.status,
        resultSummary: patch.resultSummary,
        resultDetails: toJsonInput(patch.resultDetails ?? undefined),
        logsUrl: patch.logsUrl,
        retryCount: patch.retryCount,
        completedAt: patch.completedAt,
      },
    });
    return {
      ...(attempt as unknown as ReproductionAttemptRecord),
      resultDetails: fromJson(attempt.resultDetails),
    };
  }

  async getReproductionAttemptByExternalId(externalId: string): Promise<ReproductionAttemptRecord | null> {
    const attempt = await this.prisma.reproductionAttempt.findUnique({ where: { externalId } });
    if (!attempt) {
      return null;
    }
    return { ...(attempt as unknown as ReproductionAttemptRecord), resultDetails: fromJson(attempt.resultDetails) };
  }

  async listActiveReproductionAttempts(): Promise<ReproductionAttemptRecord[]> {
    const attempts = await this.prisma.reproductionAttempt.findMany({
      where: { status: { in: ["PENDING", "RUNNING"] } },
    });
    return attempts.map((attempt) => ({
      ...(attempt as unknown as ReproductionAttemptRecord),
      resultDetails: fromJson(attempt.resultDetails),
    }));
  }

  async createDecision(input: CreateDecisionInput): Promise<DecisionRecord> {
    const decision = await this.prisma.decision.create({
      data: {
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
        rawModelOutput: toJsonInput(input.rawModelOutput),
      },
    });
    return decision as unknown as DecisionRecord;
  }

  async getLatestDecisionForIssue(issueId: string): Promise<DecisionRecord | null> {
    const decision = await this.prisma.decision.findFirst({
      where: { issueId },
      orderBy: { createdAt: "desc" },
    });
    return decision ? (decision as unknown as DecisionRecord) : null;
  }

  async getReproductionAttemptById(id: string): Promise<ReproductionAttemptRecord | null> {
    const attempt = await this.prisma.reproductionAttempt.findUnique({ where: { id } });
    if (!attempt) {
      return null;
    }
    return { ...(attempt as unknown as ReproductionAttemptRecord), resultDetails: fromJson(attempt.resultDetails) };
  }

  async getLatestReproductionAttemptForIssue(issueId: string): Promise<ReproductionAttemptRecord | null> {
    const attempt = await this.prisma.reproductionAttempt.findFirst({
      where: { issueId },
      orderBy: { submittedAt: "desc" },
    });
    if (!attempt) {
      return null;
    }
    return { ...(attempt as unknown as ReproductionAttemptRecord), resultDetails: fromJson(attempt.resultDetails) };
  }

  async listEvidenceForIssue(issueId: string): Promise<EvidenceRecord[]> {
    const rows = await this.prisma.evidence.findMany({
      where: { issueId },
      orderBy: { createdAt: "desc" },
    });
    return rows as unknown as EvidenceRecord[];
  }

  async createNotification(input: CreateNotificationInput): Promise<NotificationRecord> {
    const notification = await this.prisma.notification.create({
      data: {
        issueId: input.issueId,
        decisionId: input.decisionId,
        template: input.template,
        channel: input.channel,
        messageTs: input.messageTs,
        success: input.success,
        error: input.error,
      },
    });
    return notification as unknown as NotificationRecord;
  }

  async createAuditLog(input: AuditLogInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        issueId: input.issueId,
        actor: input.actor,
        action: input.action,
        details: toJsonInput(input.details),
      },
    });
  }

  async createEvidence(input: EvidenceInput): Promise<void> {
    await this.prisma.evidence.create({
      data: {
        issueId: input.issueId,
        type: input.type,
        url: input.url,
        description: input.description,
      },
    });
  }
}
