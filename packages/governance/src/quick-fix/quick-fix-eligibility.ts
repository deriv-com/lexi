import { findProtectedPaths } from "../blast-radius/protected-paths";
import type { FeaturePolicy } from "../spec/feature-policy.schema";

export interface QuickFixPolicyConfig {
  maxPriority: string;
  maxSeverity: string;
  maxFilesChanged: number;
  maxLinesChanged: number;
  forbiddenLabels: string[];
  forbiddenComponents: string[];
  forbiddenPathPatterns: string[];
  maxOpenPrsPerReviewer: number;
  maxOpenPrsPerIssue: number;
  staleReminderDays: number;
  staleCloseDays: number;
  autofixLabel: string;
}

/**
 * What kind of work is being dispatched. Exists so the `reproduced` gate below
 * applies only where it is meaningful.
 *
 * A chore ("remove this yaml file") and a feature request have nothing to
 * reproduce, so requiring reproduction of them leaves a caller two bad options:
 * be refused for a reason that cannot ever be satisfied, or claim
 * `reproduced: true` for something never reproduced. The second is the real
 * hazard — `reproduced` is the one signal this gate genuinely trusts, and using
 * it as a formality to get past a checklist destroys the ability to tell a
 * verified bug fix from an unverified chore afterwards.
 *
 * Defaults to "bug" when unset, so every existing caller keeps today's
 * behaviour without change.
 */
export type QuickFixTaskType = "bug" | "chore" | "feature";

/**
 * The spec a feature dispatch claims to implement, and the revision of it.
 * The revision is not decoration — approval is granted per revision, so a
 * reference without one cannot be checked against anything.
 */
export interface QuickFixSpecReference {
  specId: string;
  revision: number;
}

/**
 * Resolved facts about that spec, supplied by the caller.
 *
 * This gate performs no lookup on purpose, matching `evaluateNeverTouch` and
 * `evaluateMutationGuard`: a pure function cannot be handed a decision made
 * against state the caller did not choose, and a policy that fetches is a
 * policy that can fail open when the fetch fails. Here a failed lookup is
 * represented by *omitting* this field, which routes to human review.
 */
export interface QuickFixSpecEvidence {
  specId: string;
  /** Revision carrying the approval, or null when nothing is approved. */
  approvedRevision: number | null;
  /** SpecDocument.status — only "APPROVED" satisfies the gate. */
  status: string;
  /** Set when a newer spec has replaced this one. */
  supersededById?: string | null;
}

/**
 * What the gate concluded.
 *
 * `human_review` is distinct from `ineligible` and the distinction matters:
 * ineligible is a decision ("this may not dispatch"), human_review is the
 * absence of one ("this build cannot tell"). Collapsing them would either
 * bury genuine refusals or, far worse, tempt a caller into treating
 * "no rule matched" as permission.
 */
export type QuickFixOutcome = "eligible" | "ineligible" | "human_review";

/** Machine-readable reason codes. `reasons` stays the human-readable list. */
export const QUICK_FIX_REASON_CODES = {
  NO_POLICY_MATCH: "NO_POLICY_MATCH",
  SPEC_REFERENCE_MISSING: "SPEC_REFERENCE_MISSING",
  SPEC_EVIDENCE_MISSING: "SPEC_EVIDENCE_MISSING",
  SPEC_EVIDENCE_MISMATCH: "SPEC_EVIDENCE_MISMATCH",
  SPEC_NOT_APPROVED: "SPEC_NOT_APPROVED",
  SPEC_REVISION_MISMATCH: "SPEC_REVISION_MISMATCH",
  SPEC_SUPERSEDED: "SPEC_SUPERSEDED",
} as const;

export type QuickFixReasonCode =
  (typeof QUICK_FIX_REASON_CODES)[keyof typeof QUICK_FIX_REASON_CODES];

export interface QuickFixContext {
  priorityLabel?: string;
  severityLabel?: string;
  /** Defaults to "bug" when omitted. */
  taskType?: QuickFixTaskType;
  /** Required for taskType "feature" — see evaluateFeatureSpecGate below. */
  specReference?: QuickFixSpecReference;
  /** Resolved state of `specReference`. Absent = could not be resolved. */
  specEvidence?: QuickFixSpecEvidence;
  /**
   * Only consulted when `taskType` is "bug" (or omitted). For chore/feature the
   * caller is expected to have supplied a concrete target and acceptance
   * criterion instead — enforced at the tool layer, since those are inputs this
   * policy gate never sees.
   */
  reproduced: boolean;
  /**
   * A person in the requesting conversation explicitly classified this as a
   * bug and asked to dispatch despite missing reproduction evidence.
   *
   * Does not make `reproduced` true — that field is a factual claim, and a
   * false one is how a verified fix becomes indistinguishable from an
   * unverified one. This flag is the override: strict `=== true` only, so a
   * missing or truthy-looking value cannot walk through the gate.
   */
  humanConfirmed?: boolean;
  rootCausePaths: string[];
  estimatedFilesChanged: number;
  estimatedLinesChanged: number;
  canAddRegressionTest: boolean;
  labels: string[];
  component?: string;
  openAutofixPrCount: number;
}

