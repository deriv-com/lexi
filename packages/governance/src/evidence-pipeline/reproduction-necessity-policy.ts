import type {
  ReproductionDecision,
  ReproductionNecessityInput,
} from "./reproduction-necessity-policy.types";

/**
 * Deterministic policy: decides whether reproduction reproduction is required.
 *
 * Principle: Do not reproduce by default. Reproduce only when
 * Reproduction adds decision value.
 */
export function evaluateReproductionNecessity(
  input: ReproductionNecessityInput,
): ReproductionDecision {
  // ---- Skip reproduction: clear alternatives exist ----

  if (input.isDuplicate) {
    return {
      required: false,
      reason: "Issue is a confirmed duplicate — reproduction is redundant.",
      alternativeAction: "GOVERNED_CLOSURE",
      priority: "not_needed",
    };
  }

  if (input.isUnsupported) {
    return {
      required: false,
      reason: "Issue is unsupported — requires manual investigation.",
      alternativeAction: "MANUAL_INVESTIGATION",
      priority: "not_needed",
    };
  }

  if (input.isIncompleteReport) {
    return {
      required: false,
      reason: "Report is incomplete — request more information before investing in reproduction.",
      alternativeAction: "REQUEST_MORE_INFO",
      priority: "not_needed",
    };
  }

  if (input.teamIsWorkingOnIt || input.hasLinkedImplementation) {
    return {
      required: false,
      reason: "Team is actively working on this issue — monitor progress instead of reproducing.",
      alternativeAction: "MONITOR_PR",
      priority: "not_needed",
    };
  }

  if (input.hasActivePR) {
    return {
      required: false,
      reason: "An active PR is linked — wait for merge and then verify.",
      alternativeAction: "MONITOR_PR",
      priority: "not_needed",
    };
  }

  // ---- Fix status routing ----

  if (input.fixStatus === "FIX_IN_PROGRESS") {
    return {
      required: false,
      reason: "Fix is in progress — monitor rather than reproduce.",
      alternativeAction: "MONITOR_PR",
      priority: "not_needed",
    };
  }

  if (input.fixStatus === "PR_MERGED_NOT_RELEASED") {
    return {
      required: false,
      reason: "Fix PR is merged but not released — await release before verifying.",
      alternativeAction: "AWAIT_RELEASE",
      priority: "after_release",
    };
  }

  if (input.fixStatus === "RELEASED_NOT_VERIFIED") {
    return {
      required: true,
      reason: "Fix released but not verified — reproduction retest needed to confirm the fix works.",
      priority: "immediate",
    };
  }

  if (input.fixStatus === "LIKELY_FIXED" && input.fixConfidence >= 0.8) {
    return {
      required: true,
      reason: "Likely fixed with high confidence — reproduction verification needed before closure.",
      priority: "immediate",
    };
  }

  // ---- Evidence-based decisions ----

  // Strong evidence + high trust → skip reproduction for new issues
  if (
    input.evidenceStrength >= 0.7 &&
    input.reporterTrust >= 0.8 &&
    !input.likelyFalsePositive &&
    input.issueAgeInDays < 7 &&
    input.fixStatus === "NO_FIX_EVIDENCE"
  ) {
    return {
      required: false,
      reason: "Strong evidence from trusted source, no fix activity — triage and assign without reproduction.",
      alternativeAction: "TRIAGE_AND_ASSIGN",
      priority: "not_needed",
    };
  }

  // Likely false positive → reproduce to verify
  if (input.likelyFalsePositive) {
    return {
      required: true,
      reason: "Issue may be a false positive — reproduction needed to validate.",
      priority: "immediate",
    };
  }

  // Old issue with no recent reproduction
  if (input.issueAgeInDays > 30 && !input.lastReproducedAt) {
    return {
      required: true,
      reason: "Issue is older than 30 days without reproduction — state may have changed.",
      priority: "scheduled",
    };
  }

  // Low evidence strength
  if (input.evidenceStrength < 0.4) {
    return {
      required: true,
      reason: "Evidence strength is low — reproduction needed to validate the report.",
      priority: "immediate",
    };
  }

  // High reproduction value from analysis
  if (input.reproductionValue === "high") {
    return {
      required: true,
      reason: "Analysis indicates high reproduction value for this issue.",
      priority: "immediate",
    };
  }

  // Medium reproduction value with moderate evidence
  if (input.reproductionValue === "medium" && input.evidenceStrength < 0.6) {
    return {
      required: true,
      reason: "Moderate reproduction value with insufficient evidence — reproduction adds decision value.",
      priority: "scheduled",
    };
  }

  // Default: if no clear skip reason, triage and assign
  return {
    required: false,
    reason: "Sufficient evidence and no uncertainty requiring reproduction — triage directly.",
    alternativeAction: "TRIAGE_AND_ASSIGN",
    priority: "not_needed",
  };
}
