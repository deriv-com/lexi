import type { DecisionClassification } from "@lexi/database";
import type { LifecycleCoverage } from "./lifecycle-coverage";
import { parseLifecycleCoverageFromDetails } from "./lifecycle-coverage";
export type EscalationTarget = "manual" | "environment";

export interface EscalationEvaluation {
  /** Deterministic classification replacing ambiguous AI output. */
  classification: DecisionClassification;
  escalationTarget: EscalationTarget;
  summary: string;
  reasoning: string;
  nextAction: string;
  confidence: number;
  /**
   * Which kind of live session the judge asked for, when it asked for one.
   *
   * Present only on the dynamic-reproduction rung. "browser" means an automated
   * session would settle it; "human" means a person is irreplaceable; null
   * means the judge did not say. The notification copy reads this instead of
   * asserting a human is needed for every dynamic case, and it is the seam an
   * automated-browser lane routes on.
   */
  dynamicKind?: "browser" | "human" | null;
}

function lifecycleFromDetails(details: Record<string, unknown> | null | undefined): LifecycleCoverage | null {
  return parseLifecycleCoverageFromDetails(details ?? undefined);
}

function isIncompleteLifecycle(details: Record<string, unknown> | null | undefined): boolean {
  const lc = lifecycleFromDetails(details);
  return lc !== null && lc.requiredStates.length > 0 && !lc.coverageComplete;
}

function outcomeKind(details: Record<string, unknown> | null | undefined): string | undefined {
  if (!details || typeof details.outcomeKind !== "string") {
    return undefined;
  }
  return details.outcomeKind;
}

function failureCode(details: Record<string, unknown> | null | undefined): string | undefined {
  if (!details || typeof details.failureCode !== "string") {
    return undefined;
  }
  return details.failureCode;
}

function blockedBy(details: Record<string, unknown> | null | undefined): LifecycleCoverage["blockedBy"] | undefined {
  const lc = lifecycleFromDetails(details);
  return lc?.blockedBy;
}

/**
 * Deterministic escalation when reproduction did not complete the required lifecycle,
 * or when the primary judge flagged a visual/dynamic case that needs a live session.
 * Returns null when the AI decision should stand (complete coverage or verified bug).
 */
