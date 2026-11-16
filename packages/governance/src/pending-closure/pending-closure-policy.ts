export interface PendingClosureConfig {
  enabled: boolean;
  gracePeriodDays: number;
  minQualifyingAttempts: number;
  pendingLabel: string;
  notObservedLabel: string;
  holdLabels: string[];
  protectedLabels: string[];
  protectedSeverities: string[];
  protectedPriorities: string[];
  minConfidence: number;
  humanActivityWindowDays: number;
}

export interface PendingClosureContext {
  classification: string;
  decisionConfidence: number;
  lifecycleCoverageComplete: boolean;
  incompleteEvidence: boolean;
  qualifyingAttemptCount: number;
  outcomeKind?: string;
  reproduced?: boolean | null;
  labels: string[];
  hasLinkedOpenPr: boolean;
  hasRecentHumanComment: boolean;
  retryRecommended?: boolean;
}

export interface PendingClosureEvaluation {
  shouldMarkPending: boolean;
  shouldCloseImmediately: boolean;
  reason: string;
}

const NOT_OBSERVED_CLASSIFICATIONS = new Set([
  "NOT_OBSERVED_WITH_COMPLETE_COVERAGE",
  "CANNOT_REPRODUCE",
]);

/**
 * Grace-period closure — replaces immediate not-observed auto-close when enabled.
 */
export function evaluatePendingClosure(
  context: PendingClosureContext,
  config: PendingClosureConfig,
): PendingClosureEvaluation {
  if (!config.enabled) {
    return {
      shouldMarkPending: false,
      shouldCloseImmediately: false,
      reason: "Pending closure disabled.",
    };
  }

  if (!NOT_OBSERVED_CLASSIFICATIONS.has(context.classification)) {
    return {
      shouldMarkPending: false,
      shouldCloseImmediately: false,
      reason: "Classification not eligible for pending closure.",
    };
  }

  const labels = context.labels.map((l) => l.toLowerCase());
  for (const protectedLabel of config.protectedLabels) {
    if (labels.includes(protectedLabel.toLowerCase())) {
      return {
        shouldMarkPending: false,
        shouldCloseImmediately: false,
        reason: `Protected label ${protectedLabel} blocks closure.`,
      };
    }
  }

  for (const hold of config.holdLabels) {
    if (labels.includes(hold.toLowerCase())) {
      return {
        shouldMarkPending: false,
        shouldCloseImmediately: false,
        reason: `Hold label ${hold} active.`,
      };
    }
  }

  if (!context.lifecycleCoverageComplete) {
    return {
      shouldMarkPending: false,
      shouldCloseImmediately: false,
      reason: "Incomplete lifecycle — cannot schedule closure.",
    };
  }

  if (context.incompleteEvidence) {
    return {
      shouldMarkPending: false,
      shouldCloseImmediately: false,
      reason: "Incomplete evidence blocks closure scheduling.",
    };
  }

  if (context.qualifyingAttemptCount < config.minQualifyingAttempts) {
    return {
      shouldMarkPending: false,
      shouldCloseImmediately: false,
      reason: `Requires ${config.minQualifyingAttempts} qualifying attempts.`,
    };
  }

  if (context.decisionConfidence < config.minConfidence) {
    return {
      shouldMarkPending: false,
      shouldCloseImmediately: false,
      reason: "Confidence below pending-closure threshold.",
    };
  }

  if (context.retryRecommended) {
    return {
      shouldMarkPending: false,
      shouldCloseImmediately: false,
      reason: "Retry recommended — closure deferred.",
    };
  }

  if (context.hasLinkedOpenPr || context.hasRecentHumanComment) {
    return {
      shouldMarkPending: false,
      shouldCloseImmediately: false,
      reason: "Human activity or open PR blocks closure.",
    };
  }

  if (
    context.outcomeKind === "infra_failure" ||
    context.outcomeKind === "blocked_external" ||
    context.outcomeKind === "blocked_human_verification"
  ) {
    return {
      shouldMarkPending: false,
      shouldCloseImmediately: false,
      reason: `Blocked outcome ${context.outcomeKind}.`,
    };
  }

  if (context.reproduced === null) {
    return {
      shouldMarkPending: false,
      shouldCloseImmediately: false,
      reason: "Inconclusive reproduction blocks closure.",
    };
  }

  return {
    shouldMarkPending: true,
    shouldCloseImmediately: false,
    reason: `Schedule ${config.gracePeriodDays}-day grace period before closure.`,
  };
}

export function shouldCancelPendingClosure(
  signals: {
    humanComment?: boolean;
    holdLabelAdded?: boolean;
    keepOpenLabel?: boolean;
    linkedPr?: boolean;
    newEvidence?: boolean;
    priorityEscalated?: boolean;
    matchingIntakeReport?: boolean;
  },
): boolean {
  return Object.values(signals).some(Boolean);
}
