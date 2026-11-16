import type { SpecStatus } from "@lexi/contracts";
import { specIssueLabels, type SpecLabelPolicy } from "./spec-output";

/**
 * The human approval surface — the Block Kit payload a reviewer
 * clicks, the parser that reads the click back, and the label flip approval
 * causes.
 *
 * Deliberately pure and dependency-free, matching the rest of `@lexi/specs`:
 * this package holds the *decisions*, and the governed chain that acts on them
 * (feature flag -> AuthorizationService -> `evaluateSpecGate`) lives in
 * `spec-approval.service.ts`, where the authorization service and the database
 * are. Keeping the payload here means the approval UX is testable without a
 * Slack client and the package keeps its two dependencies.
 *
 * ## Why the revision travels in the button
 *
 * `approve_spec` is withheld from the model payload entirely, so these buttons
 * are the only route to an approved spec, and an approved spec at a given
 * revision is what licenses a feature dispatch. Between a reviewer reading a
 * message and pressing Approve, the spec can move: a `request_changes` bumps
 * the revision and re-opens drafting. The revision the human actually looked at
 * is therefore carried in the button's own value and re-checked against fresh
 * state at execution time. Without it the service would have nothing to compare
 * against and "approve" would silently mean "approve whatever exists now".
 */

/** Claimed by a single Bolt action route, exactly like `lexi_`. */
export const SPEC_APPROVAL_ACTION_PREFIX = "spec_approval_";

export const SPEC_APPROVAL_ACTIONS = {
  APPROVE: `${SPEC_APPROVAL_ACTION_PREFIX}approve`,
  REQUEST_CHANGES: `${SPEC_APPROVAL_ACTION_PREFIX}request_changes`,
  REQUEST_CHANGES_AFTER_APPROVAL: `${SPEC_APPROVAL_ACTION_PREFIX}request_changes_after_approval`,
  SUPERSEDE: `${SPEC_APPROVAL_ACTION_PREFIX}supersede`,
  DISCARD_AND_RESTART: `${SPEC_APPROVAL_ACTION_PREFIX}discard_and_restart`,
} as const;

/** What a human may decide from the message. Mirrors `SpecApproval.action`. */
export type SpecApprovalDecision = "approve" | "request_changes" | "request_changes_after_approval" | "supersede" | "discard_and_restart";

export interface SpecApprovalClick {
  decision: SpecApprovalDecision;
  specId: string;
  /** The revision rendered in the message the human actually clicked. */
  revision: number;
}

export interface SpecApprovalBlockArgs {
  specId: string;
  revision: number;
  title: string;
  /** Rendered when known; absent means the gate applies its stricter default. */
  riskTier?: string;
  /**
   * The tier the gate substitutes for an unclassified spec
   * (`approval.defaultRiskTier`). Named on the card so "unclassified" is a
   * statement about strictness rather than an absence the reader has to
   * interpret.
   */
  defaultRiskTier?: string;
  /**
   * Whether the two-person rule binds this spec. Supplied by the caller, which
   * holds the governance policy — this package must not re-derive it, or there
   * would be a second implementation of the rule to keep in step with
   * `evaluateSpecGate`.
   */
  twoPersonRuleApplies?: boolean;
  /** Optional link to the spec issue, when GitHub writes are enabled. */
  issueUrl?: string;
}

/**
 * The review message.
 *
 * The revision is rendered in the text as well as encoded in the value: a
 * reviewer refused for approving a superseded revision should be able to see,
 * from the message they clicked, why the refusal was right.
 */
export function specApprovalBlocks(args: SpecApprovalBlockArgs): Array<Record<string, unknown>> {
  const lines = [`*Spec ready for review:* ${args.title}`, `● Awaiting a decision on revision ${args.revision}`];

  // The tier is always stated, including when there isn't one. Silence reads as
  // "no risk", and the unclassified case is precisely where the gate is
  // STRICTEST — so it is the case that most needs saying out loud. A reviewer
  // refused for self-approving what they thought was a trivial spec should be
  // able to see, from the message they clicked, why the refusal was right.
  lines.push(`● Risk tier: ${riskTierLine(args)}`);

  if (args.twoPersonRuleApplies === true) {
    lines.push("● A second person is required: the approver must not be the requester.");
  } else if (args.twoPersonRuleApplies === false) {
    lines.push("● Below the two-person threshold — self-approval is allowed for this spec.");
  }

  if (args.issueUrl) lines.push(`● ${args.issueUrl}`);

  // One value for both buttons: the decision is carried by the action id, so
  // the payload only ever has to say *what* is being decided on.
  const value = JSON.stringify({ specId: args.specId, revision: args.revision });

  return [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    {
      type: "actions",
      block_id: `spec_approval_${args.specId}`,
      elements: [
        approvalButton("Approve", SPEC_APPROVAL_ACTIONS.APPROVE, value, "primary"),
        approvalButton("Request changes", SPEC_APPROVAL_ACTIONS.REQUEST_CHANGES, value),
        // These remain unavailable until the spec is APPROVED. Showing the
        // controls on the review card gives the human a durable, auditable way
        // to correct a decision made after approval; the service re-reads the
        // status and refuses an early or stale click.
        approvalButton("Supersede", SPEC_APPROVAL_ACTIONS.SUPERSEDE, value),
        approvalButton("Revise after approval", SPEC_APPROVAL_ACTIONS.REQUEST_CHANGES_AFTER_APPROVAL, value),
        approvalButton("Discard & restart", SPEC_APPROVAL_ACTIONS.DISCARD_AND_RESTART, value, "danger"),
      ],
    },
  ];
}

