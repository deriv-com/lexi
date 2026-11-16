import type { DecisionClassification } from "@lexi/database";
import {
  lifecycleAutoCloseBlockReason,
  parseLifecycleCoverageFromDetails,
} from "./lifecycle-coverage";

export interface AutoClosePolicyOptions {
  minConfidence?: number;
  minScenarioFit?: number;
}

export interface AutoCloseContext {
  classification: DecisionClassification;
  decisionConfidence: number;
  resultDetails?: Record<string, unknown> | null;
}

export interface AutoCloseEvaluation {
  allowed: boolean;
  reason: string;
}

const AUTO_CLOSE_CLASSIFICATIONS = new Set<DecisionClassification>([
  "LIKELY_FIXED",
  "DUPLICATE",
  "NOT_OBSERVED_WITH_COMPLETE_COVERAGE",
  /** Legacy — still gated by lifecycle and incompleteEvidence checks */
  "CANNOT_REPRODUCE",
]);

const DEFAULT_MIN_CONFIDENCE = 0.85;
const DEFAULT_MIN_SCENARIO_FIT = 0.75;

/**
 * Conservative gates before GitHub auto-close. Closing is the highest-risk action;
 * reproduction quality must support the classification.
 *
 * @deprecated Use evaluateVerificationAutoClose() from verification-policy.ts instead.
 * This function consumes raw `resultDetails` (adapter-specific). The canonical path
 * consumes a typed VerificationResult, which enforces safety invariants at the type level.
 * Retained for backward compatibility with non-orchestrator callers only.
 */
export function evaluateAutoClose(
  context: AutoCloseContext,
  options: AutoClosePolicyOptions = {},
): AutoCloseEvaluation {
  if (!AUTO_CLOSE_CLASSIFICATIONS.has(context.classification)) {
    return { allowed: false, reason: "Classification is not eligible for auto-close." };
  }

  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  if (context.decisionConfidence < minConfidence) {
    return {
      allowed: false,
      reason: `Decision confidence ${context.decisionConfidence.toFixed(2)} is below required ${minConfidence}.`,
    };
  }

  const details = context.resultDetails;
  if (!details || typeof details !== "object") {
    if (context.classification === "CANNOT_REPRODUCE" || context.classification === "NOT_OBSERVED_WITH_COMPLETE_COVERAGE") {
      return {
        allowed: false,
        reason: "No reproduction metadata — cannot auto-close without complete evidence.",
      };
    }
    return {
      allowed: true,
      reason: "No reproduction metadata — auto-close allowed on classification and confidence only.",
    };
  }

  const lifecycle = parseLifecycleCoverageFromDetails(details);
  if (
    context.classification === "CANNOT_REPRODUCE" &&
    lifecycle &&
    lifecycle.requiredStates.length > 0 &&
    !lifecycle.coverageComplete
  ) {
    return {
      allowed: false,
      reason: lifecycleAutoCloseBlockReason(lifecycle),
    };
  }

  if (details.incompleteEvidence === true) {
    return {
      allowed: false,
      reason: "Reproduction evidence did not adequately cover the reported bug class (incompleteEvidence).",
    };
  }

  const outcomeKind = details.outcomeKind;
  if (
    outcomeKind === "infra_failure" ||
    outcomeKind === "blocked_external" ||
    outcomeKind === "blocked_human_verification"
  ) {
    return {
      allowed: false,
      reason: `Reproduction ended with ${outcomeKind} — not a valid cannot-reproduce signal.`,
    };
  }

  if (
    context.classification === "CANNOT_REPRODUCE" ||
    context.classification === "NOT_OBSERVED_WITH_COMPLETE_COVERAGE"
  ) {
    if (details.reproduced === null) {
      return {
        allowed: false,
        reason: "Reproduction outcome is inconclusive (reproduced: null) — cannot auto-close as not observed.",
      };
    }
  }

  if (context.classification === "NOT_OBSERVED_WITH_COMPLETE_COVERAGE") {
    const lifecycle = parseLifecycleCoverageFromDetails(details);
    if (lifecycle && !lifecycle.coverageComplete) {
      return {
        allowed: false,
        reason: "NOT_OBSERVED_WITH_COMPLETE_COVERAGE requires complete lifecycle coverage.",
      };
    }
    if (details.incompleteEvidence === true) {
      return {
        allowed: false,
        reason: "Incomplete evidence blocks auto-close even when classification is not observed.",
      };
    }
  }

  if (details.reproduced === null && context.classification === "CANNOT_REPRODUCE") {
    return {
      allowed: false,
      reason: "Reproduction outcome is inconclusive (reproduced: null) — cannot auto-close as cannot-reproduce.",
    };
  }

  const minScenarioFit = options.minScenarioFit ?? DEFAULT_MIN_SCENARIO_FIT;
  const scenarioFit = typeof details.scenarioFit === "number" ? details.scenarioFit : undefined;
  if (scenarioFit !== undefined && scenarioFit < minScenarioFit) {
    return {
      allowed: false,
      reason: `Scenario fit ${scenarioFit.toFixed(2)} is below required ${minScenarioFit}.`,
    };
  }

  const evaluations = details.evaluations;
  if (Array.isArray(evaluations) && evaluations.length > 0) {
    const lastEval = evaluations[evaluations.length - 1] as { retryRecommended?: boolean; scenarioFit?: number };
    if (lastEval.retryRecommended === true) {
      return {
        allowed: false,
        reason: "Planner marked retryRecommended on the final reproduction attempt.",
      };
    }
  }

  return { allowed: true, reason: "All auto-close gates passed." };
}
