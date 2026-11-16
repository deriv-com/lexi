import type { DecisionClassification } from "@lexi/database";
import {
  evaluateAutoClose,
  type AutoCloseContext,
  type AutoCloseEvaluation,
  type AutoClosePolicyOptions,
} from "./auto-close-policy";
import {
  evaluateVerificationAutoClose,
  type VerificationAutoCloseEvaluation,
} from "./verification-policy";
import type { VerificationResult } from "./verification-contract";

export interface PolicyEngineOptions {
  autoCloseMinConfidence?: number;
  autoCloseMinScenarioFit?: number;
}

/**
 * Organizational policy layer — governs actions (auto-close, etc.) separately from AI reasoning.
 */
export class PolicyEngine {
  constructor(private readonly options: PolicyEngineOptions = {}) {}

  /**
   * PRIMARY auto-close path using the canonical VerificationResult.
   * New code should use this exclusively.
   */
  evaluateAutoCloseCanonical(result: VerificationResult): VerificationAutoCloseEvaluation {
    return evaluateVerificationAutoClose(result, {
      minConfidence: this.options.autoCloseMinConfidence ?? 0.85,
      minScenarioFit: this.options.autoCloseMinScenarioFit ?? 0.75,
    });
  }

  /**
   * @deprecated Legacy auto-close path consuming raw resultDetails.
   * Callers should migrate to evaluateAutoCloseCanonical(VerificationResult).
   */
  evaluateAutoClose(context: AutoCloseContext): AutoCloseEvaluation {
    return evaluateAutoClose(context, {
      minConfidence: this.options.autoCloseMinConfidence,
      minScenarioFit: this.options.autoCloseMinScenarioFit,
    });
  }

  /** @deprecated Use evaluateAutoCloseCanonical */
  canAutoClose(classification: DecisionClassification, context: Omit<AutoCloseContext, "classification">): AutoCloseEvaluation {
    return this.evaluateAutoClose({ ...context, classification });
  }
}

export type { AutoCloseContext, AutoCloseEvaluation, AutoClosePolicyOptions };
