/**
 * What to do when a reproduction run reports the bug is not present.
 *
 * Until now a `cannot_reproduce` verdict posted a comment and stopped, so the
 * issue stayed open forever with a note on it. It should close — but only where
 * closing is cheap to get wrong, which is not the top of the priority range.
 *
 * The rule: close P2 and below, and only when the priority is stated. A P0 or P1
 * is never closed automatically; the QA team is told instead, so a human decides.
 * An issue with no priority label is not closed either — "unlabelled" is an
 * absence of information, and treating it as P2 would make every untriaged
 * report closeable by a single not-reproduced run.
 */

/** Canonical label form. The corpus uses `priority:P0`..`priority:P3`; bare `P0` matches nothing. */
const PRIORITY_LABEL = /^priority:p([0-4])$/i;

export type NotReproducedAction =
  /** Comment and close. */
  | "close"
  /** Comment, and tell the QA team a human must decide. */
  | "escalate_to_qa"
  /** Comment only. */
  | "comment_only";

export interface NotReproducedDecision {
  action: NotReproducedAction;
  /** Parsed priority, or null when the issue carries no priority label. */
  priority: string | null;
  reason: string;
}

/**
 * Reads the priority off an issue's labels.
 *
 * Anchored to the whole label so `priority:P2-candidate` or a title containing
 * "[P0]" cannot be read as a priority. Returns null when absent — the caller
 * must treat that as unknown, not as low.
 */
export function priorityFromLabels(labels: readonly string[]): string | null {
  for (const label of labels) {
    const match = label.trim().match(PRIORITY_LABEL);
    if (match) return `P${match[1]}`;
  }
  return null;
}

/** True for the priorities a human must sign off on. */
export function isHighPriority(priority: string | null): boolean {
  return priority === "P0" || priority === "P1";
}

export function decideNotReproduced(labels: readonly string[]): NotReproducedDecision {
  const priority = priorityFromLabels(labels);

  if (priority === null) {
    return {
      action: "comment_only",
      priority,
      reason:
        "No priority label, so the issue has not been triaged. Not closing on a single not-reproduced run: " +
        "an untriaged report may yet turn out to be a P0.",
    };
  }

  if (isHighPriority(priority)) {
    return {
      action: "escalate_to_qa",
      priority,
      reason: `${priority} is never closed automatically. Asking the QA team to decide.`,
    };
  }

  return {
    action: "close",
    priority,
    reason: `${priority} and the run did not observe the reported behaviour.`,
  };
}

/**
 * Whether a confirmed bug warrants telling the QA team.
 *
 * P0 only. A confirmed P0 gets an automated fix attempt like any other issue —
 * nothing is blocked — but a human is told it is underway, because that is the
 * band where nobody should first learn of it from a pull request.
 */
export function shouldNotifyQaOnConfirmed(labels: readonly string[]): boolean {
  return priorityFromLabels(labels) === "P0";
}