export interface QuickFixEligibilityResult {
  eligible: boolean;
  reasons: string[];
  /**
   * Added with the spec gate. `eligible` is retained unchanged so existing callers
   * keep working; `outcome` is what distinguishes a refusal from an
   * unevaluable request. `eligible === true` if and only if
   * `outcome === "eligible"`.
   */
  outcome: QuickFixOutcome;
  reasonCodes: QuickFixReasonCode[];
}

/** Statuses recognised as approved. Anything else is not. */
const APPROVED_STATUS = "APPROVED";

interface SpecGateOutcome {
  reasons: string[];
  codes: QuickFixReasonCode[];
  /** True when the gate could not reach a verdict and a human must look. */
  needsHumanReview: boolean;
}

/**
 * The feature spec gate: a feature dispatch requires an approved spec
 * **at the referenced revision**.
 *
 * "At the referenced revision" carries the weight. A spec approved at r2 and
 * since revised to r3 is not an approved r3 — treating it as one would make
 * approval a one-time formality that any later edit walks straight through,
 * which is precisely the loophole an approval gate exists to close. The check
 * is therefore equality, not "approved at some point": referencing an older
 * revision fails too, because dispatching against a stale document builds
 * something nobody approved in its current form either.
 */
function evaluateFeatureSpecGate(context: QuickFixContext): SpecGateOutcome {
  const reasons: string[] = [];
  const codes: QuickFixReasonCode[] = [];

  const reference = context.specReference;
  if (!reference || !reference.specId) {
    reasons.push(
      "Feature dispatch requires an approved spec reference. Draft and get a spec approved first, then reference it (specId + revision).",
    );
    codes.push(QUICK_FIX_REASON_CODES.SPEC_REFERENCE_MISSING);
    return { reasons, codes, needsHumanReview: false };
  }

  const evidence = context.specEvidence;
  if (!evidence) {
    // A reference nobody resolved is an unverifiable claim. Not a pass, and
    // not a definite refusal either — the spec may well be approved and the
    // lookup simply failed, which is a human's problem to resolve.
    reasons.push(
      `Spec ${reference.specId} could not be resolved, so its approval state is unknown. Routed to human review.`,
    );
    codes.push(QUICK_FIX_REASON_CODES.SPEC_EVIDENCE_MISSING);
    return { reasons, codes, needsHumanReview: true };
  }

  if (evidence.specId !== reference.specId) {
    reasons.push(
      `Spec evidence is for ${evidence.specId} but the task references ${reference.specId}. Routed to human review.`,
    );
    codes.push(QUICK_FIX_REASON_CODES.SPEC_EVIDENCE_MISMATCH);
    return { reasons, codes, needsHumanReview: true };
  }

  if (evidence.supersededById) {
    reasons.push(
      `Spec ${reference.specId} has been superseded by ${evidence.supersededById}. Reference the current spec instead.`,
    );
    codes.push(QUICK_FIX_REASON_CODES.SPEC_SUPERSEDED);
  }

  if (evidence.status !== APPROVED_STATUS || evidence.approvedRevision === null) {
    reasons.push(
      `Spec ${reference.specId} is not approved (status ${evidence.status}). A feature cannot dispatch against an unapproved spec.`,
    );
    codes.push(QUICK_FIX_REASON_CODES.SPEC_NOT_APPROVED);
    return { reasons, codes, needsHumanReview: false };
  }

  if (evidence.approvedRevision !== reference.revision) {
    reasons.push(
      `Spec ${reference.specId} is approved at revision ${evidence.approvedRevision} but the task references revision ${reference.revision}. Approval does not carry across revisions.`,
    );
    codes.push(QUICK_FIX_REASON_CODES.SPEC_REVISION_MISMATCH);
  }

  return { reasons, codes, needsHumanReview: false };
}

function parseLevel(label: string | undefined, prefix: string): number {
  if (!label) return 99;
  const match = label.match(new RegExp(`${prefix}([0-4])`, "i"));
  return match ? Number(match[1]) : 99;
}

/** Task types this build knows how to govern. */
const KNOWN_TASK_TYPES: ReadonlySet<string> = new Set<QuickFixTaskType>(["bug", "chore", "feature"]);

/**
 * Quick-fix PR eligibility — generation is separate; this gate must pass first.
 *
 * `featurePolicy` is optional and defaults to the *strict* reading: with no
 * policy supplied, a feature still requires an approved spec. A caller that
 * forgets to wire the policy gets the safe behaviour, not the permissive one —
 * the opposite default would make the spec requirement opt-in, and an opt-in
 * gate is one nobody has opted into yet.
 */
