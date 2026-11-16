/**
 * PR review-status read capability.
 *
 * Answers "what is this PR actually waiting on" — reviews, checks,
 * mergeability — so the escalation ladder can nudge the right person with the
 * right reason instead of "this PR is old". `stale-pr-chase.service.ts`
 * documents the gap this fills: it approximates "unreviewed" as "still open"
 * because no review data exists anywhere in the codebase today.
 *
 * ## What this capability cannot do
 *
 * Merging and closing a pull request are permanent non-goals — a
 * deliberate absence, not an oversight. The GitHub App holds
 * `PullRequests:write`, which is used for **comments only**. That constraint
 * is enforced structurally rather than documented:
 *
 *   - `PullRequestReviewPort` declares exactly one method, and it reads;
 *   - the tool schema takes an owner/repo/number and nothing else, so there is
 *     no action parameter a prompt injection could steer;
 *   - `pr-review-status.spec.ts` asserts both, so adding a merge method later
 *     fails the suite rather than passing review.
 *
 * `GitHubProvider` already exposes `closePullRequest` for the stale-PR sweep,
 * whose auto-close path is itself permanently fenced
 * (`stalePr.autoCloseEnabled` is a `z.literal(false)`). This port deliberately
 * does not re-expose it: a capability that reports on a PR has no business
 * being able to end it.
 */

/** GitHub's review verdicts, as returned by the reviews API. */
export type PullRequestReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

export interface PullRequestReview {
  reviewer: string;
  state: PullRequestReviewState;
  submittedAt: Date;
}

export interface PullRequestCheck {
  name: string;
  status: "queued" | "in_progress" | "completed";
  /** Null while the run is not yet completed. */
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required" | "skipped" | null;
}

export interface PullRequestReviewStatus {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  reviews: readonly PullRequestReview[];
  checks: readonly PullRequestCheck[];
  /** Null while GitHub is still computing mergeability — not a conflict. */
  mergeable: boolean | null;
}

/**
 * The read port this capability needs from GitHub.
 *
 * Declared here rather than added to `GitHubProvider` because this stream does
 * not own `packages/github`. The adapter that implements it against Octokit is
 * a cross-stream request; nothing in this module depends on how it is fetched.
 */
export interface PullRequestReviewPort {
  getReviewStatus(owner: string, repo: string, pullNumber: number): Promise<PullRequestReviewStatus>;
}

/**
 * The port's method names, as data, so a test can assert the surface contains
 * no mutating verb. A type alone cannot be inspected at runtime; this can.
 */
export const PULL_REQUEST_REVIEW_PORT_METHODS = ["getReviewStatus"] as const;

export type PrReviewVerdict =
  | "merged"
  | "closed"
  | "draft"
  | "changes_requested"
  | "conflicted"
  | "checks_failing"
  | "checks_pending"
  | "awaiting_review"
  | "ready_to_merge";

export interface PrReviewSummary {
  verdict: PrReviewVerdict;
  approvals: string[];
  changesRequestedBy: string[];
  failingChecks: string[];
  pendingChecks: string[];
  /** Human-readable reasons this PR cannot land yet. Empty when it can. */
  blockers: string[];
}

/**
 * A reviewer's standing verdict is their most recent *decisive* review.
 * `COMMENTED` and `PENDING` are not verdicts — GitHub does not let a drive-by
 * comment retract an approval, and neither does this.
 */
function decisiveReviewsByReviewer(reviews: readonly PullRequestReview[]): Map<string, PullRequestReview> {
  const latest = new Map<string, PullRequestReview>();

  for (const review of reviews) {
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;

    const current = latest.get(review.reviewer);
    if (!current || review.submittedAt > current.submittedAt) {
      latest.set(review.reviewer, review);
    }
  }

  return latest;
}

function isFailingCheck(check: PullRequestCheck): boolean {
  return (
    check.status === "completed" &&
    (check.conclusion === "failure" || check.conclusion === "timed_out" || check.conclusion === "action_required")
  );
}

function isPendingCheck(check: PullRequestCheck): boolean {
  return check.status !== "completed";
}