/**
 * "critical", or "unclassified — governed as high".
 *
 * The second form is the load-bearing one: an unclassified spec is not a
 * low-risk spec, and the card has to say which tier the gate will actually
 * apply so the reviewer can tell an assessment from a gap.
 */
function riskTierLine(args: SpecApprovalBlockArgs): string {
  if (args.riskTier) return args.riskTier;
  return args.defaultRiskTier
    ? `unclassified — governed as ${args.defaultRiskTier}`
    : "unclassified — governed at the policy default";
}

function approvalButton(
  label: string,
  actionId: string,
  value: string,
  style?: "primary" | "danger",
): Record<string, unknown> {
  return {
    type: "button",
    text: { type: "plain_text", text: label },
    action_id: actionId,
    value,
    ...(style ? { style } : {}),
  };
}

/**
 * Reads a click back into a decision, or returns null.
 *
 * Fail-closed by construction: every rejected shape returns null rather than a
 * partially-populated click, because a click missing its revision would
 * otherwise reach the service as an approval with nothing to compare against.
 */
export function parseSpecApprovalAction(actionId: string, rawValue: string | undefined): SpecApprovalClick | null {
  const decision = decisionFor(actionId);
  if (!decision) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue ?? "");
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const { specId, revision } = parsed as { specId?: unknown; revision?: unknown };

  if (typeof specId !== "string" || specId.trim().length === 0) return null;
  // Integer and positive: a revision is an index into a spec's history, and a
  // string "2" arriving here would compare unequal to a numeric 2 and refuse a
  // legitimate approval — or, coerced, approve against an unverified value.
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) return null;

  return { decision, specId: specId.trim(), revision };
}

function decisionFor(actionId: string): SpecApprovalDecision | null {
  if (actionId === SPEC_APPROVAL_ACTIONS.APPROVE) return "approve";
  if (actionId === SPEC_APPROVAL_ACTIONS.REQUEST_CHANGES) return "request_changes";
  if (actionId === SPEC_APPROVAL_ACTIONS.REQUEST_CHANGES_AFTER_APPROVAL) return "request_changes_after_approval";
  if (actionId === SPEC_APPROVAL_ACTIONS.SUPERSEDE) return "supersede";
  if (actionId === SPEC_APPROVAL_ACTIONS.DISCARD_AND_RESTART) return "discard_and_restart";
  return null;
}

export interface SpecLabelTransition {
  /** The full label set the issue should carry afterwards. */
  labels: string[];
  added: string[];
  removed: string[];
}

/**
 * The `spec:draft` -> `spec:approved` flip (and back again on changes).
 *
 * Computes a diff rather than overwriting, because a spec issue also carries
 * labels this pipeline does not own — team, platform, whatever a human added.
 * Replacing the label set wholesale would quietly strip them, and the loss
 * would only be noticed by whoever filters the board by team.
 *
 * Idempotent: re-applying the same status reports no change, so a retried
 * write is safe.
 */
export function specLabelTransition(
  current: string[],
  status: SpecStatus,
  policy: SpecLabelPolicy,
): SpecLabelTransition {
  const target = specIssueLabels(status, policy);
  const stageLabels = [policy.output.labels.draft, policy.output.labels.approved];

  // Every stage label that is not the one this status implies comes off; any
  // other label the issue carries is left exactly where it is.
  const keep = current.filter((label) => !stageLabels.includes(label) || target.includes(label));
  const missing = target.filter((label) => !keep.includes(label));

  return {
    labels: [...keep, ...missing],
    added: missing,
    removed: current.filter((label) => stageLabels.includes(label) && !target.includes(label)),
  };
}
