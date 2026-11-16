/**
 * Calibrated candidate similarity — a real 0-1 measure of how alike two issues
 * are, computed from the per-tier scores hybrid retrieval already produces.
 *
 * WHY THIS EXISTS
 *
 * `hybridRetrieval` ranks candidates with reciprocal rank fusion:
 * `weight / (60 + rank + 1)`. With the tier weights summing to 1.0, a candidate
 * ranked FIRST in all three tiers scores at most `1.0 / 61 ≈ 0.0164`. That
 * number was being passed to the adjudicators as `similarity`, and every
 * adjudicator thresholds `similarity` at >= 0.75 for DUPLICATE and >= 0.5 for
 * POSSIBLE_DUPLICATE. The scales never meet, so the pipeline could not return a
 * duplicate verdict for any input at all — including a byte-identical issue.
 *
 * The repair is NOT to move the thresholds down onto the RRF scale. An RRF
 * score encodes RANK, not likeness: a candidate ranked #1 in one tier scores
 * `0.35/61` whether it is a perfect match or the least-bad of three terrible
 * ones. Thresholding it would produce a deduplicator that fires on the best
 * available candidate regardless of quality — worse than one that never fires,
 * because it acts.
 *
 * So RRF keeps the job it is good at (ordering), and likeness is computed here
 * from `tierScores`, which really are 0-1 similarity measures:
 *
 *   structured — confidence that an exact shared signal (title, error
 *                signature, URL, route) indicates the same defect
 *   lexical    — Jaccard token overlap between the two issue texts
 *   semantic   — cosine similarity between the two embeddings
 *
 * DESIGN
 *
 * Two ideas, kept separate on purpose.
 *
 * 1. AGREEMENT — a weighted mean of the tiers that actually scored the
 *    candidate. Semantic is weighted highest because it is the only tier that
 *    sees past vocabulary; structured lowest because its confidences are
 *    evidence strengths for heterogeneous signals (a shared `/cashier` route is
 *    much weaker than an identical title) and a single strong structured hit
 *    should not by itself carry a verdict.
 *
 * 2. CORROBORATION — how much of the evidence that COULD have spoken did.
 *    One tier calling two issues alike is weaker than three tiers agreeing, so
 *    the agreement score is damped by coverage. The damping is deliberately
 *    gentle (floor 0.75): missing structured evidence is the normal case, since
 *    most genuine duplicates share no error signature or exact title.
 *
 * The distinction that matters for correctness is SILENT vs UNAVAILABLE. A tier
 * that ran and did not match is weak evidence against the candidate. A tier
 * that could not run — a degraded pgvector index, semantic disabled by flag —
 * is no evidence at all, and must not be charged against the candidate, or
 * every duplicate silently gets harder to detect exactly when the index breaks.
 * `semanticAvailable` carries that distinction in from the tier's health check.
 */

export interface CandidateTierScores {
  /** Confidence of the best exact structured signal (0-1). */
  structured?: number;
  /** Lexical token-overlap similarity (0-1). */
  lexical?: number;
  /** Semantic embedding cosine similarity (0-1). */
  semantic?: number;
}

export interface CandidateSimilarityOptions {
  /**
   * Whether the semantic tier was able to run at all. False when the vector
   * index is disabled or degraded. A tier that could not run is excluded from
   * the corroboration denominator rather than counted as missing evidence.
   */
  semanticAvailable: boolean;
  /** Override the tier weights. Defaults to {@link DEFAULT_SIMILARITY_WEIGHTS}. */
  weights?: CandidateSimilarityWeights;
  /**
   * Lowest corroboration multiplier, applied when only the least-weighted
   * single tier spoke. Defaults to {@link DEFAULT_CORROBORATION_FLOOR}.
   */
  corroborationFloor?: number;
}

export interface CandidateSimilarityWeights {
  structured: number;
  lexical: number;
  semantic: number;
}

/**
 * Semantic is trusted most because it is the only tier that recognises a
 * duplicate phrased in different words — the case lexical overlap cannot see.
 * Structured is trusted least per-point because its confidences span signals of
 * very different strength.
 */
export const DEFAULT_SIMILARITY_WEIGHTS: CandidateSimilarityWeights = {
  structured: 0.25,
  lexical: 0.35,
  semantic: 0.40,
};

/**
 * A candidate corroborated by a single tier retains 75% of its agreement score.
 * Chosen so that a strong single-tier signal can still reach the
 * POSSIBLE_DUPLICATE band (and therefore human review) while needing genuine
 * multi-tier agreement to reach the auto-reject band.
 */
export const DEFAULT_CORROBORATION_FLOOR = 0.75;

/** The largest value reciprocal rank fusion can produce, for reference in tests and logs. */
export const RRF_SCORE_CEILING = 1 / 61;

/**
 * Compute a calibrated 0-1 similarity for one retrieval candidate.
 *
 * Returns 0 when no tier scored the candidate: no evidence is not weak
 * evidence, and a candidate nothing matched is not similar to anything.
 */
export function computeCandidateSimilarity(
  tierScores: CandidateTierScores,
  options: CandidateSimilarityOptions,
): number {
  const weights = options.weights ?? DEFAULT_SIMILARITY_WEIGHTS;
  const floor = options.corroborationFloor ?? DEFAULT_CORROBORATION_FLOOR;

  // Structured and lexical always run — they operate over the corpus rows the
  // caller supplied. Only the semantic tier can be absent as a capability.
  const availableWeight =
    weights.structured + weights.lexical + (options.semanticAvailable ? weights.semantic : 0);

  if (availableWeight <= 0) return 0;

  let weightedSum = 0;
  let observedWeight = 0;

  const contribute = (score: number | undefined, weight: number): void => {
    if (score === undefined || Number.isNaN(score)) return;
    const clamped = Math.min(1, Math.max(0, score));
    weightedSum += clamped * weight;
    observedWeight += weight;
  };

  contribute(tierScores.structured, weights.structured);
  contribute(tierScores.lexical, weights.lexical);
  // A semantic score present while the tier reports unavailable is still real
  // data, so it is counted; the availability flag only governs the denominator.
  contribute(tierScores.semantic, weights.semantic);

  if (observedWeight <= 0) return 0;

  // How much the tiers that spoke agree the two issues are alike.
  const agreement = weightedSum / observedWeight;

  // How much of the evidence that could have spoken actually did. Capped at 1
  // so a semantic hit arriving while the index reports degraded cannot inflate
  // the score above full corroboration.
  const coverage = Math.min(1, observedWeight / availableWeight);
  const corroboration = floor + (1 - floor) * coverage;

  return clamp01(agreement * corroboration);
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
