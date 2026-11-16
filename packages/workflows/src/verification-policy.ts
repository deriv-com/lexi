/**
 * Unified Verification Policy — consumes ONLY the canonical VerificationResult.
 *
 * Replaces the scattered auto-close and escalation logic that previously
 * branched on adapter-specific fields (reproduced, outcomeKind, failureCode).
 *
 * Now there is ONE policy entry point that answers:
 * - Can we auto-close this issue?
 * - What should we escalate?
 * - Is this a capability gap?
 */

import type {
  VerificationResult,
  VerificationBlocker,
} from "./verification-contract";
import {
  isValidNegativeEvidence,
  canNeverBecomeNegativeEvidence,
  isCapabilityGap,
} from "./verification-contract";

// ---------------------------------------------------------------------------
// Auto-close policy (consumes only VerificationResult)
// ---------------------------------------------------------------------------

export interface VerificationAutoCloseConfig {
  minConfidence: number;
  minScenarioFit: number;
}

export interface VerificationAutoCloseEvaluation {
  allowed: boolean;
  reason: string;
}

/**
 * Evaluate whether an issue can be auto-closed based on the unified
 * verification result. This replaces the old evaluateAutoClose() which
 * consumed raw `resultDetails`.
 */
export function evaluateVerificationAutoClose(
  result: VerificationResult,
  config: VerificationAutoCloseConfig = { minConfidence: 0.85, minScenarioFit: 0.75 },
): VerificationAutoCloseEvaluation {
  // INVARIANT: unsupported/inconclusive/infra can never auto-close
  if (canNeverBecomeNegativeEvidence(result)) {
    return {
      allowed: false,
      reason: `Cannot auto-close: ${result.verdict} (${result.limitations?.[0] ?? "evidence is not valid for closure"}).`,
    };
  }

  // OBSERVED means the bug exists — don't close!
  if (result.verdict === "OBSERVED") {
    return { allowed: false, reason: "Bug was observed — cannot close a confirmed bug." };
  }

  // Only NOT_OBSERVED_COMPLETE_COVERAGE can auto-close
  if (!isValidNegativeEvidence(result)) {
    return { allowed: false, reason: `Verdict ${result.verdict} is not valid negative evidence for closure.` };
  }

  // Confidence gate
  if (result.confidence < config.minConfidence) {
    return {
      allowed: false,
      reason: `Confidence ${result.confidence.toFixed(2)} is below required ${config.minConfidence}.`,
    };
  }

  // Scenario fit gate
  if (result.scenarioFit !== undefined && result.scenarioFit < config.minScenarioFit) {
    return {
      allowed: false,
      reason: `Scenario fit ${result.scenarioFit.toFixed(2)} is below required ${config.minScenarioFit}.`,
    };
  }

  // Retry recommended — don't close
  if (result.retryRecommended) {
    return { allowed: false, reason: "Retry recommended — result is not definitive." };
  }

  return { allowed: true, reason: "All auto-close gates passed on canonical verification result." };
}

// ---------------------------------------------------------------------------
// Escalation policy (consumes only VerificationResult)
// ---------------------------------------------------------------------------

export interface VerificationEscalation {
  required: boolean;
  target: "manual" | "assisted" | "environment" | "none";
  reason: string;
  blockedBy?: VerificationBlocker;
}

/**
 * Determine if/where to escalate based on the verification result.
 * Replaces the old evaluateEscalation() which consumed raw details.
 */
export function evaluateVerificationEscalation(
  result: VerificationResult,
  options: { assistedVerificationEnabled?: boolean; isHighPriority?: boolean } = {},
): VerificationEscalation {
  // No escalation needed for conclusive results
  if (result.verdict === "OBSERVED" || result.verdict === "NOT_OBSERVED_COMPLETE_COVERAGE") {
    return { required: false, target: "none", reason: "Conclusive verdict — no escalation needed." };
  }

  // Unsupported → manual investigation always
  if (result.verdict === "UNSUPPORTED") {
    return {
      required: true,
      target: "manual",
      reason: result.summary,
    };
  }

  // Inconclusive with blocker → route based on blocker type
  if (result.blockedBy) {
    switch (result.blockedBy) {
      case "INFRA_FAILURE":
      case "ENVIRONMENT":
        return {
          required: true,
          target: "environment",
          reason: `Blocked by ${result.blockedBy}: ${result.summary}`,
          blockedBy: result.blockedBy,
        };

      case "OTP":
      case "EXTERNAL_SERVICE":
        if (options.assistedVerificationEnabled && options.isHighPriority) {
          return {
            required: true,
            target: "assisted",
            reason: `Human verification required (${result.blockedBy}) — assisted verification eligible.`,
            blockedBy: result.blockedBy,
          };
        }
        return {
          required: true,
          target: "manual",
          reason: `Blocked by ${result.blockedBy} — manual investigation required.`,
          blockedBy: result.blockedBy,
        };

      case "KYC":
      case "PAYMENT":
      case "CREDENTIALS":
        return {
          required: true,
          target: "manual",
          reason: `Blocked by ${result.blockedBy}: ${result.summary}`,
          blockedBy: result.blockedBy,
        };
    }
  }

  // Inconclusive without specific blocker
  return {
    required: true,
    target: "manual",
    reason: result.summary || "Inconclusive verification — manual investigation needed.",
  };
}

// ---------------------------------------------------------------------------
// Capability gap detection
// ---------------------------------------------------------------------------

export interface CapabilityGap {
  issueNumber: number;
  repository: string;
  executor: string;
  reason: string;
  requiredCapability: string;
  detectedAt: string;
  issueLabels?: string[];
  issueTitle?: string;
}

/**
 * Extract a capability gap record from an UNSUPPORTED verification result.
 */
export function extractCapabilityGap(
  result: VerificationResult,
  issueNumber: number,
  repository: string,
  issueTitle?: string,
  issueLabels?: string[],
): CapabilityGap | null {
  if (!isCapabilityGap(result)) return null;

  return {
    issueNumber,
    repository,
    executor: result.executor,
    reason: result.limitations?.[0] ?? result.summary,
    requiredCapability: inferRequiredCapability(result, issueTitle, issueLabels),
    detectedAt: result.observedAt,
    issueLabels,
    issueTitle,
  };
}

function inferRequiredCapability(
  result: VerificationResult,
  issueTitle?: string,
  issueLabels?: string[],
): string {
  const text = `${issueTitle ?? ""} ${result.summary}`.toLowerCase();

  if (/mobile|ios|android/.test(text)) return "mobile_app_verification";
  if (/payment|deposit|withdrawal|cashier/.test(text)) return "payment_flow_verification";
  if (/otp|2fa|sms/.test(text)) return "otp_bypass_or_human_assisted";
  if (/kyc|identity|document/.test(text)) return "kyc_complete_account";
  if (/trade|mt5|cfd/.test(text)) return "trading_platform_verification";
  if (/email|notification/.test(text)) return "async_notification_verification";

  return "general_web_verification";
}
