import { PinoLoggerService } from "@lexi/logger";
import { AiProvider } from "./ai-provider.interface";
import { AiDecisionInput, Decision } from "./types";

const FALLBACK_DECISION: Omit<Decision, "summary" | "reasoning"> = {
  classification: "NEEDS_MANUAL_INVESTIGATION",
  component: "unassigned",
  team: "Triage",
  confidence: 0,
  labels: ["status:to_do"],
  nextAction: "Manually triage: the AI Decision Engine could not produce a decision.",
};

/**
 * Whether a decision represents no judgment at all, rather than a weak one.
 *
 * `FALLBACK_DECISION` is the only producer of exactly zero confidence, and a
 * provider that genuinely returned 0 would be saying the same thing, so the
 * test is sound either way. Derived rather than persisted as a flag: the pair
 * (confidence 0, NEEDS_MANUAL_INVESTIGATION) already carries it, and reading it
 * back from the database needs no new column.
 *
 * This matters because the two cases demand opposite handling. A considered
 * NEEDS_MANUAL_INVESTIGATION means "a human should look at a genuinely unclear
 * bug"; a fallback means "the classifier fell over and nothing has been assessed
 * yet". Reported identically, the second reads as a verdict about the issue —
 * which is how a failed classification came to be relayed as though the report
 * itself were ambiguous.
 */
export function isNonVerdict(decision: Pick<Decision, "confidence">): boolean {
  return !(decision.confidence > 0);
}

/**
 * Orchestrates calls to the underlying AiProvider. This is the only place
 * in the codebase that should be invoked to obtain a Decision -- it exists
 * so retry/fallback policy lives in one deterministic place rather than
 * inside the AI call itself.
 */
export class DecisionEngine {
  constructor(private readonly provider: AiProvider, private readonly logger: PinoLoggerService) {}

  async decide(input: AiDecisionInput): Promise<Decision> {
    try {
      return await this.provider.generateDecision(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown AI provider error";
      this.logger.error(
        `AI Decision Engine failed for issue #${input.issue.number}: ${message}`,
        "DecisionEngine",
      );
      return {
        ...FALLBACK_DECISION,
        summary: `Automated AI classification failed for issue #${input.issue.number}.`,
        reasoning: `The AI provider raised an error: ${message}. Falling back to manual investigation.`,
      };
    }
  }
}
