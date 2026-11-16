import type { PrismaService } from "@lexi/database";
import type { GitHubProvider } from "@lexi/github";
import type { PinoLoggerService } from "@lexi/logger";
import type { GovernanceConfig } from "../config/governance-config.schema";
import {
  evaluateCancellationSignals,
  toClosureCancellationRecord,
} from "./cancellation-signals";

export interface PendingClosureExecutorResult {
  closed: number;
  cancelled: number;
  deferred: number;
  wouldClose: number;
  errors: string[];
}

interface PendingClosureSnapshot {
  labelsSnapshot?: string[];
  assigneesSnapshot?: string[];
}

/**
 * Executes due pending closures and evaluates cancellation signals.
 */
export class PendingClosureExecutor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GitHubProvider,
    private readonly config: GovernanceConfig,
    private readonly logger: PinoLoggerService,
    private readonly writesEnabled: boolean,
    private readonly canonicalOwner: string,
    private readonly canonicalRepo: string,
  ) {}

  async run(): Promise<PendingClosureExecutorResult> {
    const result: PendingClosureExecutorResult = {
      closed: 0,
      cancelled: 0,
      deferred: 0,
      wouldClose: 0,
      errors: [],
    };

    if (!this.config.pendingClosure.enabled) {
      return result;
    }

    const pending = await this.prisma.pendingClosure.findMany({
      where: { status: "pending" },
      orderBy: { scheduledCloseAt: "asc" },
    });

    for (const closure of pending) {
      try {
        const [owner, repo] = this.parseRepository(closure.repository);
        const issue = await this.github.getIssue(owner, repo, closure.githubNumber);
        const snapshot = this.readSnapshot(closure.evidenceSummary);

        const cancellation = await this.evaluateCancellation(closure, issue, snapshot);
        if (cancellation.shouldCancel) {
          await this.recordCancellation(closure, cancellation);
          await this.github.removeLabels(owner, repo, closure.githubNumber, [
            this.config.pendingClosure.pendingLabel,
          ]);
          result.cancelled += 1;
          continue;
        }

        if (closure.scheduledCloseAt > new Date()) {
          result.deferred += 1;
          continue;
        }

        if (!this.writesEnabled) {
          this.logger.warn(
            `Would close #${closure.githubNumber} — GOVERNED_WRITES_ENABLED=false`,
            "PendingClosureExecutor",
          );
          result.wouldClose += 1;
          result.deferred += 1;
          continue;
        }

        await this.github.closeIssue(owner, repo, closure.githubNumber, "not_planned");
        await this.github.addLabels(owner, repo, closure.githubNumber, [
          this.config.pendingClosure.notObservedLabel,
        ]);
        await this.github.removeLabels(owner, repo, closure.githubNumber, [
          this.config.pendingClosure.pendingLabel,
        ]);
        await this.prisma.pendingClosure.update({
          where: { id: closure.id },
          data: { status: "closed" },
        });
        result.closed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`#${closure.githubNumber}: ${message}`);
      }
    }

    return result;
  }

  private readSnapshot(evidenceSummary: unknown): PendingClosureSnapshot {
    if (!evidenceSummary || typeof evidenceSummary !== "object") {
      return {};
    }
    const record = evidenceSummary as PendingClosureSnapshot;
    return {
      labelsSnapshot: Array.isArray(record.labelsSnapshot) ? record.labelsSnapshot : [],
      assigneesSnapshot: Array.isArray(record.assigneesSnapshot) ? record.assigneesSnapshot : [],
    };
  }

  private async evaluateCancellation(
    closure: {
      id: string;
      githubNumber: number;
      createdAt: Date;
      scheduledCloseAt: Date;
      evidenceSummary: unknown;
    },
    issue: {
      labels: string[];
      assignees: string[];
      repoOwner: string;
      repoName: string;
      githubNumber: number;
    },
    snapshot: PendingClosureSnapshot,
  ) {
    const labelsSnapshot = snapshot.labelsSnapshot ?? issue.labels;
    const assigneesSnapshot = snapshot.assigneesSnapshot ?? issue.assignees;

    const comments = await this.github.listComments(
      issue.repoOwner,
      issue.repoName,
      issue.githubNumber,
    );
    const timeline = await this.github.listTimeline(
      issue.repoOwner,
      issue.repoName,
      issue.githubNumber,
    );
    const linkedPullRequests = await this.github.listLinkedPullRequests(
      issue.repoOwner,
      issue.repoName,
      issue.githubNumber,
    );

    const matchingIntake = await this.prisma.intakeDecision.findFirst({
      where: {
        canonicalIssueNumber: closure.githubNumber,
        createdAt: { gt: closure.createdAt },
      },
    });

    const evidenceRecords = closure.evidenceSummary &&
      typeof closure.evidenceSummary === "object" &&
      "issueId" in (closure.evidenceSummary as Record<string, unknown>)
      ? await this.prisma.evidence.findMany({
          where: {
            issueId: String((closure.evidenceSummary as { issueId: string }).issueId),
            createdAt: { gt: closure.createdAt },
          },
        })
      : [];

    return evaluateCancellationSignals({
      pendingClosureId: closure.id,
      pendingClosureCreatedAt: closure.createdAt,
      scheduledCloseAt: closure.scheduledCloseAt,
      labelsSnapshot,
      assigneesSnapshot,
      currentLabels: issue.labels,
      currentAssignees: issue.assignees,
      holdLabels: this.config.pendingClosure.holdLabels,
      comments,
      timeline,
      linkedPullRequests,
      matchingIntakeAfterScheduling: Boolean(matchingIntake),
      newEvidenceRecords: evidenceRecords.map((e) => ({
        url: e.url,
        createdAt: e.createdAt,
      })),
    });
  }

  private async recordCancellation(
    closure: { id: string; scheduledCloseAt: Date },
    evaluation: ReturnType<typeof evaluateCancellationSignals>,
  ): Promise<void> {
    const record = toClosureCancellationRecord(
      evaluation,
      closure.id,
      closure.scheduledCloseAt,
    );
    if (!record) {
      return;
    }

    await this.prisma.pendingClosure.update({
      where: { id: closure.id },
      data: {
        status: "cancelled",
        cancelledAt: record.detectedAt,
        cancelReason: record.reasonCode,
      },
    });

    await this.prisma.closureCancellation.create({
      data: {
        closureId: record.pendingClosureId,
        reasonCode: record.reasonCode,
        reason: record.reasonCode,
        actor: record.sourceActor,
        sourceUrl: record.sourceUrl,
        previousScheduledClosureAt: record.previousScheduledClosureAt,
        createdAt: record.detectedAt,
      },
    });
  }

  private parseRepository(repository: string): [string, string] {
    const [owner, repo] = repository.split("/");
    if (owner && repo) return [owner, repo];
    return [this.canonicalOwner, this.canonicalRepo];
  }
}