/**
 * Reduces raw review/check data to one verdict, deterministically.
 *
 * Precedence runs from "already settled" through "a human has objected" to
 * "machinery is unhappy": terminal state, then draft, then requested changes,
 * then conflicts, then checks. Requested changes outrank a red build because
 * they are the more expensive thing to resolve and the one a nudge should
 * name — fixing the build does not clear the review.
 */
export function summarizePrReviewStatus(status: PullRequestReviewStatus): PrReviewSummary {
  const decisive = decisiveReviewsByReviewer(status.reviews);
  const approvals = [...decisive.values()].filter((r) => r.state === "APPROVED").map((r) => r.reviewer);
  const changesRequestedBy = [...decisive.values()]
    .filter((r) => r.state === "CHANGES_REQUESTED")
    .map((r) => r.reviewer);

  const failingChecks = status.checks.filter(isFailingCheck).map((c) => c.name);
  const pendingChecks = status.checks.filter(isPendingCheck).map((c) => c.name);
  const blockers: string[] = [];

  const summary = (verdict: PrReviewVerdict): PrReviewSummary => ({
    verdict,
    approvals,
    changesRequestedBy,
    failingChecks,
    pendingChecks,
    blockers,
  });

  if (status.state === "merged") return summary("merged");
  if (status.state === "closed") return summary("closed");

  if (status.draft) {
    blockers.push("PR is still a draft.");
    return summary("draft");
  }

  if (changesRequestedBy.length > 0) {
    blockers.push(`Changes requested by ${changesRequestedBy.join(", ")}.`);
    return summary("changes_requested");
  }

  // `false` means GitHub computed a conflict; `null` means it has not finished
  // computing, which is not a blocker.
  if (status.mergeable === false) {
    blockers.push("Branch has conflicts that must be resolved.");
    return summary("conflicted");
  }

  if (failingChecks.length > 0) {
    blockers.push(`Failing checks: ${failingChecks.join(", ")}.`);
    return summary("checks_failing");
  }

  if (approvals.length === 0) {
    blockers.push("No approving review yet.");
    return summary("awaiting_review");
  }

  if (pendingChecks.length > 0) {
    blockers.push(`Checks still running: ${pendingChecks.join(", ")}.`);
    return summary("checks_pending");
  }

  return summary("ready_to_merge");
}

const VERDICT_TEXT: Record<PrReviewVerdict, string> = {
  merged: "merged",
  closed: "closed without merging",
  draft: "still a draft",
  changes_requested: "changes requested",
  conflicted: "blocked by conflicts",
  checks_failing: "blocked by failing checks",
  checks_pending: "waiting on checks",
  awaiting_review: "awaiting review",
  ready_to_merge: "ready to merge",
};

/**
 * One line a human can act on.
 *
 * Phrased as a report, never as an intent: "ready to merge" is a statement
 * about the PR, and the merge itself stays a human decision.
 */
export function describePrReviewStatus(status: PullRequestReviewStatus): string {
  const summary = summarizePrReviewStatus(status);
  const head = `PR #${status.number} — ${VERDICT_TEXT[summary.verdict]}`;

  if (summary.blockers.length === 0) {
    const approvedBy = summary.approvals.length > 0 ? ` Approved by ${summary.approvals.join(", ")}.` : "";
    return `${head}.${approvedBy}`;
  }

  return `${head}. ${summary.blockers.join(" ")}`;
}

/**
 * The agent-facing tool schema. Structurally an `AgentToolDefinition`
 * (`{name, description, input_schema}`) without importing it — that type lives
 * in `apps/orchestrator`, which a package must not depend on. Integration
 * wraps this in a `ToolModule` with no logic of its own.
 */
export const PR_REVIEW_STATUS_TOOL: {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[] };
} = {
  name: "get_pull_request_review_status",
  description:
    "Read-only: reports what a pull request is waiting on — approvals, requested changes, check runs and " +
    "mergeability. Use it to explain why a PR has not landed, or to decide who to nudge. Lexi never merges " +
    "or closes a pull request; that decision is always a human's.",
  input_schema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner, e.g. 'acme'." },
      repo: { type: "string", description: "Repository name, e.g. 'web-app'." },
      pull_number: { type: "number", description: "The pull request number." },
    },
    required: ["owner", "repo", "pull_number"],
  },
};
