import type { CoverageDimension } from "@lexi/contracts";

/**
 * The question asked for each coverage dimension, and the default offered
 * alongside it.
 *
 * Two reasons this is a table rather than a model call. First, plain
 * code can produce these, so no turn is spent generating them. Second, a
 * default has to be *defensible* — it is what the spec records if nobody
 * answers, so it needs to be a considered product position (mobile-first,
 * WCAG AA, ship behind a flag) rather than whatever the model improvised that
 * afternoon.
 *
 * `gates` encodes information value: a dimension is not worth asking until the
 * dimensions it depends on are settled, because their answers can invalidate
 * it. Asking "what's the rollout plan?" before scope is known spends a turn on
 * an answer that scope may throw away.
 */
export interface QuestionPrompt {
  question: string;
  /** Offered with the question so silence still moves the spec forward. */
  defaultAnswer: string;
  /** Dimensions that should be settled first. */
  gates: CoverageDimension[];
  /**
   * Lower sorts earlier when two dimensions are equally unblocked. Ordering by
   * information value, not by the order they appear in the checklist.
   */
  priority: number;
}

export const QUESTION_PROMPTS: Record<CoverageDimension, QuestionPrompt> = {
  problem: {
    question: "What is actually broken or missing today, and what does it cost the user when they hit it?",
    defaultAnswer: "The problem as stated in the original request, with no additional context.",
    gates: [],
    priority: 0,
  },
  scope: {
    question: "What is in scope for v1 — the smallest version that is genuinely useful?",
    defaultAnswer: "The smallest change that resolves the stated problem, nothing adjacent.",
    gates: ["problem"],
    priority: 1,
  },
  platforms: {
    question: "Which platforms does this ship on — web (web-app), mobile (mobile-app), or both?",
    defaultAnswer: "Mobile first, then web — the smallest viewport is specified first as standing practice.",
    gates: ["scope"],
    priority: 2,
  },
  users: {
    question: "Who is affected, and how do they reach this today?",
    defaultAnswer: "All authenticated users on the affected surface.",
    gates: ["problem"],
    priority: 3,
  },
  acceptance_criteria: {
    question: "How will we know it is done — what must be observably true to call this shipped?",
    defaultAnswer:
      "The stated problem no longer reproduces on the target platforms, and the change meets WCAG 2.2 AA.",
    gates: ["scope"],
    priority: 4,
  },
  non_goals: {
    question: "What is deliberately excluded, so this does not grow while it is being built?",
    defaultAnswer: "Anything not named in scope is out of scope for this revision.",
    gates: ["scope"],
    priority: 5,
  },
  dependencies: {
    question: "Does this block on any upstream work, service, design, or approval?",
    defaultAnswer: "No known upstream dependencies.",
    gates: ["scope", "platforms"],
    priority: 6,
  },
  risks: {
    question: "What could go wrong, and which of those risks are we accepting?",
    defaultAnswer: "No risks identified beyond ordinary regression risk, mitigated by shipping behind a flag.",
    gates: ["scope", "platforms"],
    priority: 7,
  },
  rollout: {
    question: "How does this ship — feature flag, sequencing, and how do we verify it in production?",
    defaultAnswer: "Behind a feature flag, default off, verified by a deployment record before enablement.",
    gates: ["scope", "platforms"],
    priority: 8,
  },

  // These three sort last on purpose: a turn spent on cache policy before the
  // problem is settled is a wasted turn. journey_states and api_contract now
  // hold a draft. performance_plan cannot — its default is the conservative
  // reading (no budget, no named owner) so accepting it silently never asserts
  // a number nobody can measure.
  journey_states: {
    question:
      "Beyond the happy path, which states does this reach — empty, loading, partial, error, offline, no-permission — and what does the user see in each?",
    defaultAnswer:
      "Standard states only: loading while fetching, an error with a retry affordance on failure, and an empty state where a list can be empty. No offline or permission-specific handling.",
    gates: ["scope", "platforms"],
    priority: 9,
  },
  api_contract: {
    question:
      "Which data does this read or write, who owns that resource, and what is cached — for how long, invalidated by what?",
    defaultAnswer:
      "Reads through the existing owner for that resource with no new cache; any mutation is treated as non-retryable unless the API owner confirms an idempotency contract.",
    gates: ["scope"],
    priority: 10,
  },
  performance_plan: {
    question:
      "Which user-perceived moment does this change, what is the budget for it, and who owns a regression?",
    defaultAnswer:
      "No budget set: this change is not expected to move a user-perceived milestone, and no regression owner is named.",
    gates: ["scope", "acceptance_criteria"],
    priority: 11,
  },
};
