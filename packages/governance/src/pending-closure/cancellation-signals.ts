import type { GithubCommentDto, GithubTimelineEventDto, LinkedPullRequestDto } from "@lexi/github";
import {
  CANCELLATION_REASON_CODES,
  type CancellationReasonCode,
  type ClosureCancellationRecord,
} from "./cancellation-reason-codes";

const BOT_LOGIN_FRAGMENTS = ["[bot]", "lexi-bot", "github-actions"];

export interface CancellationSignalContext {
  pendingClosureId: string;
  pendingClosureCreatedAt: Date;
  scheduledCloseAt: Date;
  labelsSnapshot: string[];
  assigneesSnapshot: string[];
  currentLabels: string[];
  currentAssignees: string[];
  holdLabels: string[];
  comments: GithubCommentDto[];
  timeline: GithubTimelineEventDto[];
  linkedPullRequests: LinkedPullRequestDto[];
  matchingIntakeAfterScheduling: boolean;
  newEvidenceRecords: { url?: string | null; createdAt: Date }[];
}

export interface CancellationEvaluation {
  shouldCancel: boolean;
  reasonCode?: CancellationReasonCode;
  sourceActor?: string | null;
  sourceUrl?: string | null;
}

function isBotLogin(login: string | null | undefined): boolean {
  if (!login) return true;
  const lower = login.toLowerCase();
  return BOT_LOGIN_FRAGMENTS.some((frag) => lower.includes(frag));
}

function isAfter(date: Date, reference: Date): boolean {
  return date.getTime() > reference.getTime();
}

function extractBestPriority(labels: string[]): number | null {
  let best: number | null = null;
  for (const label of labels) {
    const normalized = label.toLowerCase();
    const match = normalized.match(/^(?:priority:)?(p[0-3])$/);
    if (match) {
      const rank = Number.parseInt(match[1].slice(1), 10);
      if (best === null || rank < best) {
        best = rank;
      }
    }
  }
  return best;
}

function extractBestSeverity(labels: string[]): number | null {
  let best: number | null = null;
  for (const label of labels) {
    const normalized = label.toLowerCase();
    const match = normalized.match(/^(?:severity:)?(s[0-4])$/);
    if (match) {
      const rank = Number.parseInt(match[1].slice(1), 10);
      if (best === null || rank < best) {
        best = rank;
      }
    }
  }
  return best;
}

function hasEvidenceMarker(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("![") ||
    lower.includes("attachment") ||
    lower.includes("screenshot") ||
    lower.includes("video") ||
    lower.includes("http://") ||
    lower.includes("https://")
  );
}

/**
 * Deterministic cancellation evaluation — first matching signal wins.
 */
