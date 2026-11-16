/**
 * HypothesisInvestigationService — competing explanations with evidence discrimination.
 *
 * For a single issue, Lexi forms competing hypotheses rather than blindly
 * calling tools. Then it selects the cheapest evidence that distinguishes them.
 *
 * Example hypotheses for a bug report:
 *   H1: existing frontend bug (needs reproduction verification)
 *   H2: backend regression (check recent releases + PRs)
 *   H3: already fixed (check implementation links + deployment)
 *   H4: duplicate report (check semantic similarity)
 *   H5: unsupported test scenario (check reproduction capability)
 *
 * The service:
 * 1. Generates hypotheses from issue analysis
 * 2. Ranks them by prior probability
 * 3. Identifies discriminating evidence for each pair
 * 4. Selects the cheapest investigation that eliminates the most hypotheses
 * 5. Updates probabilities after each evidence collection
 * 6. Terminates when one hypothesis dominates or budget is exhausted
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HypothesisStatus = "active" | "confirmed" | "eliminated" | "insufficient_evidence";

export interface Hypothesis {
  id: string;
  label: string;
  description: string;
  priorProbability: number;
  posteriorProbability: number;
  status: HypothesisStatus;
  /** What evidence would confirm this hypothesis? */
  confirmingEvidence: string[];
  /** What evidence would eliminate this hypothesis? */
  eliminatingEvidence: string[];
  /** Evidence already gathered that relates to this hypothesis. */
  gatheredEvidence: Array<{ description: string; supports: boolean; weight: number }>;
}

export type EvidenceActionCost = "free" | "cheap" | "moderate" | "expensive";

export interface EvidenceAction {
  id: string;
  description: string;
  /** Which tool to call. */
  tool: string;
  args: Record<string, unknown>;
  /** Cost of this investigation. */
  cost: EvidenceActionCost;
  /** How many hypotheses this evidence can discriminate between. */
  discriminationPower: number;
  /** Which hypotheses this evidence is relevant to. */
  relevantHypotheses: string[];
}

export interface InvestigationState {
  id: string;
  issueNumber: number;
  repository: string;
  hypotheses: Hypothesis[];
  evidenceActions: EvidenceAction[];
  /** Actions already taken. */
  executedActions: Array<{ actionId: string; result: unknown; timestamp: string }>;
  /** The selected best action at each iteration. */
  investigationPath: string[];
  status: "active" | "concluded" | "budget_exhausted";
  conclusion?: InvestigationConclusion;
  createdAt: string;
}

export interface InvestigationConclusion {
  dominantHypothesis: string;
  confidence: number;
  reasoning: string;
  recommendedAction: string;
  evidenceChain: string[];
}

// ---------------------------------------------------------------------------
// Hypothesis generation
// ---------------------------------------------------------------------------

export interface IssueAnalysisForHypothesis {
  issueNumber: number;
  repository: string;
  title: string;
  body: string | null;
  labels: string[];
  hasLinkedPR: boolean;
  hasImplementationLink: boolean;
  hasDuplicateCandidate: boolean;
  hasRecentRelease: boolean;
  hasFailedReproduction: boolean;
  componentMatches: string[];
}

/**
 * Generate hypotheses from issue analysis.
 * Returns a set of competing explanations ordered by prior probability.
 */
export function generateHypotheses(input: IssueAnalysisForHypothesis): Hypothesis[] {
  const hypotheses: Hypothesis[] = [];

  // H1: Genuine unfixed bug
  hypotheses.push({
    id: "h-unfixed-bug",
    label: "Genuine Unfixed Bug",
    description: "The reported defect exists and has no active fix.",
    priorProbability: 0.4,
    posteriorProbability: 0.4,
    status: "active",
    confirmingEvidence: ["Reproduction confirms the bug", "Multiple reporters", "Error in recent logs"],
    eliminatingEvidence: ["Fix merged and deployed", "Cannot reproduce with complete coverage", "Confirmed duplicate"],
    gatheredEvidence: [],
  });

  // H2: Already fixed (awaiting verification)
  const fixedPrior = input.hasLinkedPR || input.hasImplementationLink ? 0.3 : 0.1;
  hypotheses.push({
    id: "h-already-fixed",
    label: "Already Fixed",
    description: "A fix exists (merged PR or deployed release) but hasn't been verified.",
    priorProbability: fixedPrior,
    posteriorProbability: fixedPrior,
    status: "active",
    confirmingEvidence: ["Merged PR references this issue", "Fix deployed to production", "Release notes mention fix"],
    eliminatingEvidence: ["No linked PRs", "No recent releases for this component", "Reproduction still fails after deployment"],
    gatheredEvidence: [],
  });

  // H3: Duplicate
  const dupPrior = input.hasDuplicateCandidate ? 0.25 : 0.1;
  hypotheses.push({
    id: "h-duplicate",
    label: "Duplicate Report",
    description: "This is a duplicate of an existing tracked issue.",
    priorProbability: dupPrior,
    posteriorProbability: dupPrior,
    status: "active",
    confirmingEvidence: ["High semantic similarity with open issue", "Same error signature", "Same component + same symptoms"],
    eliminatingEvidence: ["No similar issues found", "Different root cause confirmed", "Different component"],
    gatheredEvidence: [],
  });

  // H4: Regression from recent release
  const regressionPrior = input.hasRecentRelease ? 0.2 : 0.05;
  hypotheses.push({
    id: "h-regression",
    label: "Regression",
    description: "A recent release introduced or reintroduced this defect.",
    priorProbability: regressionPrior,
    posteriorProbability: regressionPrior,
    status: "active",
    confirmingEvidence: ["Issue appeared after specific release", "Related PR changed the affected component", "Previously fixed issue reopened"],
    eliminatingEvidence: ["Issue predates recent releases", "No code changes in affected area", "Confirmed present before latest release"],
    gatheredEvidence: [],
  });

  // H5: Cannot be verified (capability gap)
  hypotheses.push({
    id: "h-unsupported",
    label: "Verification Unsupported",
    description: "No automated verification capability exists for this issue class.",
    priorProbability: 0.05,
    posteriorProbability: 0.05,
    status: "active",
    confirmingEvidence: ["The reproduction provider reports unsupported", "Requires manual-only flow (OTP, KYC)", "Mobile-only issue"],
    eliminatingEvidence: ["The reproduction provider has a matching scenario", "Successfully reproduced or verified"],
    gatheredEvidence: [],
  });

  // Normalize probabilities
  const total = hypotheses.reduce((sum, h) => sum + h.priorProbability, 0);
  for (const h of hypotheses) {
    h.priorProbability /= total;
    h.posteriorProbability = h.priorProbability;
  }

  return hypotheses;
}

