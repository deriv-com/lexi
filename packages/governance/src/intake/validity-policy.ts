export type ValidityVerdict =
  | "VALID_BUG"
  | "NOT_A_BUG"
  | "FEATURE_REQUEST"
  | "SUPPORT_QUERY"
  | "INCOHERENT"
  | "ENVIRONMENT_ISSUE"
  | "OUT_OF_SCOPE"
  | "LOW_CONFIDENCE_VALID";

export interface ValidityRecommendation {
  verdict: ValidityVerdict;
  confidence: number;
  reasoning: string;
  modelVersion?: string;
  promptVersion?: string;
  rawResponseRedacted?: Record<string, unknown>;
}

export interface IntakeValidityPolicyConfig {
  rejectConfidenceThreshold: number;
  securityLabels: string[];
}

export interface ValidityPolicyDecision {
  accept: boolean;
  applyReviewLabel: boolean;
  reasonCode: string;
  explanation: string;
}

/**
 * Deterministic intake policy — AI recommends; policy authorizes rejection.
 * Prefer false acceptance over false rejection.
 */
export function evaluateValidityPolicy(
  recommendation: ValidityRecommendation,
  labels: string[],
  config: IntakeValidityPolicyConfig,
): ValidityPolicyDecision {
  const normalizedLabels = labels.map((l) => l.toLowerCase());
  const isSecurity = config.securityLabels.some((sl) =>
    normalizedLabels.includes(sl.toLowerCase()),
  );

  if (isSecurity) {
    return {
      accept: true,
      applyReviewLabel: true,
      reasonCode: "SECURITY_BYPASS_REJECTION",
      explanation: "Security-labelled reports bypass automated rejection.",
    };
  }

  if (recommendation.verdict === "LOW_CONFIDENCE_VALID" || recommendation.confidence < config.rejectConfidenceThreshold) {
    return {
      accept: true,
      applyReviewLabel: true,
      reasonCode: "LOW_CONFIDENCE_ACCEPTED",
      explanation: "Ambiguous report accepted for human review (false acceptance preferred).",
    };
  }

  const rejectVerdicts: ValidityVerdict[] = [
    "NOT_A_BUG",
    "FEATURE_REQUEST",
    "SUPPORT_QUERY",
    "INCOHERENT",
    "OUT_OF_SCOPE",
  ];

  if (
    rejectVerdicts.includes(recommendation.verdict) &&
    recommendation.confidence >= config.rejectConfidenceThreshold
  ) {
    return {
      accept: false,
      applyReviewLabel: false,
      reasonCode: `INVALID_${recommendation.verdict}`,
      explanation: recommendation.reasoning,
    };
  }

  if (recommendation.verdict === "ENVIRONMENT_ISSUE" && recommendation.confidence >= config.rejectConfidenceThreshold) {
    return {
      accept: false,
      applyReviewLabel: false,
      reasonCode: "INVALID_ENVIRONMENT_ISSUE",
      explanation: recommendation.reasoning,
    };
  }

  return {
    accept: true,
    applyReviewLabel: false,
    reasonCode: "VALID_BUG",
    explanation: recommendation.reasoning,
  };
}
