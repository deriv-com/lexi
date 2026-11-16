/**
 * Delivery progress and verification rules.
 *
 * Pure, deterministic, no model calls — "have all the PRs merged" and "is this
 * a feature or a bug" are lookups, not judgements.
 *
 * ## Bug 1: retest fires on *any* merged linked PR
 *
 * `workflow-orchestrator.runProgressCheck` currently advances to MERGED and
 * retests on `linkedPrs.some(pr => pr.merged)`. A fix split across two repos
 * or two layers is therefore declared delivered when the *first* PR lands, and
 * the retest runs against half a fix. The bug still reproduces, so the retest
 * reports failure and the fix looks broken when it was merely incomplete.
 * `isDeliveryComplete` is the replacement rule.
 *
 * ## Bug 2: features verified by bug retest
 *
 * Retest asks "is it still reproducible?". For a feature there was never a
 * defect to reproduce, so the question has no truthful answer — and a
 * not-reproduced result would read as success, letting a feature reach
 * VERIFIED on evidence that means nothing about whether the feature works.
 * Features are verified by a deployment record instead
 * (`config/feature-policy.yaml: verification.featureVerifiedBy`).
 *
 * Policy values are passed in rather than read from disk here: the keys live in
 * `config/feature-policy.yaml`, whose schema belongs to another package. The defaults
 * below match that file, and the caller may override them from the loaded
 * config without this module taking a dependency on its schema.
 */

/** A pull request linked to a subject. Mirrors `LinkedPullRequestDto` in @lexi/github. */
export interface LinkedPullRequest {
  number: number;
  state: "open" | "closed" | "merged";
  merged: boolean;
}

export interface DeliveryInput {
  linkedPrs: readonly LinkedPullRequest[];
  /**
   * When set, this PR alone decides delivery. The escape hatch for work whose
   * linked PRs are genuinely unrelated — a doc PR alongside the fix, say —
   * without weakening the default rule for everyone else.
   */
  primaryPrNumber?: number | null;
  /**
   * `config/feature-policy.yaml: verification.requireAllLinkedPrsMerged`.
   * Setting it false restores the legacy any-merged behaviour; it exists so
   * the change is revertable by config rather than by redeploying code.
   */
  requireAllLinkedPrsMerged?: boolean;
}

export type DeliveryStage = "no_prs" | "in_progress" | "partially_merged" | "delivered";

export interface DeliveryProgress {
  stage: DeliveryStage;
  mergedPrNumbers: number[];
  /** Still open, still expected to land — these are what block delivery. */
  pendingPrNumbers: number[];
  /** Closed without merging: abandoned, and deliberately not blocking. */
  abandonedPrNumbers: number[];
  complete: boolean;
}

function isMerged(pr: LinkedPullRequest): boolean {
  return pr.merged || pr.state === "merged";
}

function isPending(pr: LinkedPullRequest): boolean {
  return !isMerged(pr) && pr.state === "open";
}

/**
 * Whether every PR this subject is waiting on has landed.
 *
 * A PR closed *without* merging does not block: it was abandoned and is no
 * longer part of the delivery, so treating it as outstanding would strand the
 * subject in "not delivered" forever. An **open** PR does block — it is still
 * expected to land, and that is precisely the multi-PR case this fixes.
 */
export function isDeliveryComplete(input: DeliveryInput): boolean {
  const { linkedPrs, primaryPrNumber } = input;
  const requireAll = input.requireAllLinkedPrsMerged ?? true;

  if (linkedPrs.length === 0) {
    return false;
  }

  if (primaryPrNumber != null) {
    const primary = linkedPrs.find((pr) => pr.number === primaryPrNumber);
    // An unknown primary is a stale or mistyped reference, not permission to
    // skip the check — fall through to the all-merged rule rather than
    // declaring delivery on a PR nobody can see.
    if (primary) {
      return isMerged(primary);
    }
  }

  const merged = linkedPrs.filter(isMerged);
  if (merged.length === 0) {
    return false;
  }

  return requireAll ? !linkedPrs.some(isPending) : true;
}