// ---------------------------------------------------------------------------
// Evidence selection (cheapest discriminating action)
// ---------------------------------------------------------------------------

const COST_ORDER: Record<EvidenceActionCost, number> = {
  free: 0,
  cheap: 1,
  moderate: 2,
  expensive: 3,
};

/**
 * Select the cheapest action that discriminates the most hypotheses.
 * Uses information gain heuristic: prefer actions that split the probability
 * mass most evenly (maximum entropy reduction).
 */
export function selectBestAction(
  hypotheses: Hypothesis[],
  availableActions: EvidenceAction[],
): EvidenceAction | null {
  const active = hypotheses.filter((h) => h.status === "active");
  if (active.length <= 1) return null; // Already concluded

  // Score each action: discrimination_power / cost
  const scored = availableActions
    .filter((a) => a.discriminationPower > 0)
    .map((a) => ({
      action: a,
      score: a.discriminationPower / (COST_ORDER[a.cost] + 1),
    }))
    .sort((a, b) => b.score - a.score);

  return scored[0]?.action ?? null;
}

/**
 * Update hypothesis probabilities after gathering evidence.
 * Simple Bayesian update: multiply by likelihood ratio.
 */
export function updateProbabilities(
  hypotheses: Hypothesis[],
  evidenceResult: { supports: string[]; contradicts: string[]; neutral: string[] },
): void {
  for (const h of hypotheses) {
    if (h.status !== "active") continue;

    let factor = 1.0;
    if (evidenceResult.supports.includes(h.id)) {
      factor = 2.0; // Evidence supports this hypothesis
      h.gatheredEvidence.push({ description: "supporting evidence", supports: true, weight: 0.7 });
    } else if (evidenceResult.contradicts.includes(h.id)) {
      factor = 0.3; // Evidence contradicts this hypothesis
      h.gatheredEvidence.push({ description: "contradicting evidence", supports: false, weight: 0.7 });
    }

    h.posteriorProbability *= factor;
  }

  // Normalize
  const total = hypotheses.reduce((sum, h) => sum + (h.status === "active" ? h.posteriorProbability : 0), 0);
  if (total > 0) {
    for (const h of hypotheses) {
      if (h.status === "active") {
        h.posteriorProbability /= total;
      }
    }
  }

  // Eliminate hypotheses below threshold
  for (const h of hypotheses) {
    if (h.status === "active" && h.posteriorProbability < 0.05) {
      h.status = "eliminated";
    }
  }

  // Confirm hypothesis above threshold
  const dominant = hypotheses.filter((h) => h.status === "active").sort((a, b) => b.posteriorProbability - a.posteriorProbability)[0];
  if (dominant && dominant.posteriorProbability > 0.75) {
    dominant.status = "confirmed";
  }
}

/**
 * Check if the investigation has concluded.
 */
export function isInvestigationConcluded(hypotheses: Hypothesis[]): InvestigationConclusion | null {
  const confirmed = hypotheses.find((h) => h.status === "confirmed");
  if (confirmed) {
    return {
      dominantHypothesis: confirmed.label,
      confidence: confirmed.posteriorProbability,
      reasoning: `Hypothesis "${confirmed.label}" confirmed with ${(confirmed.posteriorProbability * 100).toFixed(0)}% posterior probability.`,
      recommendedAction: getRecommendedAction(confirmed.id),
      evidenceChain: confirmed.gatheredEvidence.map((e) => e.description),
    };
  }

  const active = hypotheses.filter((h) => h.status === "active");
  if (active.length === 1) {
    return {
      dominantHypothesis: active[0].label,
      confidence: active[0].posteriorProbability,
      reasoning: `Only remaining hypothesis: "${active[0].label}" (all others eliminated).`,
      recommendedAction: getRecommendedAction(active[0].id),
      evidenceChain: active[0].gatheredEvidence.map((e) => e.description),
    };
  }

  return null;
}

function getRecommendedAction(hypothesisId: string): string {
  switch (hypothesisId) {
    case "h-unfixed-bug": return "Run reproduction verification to confirm, then triage and assign.";
    case "h-already-fixed": return "Verify deployment, then schedule retest or close.";
    case "h-duplicate": return "Link to canonical issue, consolidate evidence, close as duplicate.";
    case "h-regression": return "Create regression issue with raised priority, link to original fix.";
    case "h-unsupported": return "Record capability gap, route to manual investigation.";
    default: return "Continue investigation with additional evidence.";
  }
}
