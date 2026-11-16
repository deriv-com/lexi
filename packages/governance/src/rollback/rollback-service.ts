import type { PrismaService } from "@lexi/database";
import type { GitHubProvider } from "@lexi/github";
import type { PinoLoggerService } from "@lexi/logger";

export interface RollbackResult {
  runId: string;
  reopenedIssues: number[];
  labelsRemoved: string[];
  assignmentsRestored: number;
  pendingClosuresCancelled: number;
  errors: string[];
  alreadyReverted?: boolean;
}

/**
 * Revert bulk mutations from a governance run. Never removes human modifications after the run.
 */
export class RollbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GitHubProvider,
    private readonly logger: PinoLoggerService,
  ) {}

  async revertRun(runId: string, actor: string): Promise<RollbackResult> {
    const existing = await this.prisma.rollbackExecution.findFirst({
      where: { runId },
      orderBy: { createdAt: "desc" },
    });
    if (existing?.result) {
      const prior = existing.result as unknown as RollbackResult;
      return { ...prior, alreadyReverted: true };
    }

    const result: RollbackResult = {
      runId,
      reopenedIssues: [],
      labelsRemoved: [],
      assignmentsRestored: 0,
      pendingClosuresCancelled: 0,
      errors: [],
    };

    const run = await this.prisma.governanceRun.findUnique({ where: { id: runId } });
    if (!run) {
      result.errors.push("Run not found");
      return result;
    }

    const auditEntries = await this.prisma.auditLog.findMany({
      where: {
        details: {
          path: ["runId"],
          equals: runId,
        },
      },
    });

    for (const entry of auditEntries) {
      const details = entry.details as Record<string, unknown> | null;
      if (!details || typeof details !== "object") continue;

      if (entry.action === "close_issue" && details.githubNumber && details.repoOwner && details.repoName) {
        try {
          const issue = await this.github.getIssue(
            String(details.repoOwner),
            String(details.repoName),
            Number(details.githubNumber),
          );
          if (issue.state === "closed") {
            await this.github.reopenIssue(
              String(details.repoOwner),
              String(details.repoName),
              Number(details.githubNumber),
            );
            result.reopenedIssues.push(Number(details.githubNumber));
          }
        } catch (error) {
          result.errors.push(`Failed to reopen #${details.githubNumber}: ${String(error)}`);
        }
      }

      if (entry.action === "add_label" && details.label && details.githubNumber) {
        try {
          const issue = await this.github.getIssue(
            String(details.repoOwner),
            String(details.repoName),
            Number(details.githubNumber),
          );
          if (issue.labels.includes(String(details.label))) {
            await this.github.removeLabels(
              String(details.repoOwner),
              String(details.repoName),
              Number(details.githubNumber),
              [String(details.label)],
            );
            result.labelsRemoved.push(String(details.label));
          }
        } catch (error) {
          result.errors.push(`Failed to remove label ${details.label}: ${String(error)}`);
        }
      }
    }

    const cancelled = await this.prisma.pendingClosure.updateMany({
      where: { runId, status: "pending" },
      data: { status: "cancelled", cancelledAt: new Date(), cancelReason: `Rollback by ${actor}` },
    });
    result.pendingClosuresCancelled = cancelled.count;

    await this.prisma.rollbackExecution.create({
      data: {
        runId,
        actor,
        result: result as object,
      },
    });

    this.logger.log(`Rollback completed for run ${runId} by ${actor}`, "RollbackService");
    return result;
  }
}
