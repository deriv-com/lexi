/**
 * Spec approval gate — the two-person rule.
 *
 * Approval is the hinge of the spec pipeline: `evaluateQuickFixEligibility`
 * refuses to dispatch a feature without an approved spec at the referenced
 * revision, so whatever passes this gate becomes authority to write code into
 * a product repo. That makes it exactly the wrong place for model judgement,
 * and this module contains none — every threshold is read from
 * config/spec-policy.yaml and every comparison is a string or index test.
 *
 * Deliberately a pure function over explicit input, matching
 * `evaluateMutationGuard` / `evaluateNeverTouch`: it fetches nothing, so a
 * caller cannot be handed a decision made against stale state it did not
 * choose.
 */

import {
  riskTierRank,
  type SpecPolicy,
  type SpecRiskTier,
} from "./spec-policy.schema";

/**
 * Machine-readable reason codes. Callers branch on these; the human-readable
 * sentence lives in `summary`. Kept as an object rather than a union of bare
 * strings so a typo in a call site is a compile error.
 */
export const SPEC_GATE_REASONS = {
  APPROVAL_DISABLED: "approval_disabled",
  HUMAN_APPROVAL_REQUIRED: "human_approval_required",
  SELF_APPROVAL_FORBIDDEN: "self_approval_forbidden",
  APPROVER_UNKNOWN: "approver_unknown",
  REQUESTER_UNKNOWN: "requester_unknown",
  INSUFFICIENT_APPROVALS: "insufficient_approvals",
} as const;

export type SpecGateReason = (typeof SPEC_GATE_REASONS)[keyof typeof SPEC_GATE_REASONS];

/** Actions a human can take on a spec revision. Mirrors SpecApproval.action. */
export type SpecGateAction = "approve" | "request_changes" | "reject" | "supersede";

export interface SpecGateInput {
  action: SpecGateAction;
  specId: string;
  revision: number;
  /** Slack id of whoever is acting now. */
  approverId: string;
  /** Slack id recorded on the spec session as the requester/author. */
  requestedBy: string;
  /** Risk tier of the spec. An unrecognised value is replaced by the config default. */
  riskTier: SpecRiskTier;
  /** True only for a genuine human Slack interaction. Automation passes false. */
  actorIsHuman: boolean;
  /**
   * Approvals already recorded for this spec *revision*. Used only when the
   * policy demands more than one. Approvals on an earlier revision must not be
   * passed in — a revision that changed after approval is not approved.
   */
  priorApprovals?: Array<{ actorSlackId: string }>;
}

export interface SpecGateDecision {
  allowed: boolean;
  /** Every failing reason, not just the first — callers explain all of them at once. */
  reasons: SpecGateReason[];
  /** Rules that participated in the decision, whether or not they blocked. */
  matchedRules: string[];
  /** Distinct human approvals this action required. */
  requiredApprovals: number;
  /** Distinct human approvals counted, including this one when it is valid. */
  satisfiedApprovals: number;
  /** The tier actually used, after the unknown-tier substitution. */
  effectiveRiskTier: SpecRiskTier;
  summary: string;
  policyVersion: string;
}

/**
 * Actions the two-person rule governs.
 *
 * `request_changes` and `reject` are excluded on purpose: both move a spec
 * backwards. Requiring a second person to *decline* your own draft would stall
 * the loop without protecting anything.
 */
const TWO_PERSON_ACTIONS: ReadonlySet<SpecGateAction> = new Set(["approve", "supersede"]);

/** Slack ids arrive from several call sites; normalise before comparing. */
function normalizeActor(id: string | undefined): string {
  return (id ?? "").trim().toLowerCase();
}

/**
 * Evaluate whether a spec approval action may proceed.
 *
 * Fail-closed at every branch: unknown risk tier is promoted to the config
 * default, a missing approver or requester denies (an identity that cannot be
 * compared cannot be shown to differ), and automation is refused outright when
 * `approval.humanOnly` is set.
 */