/** The full picture, so a nudge can name the PRs a subject is still waiting on. */
export function deliveryProgress(input: DeliveryInput): DeliveryProgress {
  const merged = input.linkedPrs.filter(isMerged);
  const pending = input.linkedPrs.filter(isPending);
  const abandoned = input.linkedPrs.filter((pr) => !isMerged(pr) && pr.state === "closed");
  const complete = isDeliveryComplete(input);

  let stage: DeliveryStage;
  if (input.linkedPrs.length === 0) {
    stage = "no_prs";
  } else if (complete) {
    stage = "delivered";
  } else if (merged.length > 0) {
    stage = "partially_merged";
  } else {
    stage = "in_progress";
  }

  return {
    stage,
    mergedPrNumbers: merged.map((pr) => pr.number),
    pendingPrNumbers: pending.map((pr) => pr.number),
    abandonedPrNumbers: abandoned.map((pr) => pr.number),
    complete,
  };
}

/** Work-item kinds, matching `config/feature-policy.yaml: workItems.kinds`. */
export type VerifiableKind = "bug" | "feature" | "chore" | "spec";

export type VerificationMode = "retest" | "deployment_record";

/**
 * Only a bug is verified by retest. Everything else — feature, chore, spec —
 * has no defect to re-attempt, so a deployment record is the evidence that the
 * work actually reached users.
 */
export function verificationModeFor(kind: VerifiableKind): VerificationMode {
  return kind === "bug" ? "retest" : "deployment_record";
}

/** A retest outcome, narrowed to the two facts verification depends on. */
export interface RetestEvidence {
  reproduced: boolean;
  /**
   * Whether the retest actually covered the reported lifecycle state. An
   * incomplete retest that did not reproduce proves nothing — the same
   * distinction `escalation-policy.ts` draws for `incompleteEvidence`.
   */
  complete: boolean;
}

/** A `DeploymentRecord` row, narrowed to what verification reads. */
export interface DeploymentEvidence {
  releaseVersion: string;
  repository: string;
  environment: string;
  status: string;
  deployedAt: Date;
}

export interface VerificationInput {
  kind: VerifiableKind;
  retest?: RetestEvidence;
  deployments?: readonly DeploymentEvidence[];
  /** Restrict evidence to the repo the work landed in, when known. */
  repository?: string;
  /** Environments that count as shipped. Defaults to production only. */
  environments?: readonly string[];
}

export interface VerificationResult {
  verified: boolean;
  mode: VerificationMode;
  reason: string;
  /** The deployment that satisfied verification, when one did. */
  evidence?: DeploymentEvidence;
}

const DEFAULT_VERIFYING_ENVIRONMENTS = ["production"];

/**
 * Decides whether a work item is verified, by the mode its kind demands.
 *
 * A feature handed a spotless retest is still not verified: the mode is chosen
 * by kind first, and retest evidence is never consulted for a non-bug. That
 * ordering is the guard — it makes verifying a feature by retest unreachable
 * rather than merely discouraged.
 */
export function evaluateVerification(input: VerificationInput): VerificationResult {
  const mode = verificationModeFor(input.kind);

  if (mode === "retest") {
    if (!input.retest) {
      return { verified: false, mode, reason: "No retest evidence for this bug yet." };
    }
    if (!input.retest.complete) {
      return {
        verified: false,
        mode,
        reason: "Retest coverage was incomplete — a shallow retest cannot establish that the bug is fixed.",
      };
    }
    if (input.retest.reproduced) {
      return { verified: false, mode, reason: "Retest shows the bug is still reproducible after the fix merged." };
    }
    return { verified: true, mode, reason: "Retest completed without reproducing the reported defect." };
  }

  const environments = input.environments ?? DEFAULT_VERIFYING_ENVIRONMENTS;
  const candidates = (input.deployments ?? []).filter(
    (record) =>
      record.status === "success" &&
      environments.includes(record.environment) &&
      (!input.repository || record.repository === input.repository),
  );

  if (candidates.length === 0) {
    return {
      verified: false,
      mode,
      reason:
        (input.deployments ?? []).length === 0
          ? `No deployment record for this ${input.kind} — a ${input.kind} is verified by deployment, not by bug retest.`
          : `No successful deployment to ${environments.join("/")} for this ${input.kind}.`,
    };
  }

  const evidence = candidates.reduce((latest, record) => (record.deployedAt > latest.deployedAt ? record : latest));
  return {
    verified: true,
    mode,
    reason: `Deployed ${evidence.releaseVersion} to ${evidence.environment}.`,
    evidence,
  };
}