export function evaluateEscalation(
  details: Record<string, unknown> | null | undefined,
  // Reserved for label-aware rules; accepted so callers can pass issue context.
  _options: { issueLabels?: string[] } = {},
): EscalationEvaluation | null {
  if (!details) {
    return null;
  }

  const incomplete = details.incompleteEvidence === true || isIncompleteLifecycle(details);
  const kind = outcomeKind(details);
  const code = failureCode(details);
  const blocked = blockedBy(details);
  const needsDynamicReproduction = details.needsDynamicReproduction === true;
  // "browser" | "human" | null. The judge's own bar for needsDynamicReproduction
  // is "a real browser OR device session", which lumps a console-error check in
  // with a selfie capture. Only the latter needs a person, so carry the kind and
  // let the caller describe the hand-off truthfully.
  const dynamicKind =
    details.dynamicReproductionKind === "browser" || details.dynamicReproductionKind === "human"
      ? details.dynamicReproductionKind
      : null;

  if (kind === "infra_failure" || code === "executor_error" || code === "login_health_failed") {
    return {
      classification: "BLOCKED_BY_ENVIRONMENT",
      escalationTarget: "environment",
      summary: "Reproduction blocked by infrastructure or environment failure.",
      reasoning:
        "The reproduction provider could not complete reproduction due to infrastructure or environment failure before reaching the reported state.",
      nextAction: "Retry when browser/worker capabilities are healthy; do not treat as cannot-reproduce.",
      confidence: 0.95,
    };
  }

  if (code === "missing_credentials" || blocked === "credentials") {
    return {
      classification: "BLOCKED_BY_CREDENTIALS",
      escalationTarget: "environment",
      summary: "Reproduction blocked — test credentials unavailable.",
      reasoning: "Required test credentials were missing or invalid; lifecycle state was not reached.",
      nextAction: "Provision approved test credentials and re-run reproduction.",
      confidence: 0.95,
    };
  }

  // Identity-verification and payment states stay manual even when the judge asked for a browser session.
  if (blocked === "kyc" || code === "blocked_kyc") {
    return {
      classification: "BLOCKED_BY_KYC",
      escalationTarget: "manual",
      summary: "Reproduction blocked before KYC-complete state.",
      reasoning: "The reported state requires KYC completion; automated reproduction cannot proceed.",
      nextAction: "Assign for manual investigation with a KYC-complete test account.",
      confidence: 0.95,
    };
  }

  if (blocked === "payment" || code === "blocked_payment") {
    return {
      classification: "BLOCKED_BY_PAYMENT",
      escalationTarget: "manual",
      summary: "Reproduction blocked before payment-enabled state.",
      reasoning: "The reported state requires payment or deposit flow; automated reproduction cannot proceed safely.",
      nextAction: "Assign for manual investigation with approved payment test instruments.",
      confidence: 0.95,
    };
  }

  // The primary judge flagged a visual / browser / multi-step UI case. Do not
  // wait for incompleteEvidence — a text-only judge never sets it.
  if (needsDynamicReproduction) {
    return {
      classification: "NEEDS_MANUAL_INVESTIGATION",
      escalationTarget: "manual",
      dynamicKind,
      summary:
        dynamicKind === "browser"
          ? "Live browser session required — manual reproduction requested."
          : "Visual or dynamic reproduction required — manual reproduction requested.",
      reasoning:
        dynamicKind === "browser"
          ? "The primary judge could not confirm this from the report and code text alone; a live " +
            "browser session is required. It judged that an automated session would settle it — no " +
            "human-only step (OTP, selfie, passkey, funded account) was identified."
          : "The primary judge could not confirm this from the report and code text alone; a real browser or device session is required.",
      nextAction: "Request a reproduction in a live browser or device session, then record the result on the issue.",
      confidence: 0.85,
    };
  }

  if (!incomplete) {
    return null;
  }

  if (
    blocked === "otp" ||
    code === "blocked_otp" ||
    code === "blocked_human_verification" ||
    kind === "blocked_human_verification"
  ) {
    return {
      classification: "BLOCKED_BY_OTP",
      escalationTarget: "manual",
      summary: "Reproduction blocked at human verification (OTP / guided step).",
      reasoning:
        "Automated reproduction stopped at OTP or human verification before the reported post-auth state.",
      nextAction: "Manual investigation: complete signup/login and capture console output at the reported screen.",
      confidence: 0.92,
    };
  }

  if (blocked === "external_service" || kind === "blocked_external") {
    return {
      classification: "NEEDS_MANUAL_INVESTIGATION",
      escalationTarget: "manual",
      summary: "Incomplete lifecycle coverage — inconclusive reproduction.",
      reasoning:
        "No attempt completed the required lifecycle state(s). A shallow fallback cannot establish bug_not_observed.",
      nextAction: "Manual investigation required to reach the reported account state and verify the defect.",
      confidence: 0.9,
    };
  }

  return {
    classification: "NEEDS_MANUAL_INVESTIGATION",
    escalationTarget: "manual",
    summary: "Incomplete lifecycle coverage — inconclusive reproduction.",
    reasoning:
      "Reproduction evidence does not cover the lifecycle state where the bug was reported.",
    nextAction: "Manual investigation required before closing or confirming cannot-reproduce.",
    confidence: 0.9,
  };
}

export function remapCompleteCoverageClassification(
  classification: DecisionClassification,
  details: Record<string, unknown> | null | undefined,
): DecisionClassification {
  if (classification !== "CANNOT_REPRODUCE") {
    return classification;
  }
  const incomplete = details?.incompleteEvidence === true || isIncompleteLifecycle(details);
  if (
    !incomplete &&
    details?.outcomeKind === "bug_not_observed" &&
    details?.reproduced === false
  ) {
    return "NOT_OBSERVED_WITH_COMPLETE_COVERAGE";
  }
  return classification;
}

export function buildDeterministicDecision(
  escalation: EscalationEvaluation,
  aiDecision: { component: string; team: string; owner?: string | null; labels: string[] },
): {
  classification: DecisionClassification;
  component: string;
  team: string;
  owner?: string | null;
  confidence: number;
  labels: string[];
  summary: string;
  reasoning: string;
  nextAction: string;
} {
  return {
    classification: escalation.classification,
    component: aiDecision.component,
    team: aiDecision.team,
    owner: aiDecision.owner,
    confidence: escalation.confidence,
    labels: aiDecision.labels,
    summary: escalation.summary,
    reasoning: escalation.reasoning,
    nextAction: escalation.nextAction,
  };
}