export function evaluateSpecGate(input: SpecGateInput, policy: SpecPolicy): SpecGateDecision {
  const reasons: SpecGateReason[] = [];
  const matchedRules: string[] = [];

  // Resolve the risk tier first — everything downstream is relative to it.
  const rank = riskTierRank(input.riskTier, policy.approval);
  const effectiveRiskTier: SpecRiskTier =
    rank === -1 ? policy.approval.defaultRiskTier : (input.riskTier as SpecRiskTier);
  if (rank === -1) {
    matchedRules.push("risk_tier_unknown_defaulted");
  }

  // 1. Feature flag. Approval ships off; a spec cannot be approved into
  //    existence before the pipeline is certified.
  if (!policy.writes.approvalEnabled && input.action === "approve") {
    reasons.push(SPEC_GATE_REASONS.APPROVAL_DISABLED);
    matchedRules.push("approval_flag_off");
  }

  // 2. Human-only. Applies to every action here, not just approve: rejecting
  //    or superseding a spec is equally a governance decision.
  if (policy.approval.humanOnly && !input.actorIsHuman) {
    reasons.push(SPEC_GATE_REASONS.HUMAN_APPROVAL_REQUIRED);
    matchedRules.push("human_only");
  }

  const approver = normalizeActor(input.approverId);
  const requester = normalizeActor(input.requestedBy);
  const governedByTwoPerson = TWO_PERSON_ACTIONS.has(input.action);

  // Does the separation-of-duties rule bind this particular action?
  let twoPersonApplies = false;
  if (!governedByTwoPerson) {
    matchedRules.push("two_person_rule_not_applicable");
  } else if (!policy.approval.twoPersonRule.enabled) {
    matchedRules.push("two_person_rule_disabled");
  } else {
    const minRank = riskTierRank(policy.approval.twoPersonRule.minRiskTier, policy.approval);
    const effectiveRank = riskTierRank(effectiveRiskTier, policy.approval);
    twoPersonApplies = effectiveRank >= minRank;
    matchedRules.push(twoPersonApplies ? "two_person_rule_applies" : "two_person_rule_below_tier");

    if (twoPersonApplies) {
      // 3. Identity must be resolvable on both sides. An empty requester is
      //    not "nobody to conflict with" — it is an unverifiable claim.
      if (!approver) {
        reasons.push(SPEC_GATE_REASONS.APPROVER_UNKNOWN);
        matchedRules.push("approver_missing");
      }
      if (!requester) {
        reasons.push(SPEC_GATE_REASONS.REQUESTER_UNKNOWN);
        matchedRules.push("requester_missing");
      }

      // 4. The rule itself.
      if (approver && requester && approver === requester) {
        reasons.push(SPEC_GATE_REASONS.SELF_APPROVAL_FORBIDDEN);
        matchedRules.push("self_approval");
      }
    }
  }

  // 5. Approval count. The requester is discounted ONLY while the two-person
  //    rule binds — below the tier (or with the rule off) self-approval is the
  //    permitted outcome, so discounting the requester there would deny every
  //    low-risk approval for want of a second person the policy never asked
  //    for. Getting this wrong is silent: the refusal reason would name a
  //    missing approval rather than the tier that never required one.
  const requiredApprovals = twoPersonApplies
    ? policy.approval.twoPersonRule.requiredApprovals
    : 1;

  const distinctApprovers = new Set<string>();
  for (const prior of input.priorApprovals ?? []) {
    const id = normalizeActor(prior.actorSlackId);
    if (id && (!twoPersonApplies || id !== requester)) distinctApprovers.add(id);
  }
  if (approver && (!twoPersonApplies || approver !== requester)) distinctApprovers.add(approver);
  const satisfiedApprovals = distinctApprovers.size;

  // Only reported when nothing else already blocked — a self-approval refusal
  // is the precise reason, "not enough approvals" is its restatement.
  if (satisfiedApprovals < requiredApprovals && reasons.length === 0) {
    reasons.push(SPEC_GATE_REASONS.INSUFFICIENT_APPROVALS);
    matchedRules.push("insufficient_approvals");
  }

  const allowed = reasons.length === 0;

  // The refusal names the tier, and says when that tier was *substituted* for
  // a spec that carried none. Without it, "you cannot approve your own spec"
  // gives the reader no way to tell an assessment from a classification gap —
  // and the first response to an unexplained refusal is to argue with it.
  const tierPhrase =
    rank === -1 ? `${effectiveRiskTier} risk — unclassified, governed at the policy default` : `${effectiveRiskTier} risk`;

  return {
    allowed,
    reasons,
    matchedRules,
    requiredApprovals,
    satisfiedApprovals,
    effectiveRiskTier,
    summary: allowed
      ? `Spec ${input.specId} r${input.revision}: "${input.action}" permitted (${tierPhrase}).`
      : `Spec ${input.specId} r${input.revision}: "${input.action}" refused — ${reasons.join(", ")} (${tierPhrase}).`,
    policyVersion: policy.version,
  };
}