export function evaluateCancellationSignals(context: CancellationSignalContext): CancellationEvaluation {
  const since = context.pendingClosureCreatedAt;
  const normalized = context.currentLabels.map((l) => l.toLowerCase());

  for (const hold of context.holdLabels) {
    if (
      normalized.includes(hold.toLowerCase()) &&
      !context.labelsSnapshot.map((l) => l.toLowerCase()).includes(hold.toLowerCase())
    ) {
      return {
        shouldCancel: true,
        reasonCode: CANCELLATION_REASON_CODES.HOLD_APPLIED,
        sourceActor: "system",
      };
    }
  }

  if (normalized.includes("keep-open") && !context.labelsSnapshot.map((l) => l.toLowerCase()).includes("keep-open")) {
    return {
      shouldCancel: true,
      reasonCode: CANCELLATION_REASON_CODES.KEEP_OPEN,
      sourceActor: "system",
    };
  }

  for (const comment of context.comments) {
    const createdAt = new Date(comment.createdAt);
    if (isAfter(createdAt, since) && !isBotLogin(comment.authorLogin)) {
      return {
        shouldCancel: true,
        reasonCode: CANCELLATION_REASON_CODES.HUMAN_COMMENT,
        sourceActor: comment.authorLogin,
        sourceUrl: undefined,
      };
    }
  }

  for (const event of context.timeline) {
    const createdAt = new Date(event.createdAt);
    if (!isAfter(createdAt, since)) continue;

    if (event.event === "reaction" && !isBotLogin(event.actorLogin)) {
      return {
        shouldCancel: true,
        reasonCode: CANCELLATION_REASON_CODES.HUMAN_REACTION,
        sourceActor: event.actorLogin,
      };
    }

    if (event.event === "assigned" && !isBotLogin(event.actorLogin)) {
      const assignee = (event.raw.assignee as { login?: string } | undefined)?.login;
      if (assignee && !isBotLogin(assignee)) {
        return {
          shouldCancel: true,
          reasonCode: CANCELLATION_REASON_CODES.HUMAN_COMMENT,
          sourceActor: assignee,
        };
      }
    }
  }

  for (const comment of context.comments) {
    const createdAt = new Date(comment.createdAt);
    if (isAfter(createdAt, since) && hasEvidenceMarker(comment.body)) {
      return {
        shouldCancel: true,
        reasonCode: CANCELLATION_REASON_CODES.NEW_EVIDENCE,
        sourceActor: comment.authorLogin,
      };
    }
  }

  for (const evidence of context.newEvidenceRecords) {
    if (isAfter(evidence.createdAt, since)) {
      return {
        shouldCancel: true,
        reasonCode: CANCELLATION_REASON_CODES.NEW_EVIDENCE,
        sourceActor: "system",
        sourceUrl: evidence.url ?? undefined,
      };
    }
  }

  for (const event of context.timeline) {
    const createdAt = new Date(event.createdAt);
    if (
      isAfter(createdAt, since) &&
      (event.event === "cross-referenced" || event.event === "connected")
    ) {
      return {
        shouldCancel: true,
        reasonCode: CANCELLATION_REASON_CODES.NEW_EVIDENCE,
        sourceActor: event.actorLogin,
      };
    }
  }

  const snapshotPriority = extractBestPriority(context.labelsSnapshot);
  const currentPriority = extractBestPriority(context.currentLabels);
  if (
    snapshotPriority !== null &&
    currentPriority !== null &&
    currentPriority < snapshotPriority
  ) {
    return {
      shouldCancel: true,
      reasonCode: CANCELLATION_REASON_CODES.PRIORITY_ESCALATED,
      sourceActor: "system",
    };
  }

  const snapshotSeverity = extractBestSeverity(context.labelsSnapshot);
  const currentSeverity = extractBestSeverity(context.currentLabels);
  if (
    snapshotSeverity !== null &&
    currentSeverity !== null &&
    currentSeverity < snapshotSeverity
  ) {
    return {
      shouldCancel: true,
      reasonCode: CANCELLATION_REASON_CODES.SEVERITY_ESCALATED,
      sourceActor: "system",
    };
  }

  if (context.matchingIntakeAfterScheduling) {
    return {
      shouldCancel: true,
      reasonCode: CANCELLATION_REASON_CODES.MATCHING_INTAKE,
      sourceActor: "system",
    };
  }

  const openPr = context.linkedPullRequests.find((pr) => pr.state === "open");
  if (openPr) {
    return {
      shouldCancel: true,
      reasonCode: CANCELLATION_REASON_CODES.LINKED_PR_OPENED,
      sourceActor: "system",
      sourceUrl: openPr.url,
    };
  }

  return { shouldCancel: false };
}

export function toClosureCancellationRecord(
  evaluation: CancellationEvaluation,
  pendingClosureId: string,
  scheduledCloseAt: Date,
): ClosureCancellationRecord | null {
  if (!evaluation.shouldCancel || !evaluation.reasonCode) {
    return null;
  }
  return {
    pendingClosureId,
    reasonCode: evaluation.reasonCode,
    detectedAt: new Date(),
    sourceActor: evaluation.sourceActor ?? null,
    sourceUrl: evaluation.sourceUrl ?? null,
    previousScheduledClosureAt: scheduledCloseAt,
  };
}