export function evaluateQuickFixEligibility(
  context: QuickFixContext,
  config: QuickFixPolicyConfig,
  featurePolicy?: FeaturePolicy,
): QuickFixEligibilityResult {
  const reasons: string[] = [];
  const reasonCodes: QuickFixReasonCode[] = [];
  let needsHumanReview = false;

  // An unrecognised task type matches no policy row. It must never be the
  // cheapest way past this gate, so it routes to a human rather than falling
  // through to the bug default — which would silently drop the reproduction
  // requirement for a request nobody has classified.
  const rawTaskType = context.taskType ?? "bug";
  if (!KNOWN_TASK_TYPES.has(rawTaskType)) {
    return {
      eligible: false,
      outcome: "human_review",
      reasons: [
        `Unrecognised taskType ${JSON.stringify(rawTaskType)} — no policy matched. Routed to human review rather than dispatched.`,
      ],
      reasonCodes: [QUICK_FIX_REASON_CODES.NO_POLICY_MATCH],
    };
  }
  const taskType = rawTaskType as QuickFixTaskType;

  const priority = parseLevel(context.priorityLabel, "p");
  const maxPriority = parseLevel(config.maxPriority, "p");
  if (priority < maxPriority) {
    reasons.push(`Priority too high (${context.priorityLabel}).`);
  }

  const severity = parseLevel(context.severityLabel, "s");
  const maxSeverity = parseLevel(config.maxSeverity, "s");
  if (severity < maxSeverity) {
    reasons.push(`Severity too high (${context.severityLabel}).`);
  }

  if (taskType === "bug" && !context.reproduced && context.humanConfirmed !== true) {
    reasons.push("Bug must be reproduced with clear evidence.");
  }

  // The teeth. Applies to the feature path only — a bug is anchored by
  // reproduction and a chore by its target + definition of done, so neither
  // needs a spec, and demanding one would recreate the exact "claim something
  // you do not have" hazard that splitting trigger_code_task out solved.
  const requireSpec = featurePolicy?.dispatch.requireApprovedSpecForFeature ?? true;
  if (taskType === "feature" && requireSpec) {
    const specGate = evaluateFeatureSpecGate(context);
    reasons.push(...specGate.reasons);
    reasonCodes.push(...specGate.codes);
    needsHumanReview ||= specGate.needsHumanReview;
  }

  if (context.estimatedFilesChanged > config.maxFilesChanged) {
    reasons.push(`Estimated file count ${context.estimatedFilesChanged} exceeds cap.`);
  }

  if (context.estimatedLinesChanged > config.maxLinesChanged) {
    reasons.push(`Estimated line count ${context.estimatedLinesChanged} exceeds cap.`);
  }

  if (!context.canAddRegressionTest) {
    reasons.push("Regression test required.");
  }

  if (context.openAutofixPrCount >= config.maxOpenPrsPerIssue) {
    reasons.push("Open autofix PR already exists for this issue.");
  }

  for (const label of config.forbiddenLabels) {
    if (context.labels.includes(label)) {
      reasons.push(`Forbidden label ${label}.`);
    }
  }

  if (context.component && config.forbiddenComponents.includes(context.component)) {
    reasons.push(`Forbidden component ${context.component}.`);
  }

  // The standing protected-path list, plus whatever autofix-policy.yaml adds.
  //
  // This used to build a RegExp inline per (path × pattern) with two
  // sequential `.replace` calls, which compounded: `**` compiled to `.[^/]*`,
  // so it could not cross more than one `/` and required a leading character —
  // `**/auth/**` did not match `auth/login.ts`. The result was also unanchored
  // and left regex metacharacters unescaped, so `**/release.yml` matched
  // `releaseXyml`. See protected-paths.spec.ts, which pins each of those.
  for (const hit of findProtectedPaths(context.rootCausePaths, config.forbiddenPathPatterns)) {
    reasons.push(`Path ${hit.path} is protected — ${hit.reason} (rule: ${hit.pattern}).`);
  }

  const eligible = reasons.length === 0;
  // human_review only survives when nothing else already refused: a definite
  // refusal is more actionable than "someone should look at this".
  const outcome: QuickFixOutcome = eligible
    ? "eligible"
    : needsHumanReview && reasonCodes.every((code) => SOFT_CODES.has(code))
      ? "human_review"
      : "ineligible";

  return { eligible, reasons, outcome, reasonCodes };
}

/**
 * Reason codes that express "could not evaluate" rather than "refused".
 * A result carrying only these routes to human review.
 */
const SOFT_CODES: ReadonlySet<QuickFixReasonCode> = new Set([
  QUICK_FIX_REASON_CODES.NO_POLICY_MATCH,
  QUICK_FIX_REASON_CODES.SPEC_EVIDENCE_MISSING,
  QUICK_FIX_REASON_CODES.SPEC_EVIDENCE_MISMATCH,
]);
