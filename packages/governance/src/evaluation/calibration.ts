/**
 * Calibration Analysis — validate confidence scores correspond to actual correctness.
 *
 * A well-calibrated system means: when Lexi says "90% confidence," it should
 * be correct ~90% of the time. If it says 90% but is only correct 60% of the
 * time, the confidence is overconfident and cannot be trusted for policy gates.
 */

export interface CalibrationBucket {
  /** Lower bound of confidence range (inclusive). */
  rangeStart: number;
  /** Upper bound of confidence range (exclusive). */
  rangeEnd: number;
  /** Number of decisions in this bucket. */
  count: number;
  /** Number that were actually correct. */
  correct: number;
  /** Actual accuracy in this bucket. */
  accuracy: number;
  /** Expected accuracy (midpoint of the confidence range). */
  expectedAccuracy: number;
  /** Calibration error for this bucket. */
  error: number;
}

export interface CalibrationReport {
  totalDecisions: number;
  buckets: CalibrationBucket[];
  /** Expected Calibration Error (lower = better, 0 = perfectly calibrated). */
  ece: number;
  /** Maximum Calibration Error (worst bucket). */
  mce: number;
  /** Is the system overconfident on average? */
  overconfident: boolean;
  /** Is the system underconfident on average? */
  underconfident: boolean;
  /** Summary interpretation. */
  interpretation: string;
}

export interface CalibrationSample {
  confidence: number;
  correct: boolean;
}

/**
 * Compute calibration metrics from a set of confidence/correctness pairs.
 */
export function computeCalibration(samples: CalibrationSample[], numBuckets = 10): CalibrationReport {
  if (samples.length === 0) {
    return {
      totalDecisions: 0,
      buckets: [],
      ece: 0,
      mce: 0,
      overconfident: false,
      underconfident: false,
      interpretation: "No samples available for calibration.",
    };
  }

  const bucketSize = 1.0 / numBuckets;
  const buckets: CalibrationBucket[] = [];

  for (let i = 0; i < numBuckets; i++) {
    const rangeStart = i * bucketSize;
    const rangeEnd = (i + 1) * bucketSize;
    const inBucket = samples.filter((s) => s.confidence >= rangeStart && s.confidence < rangeEnd);

    const count = inBucket.length;
    const correct = inBucket.filter((s) => s.correct).length;
    const accuracy = count > 0 ? correct / count : 0;
    const expectedAccuracy = (rangeStart + rangeEnd) / 2;
    const error = Math.abs(accuracy - expectedAccuracy);

    buckets.push({ rangeStart, rangeEnd, count, correct, accuracy, expectedAccuracy, error });
  }

  // ECE: weighted average of bucket errors
  const ece = buckets.reduce((sum, b) => sum + (b.count / samples.length) * b.error, 0);

  // MCE: maximum bucket error (only for buckets with samples)
  const populatedBuckets = buckets.filter((b) => b.count > 0);
  const mce = populatedBuckets.length > 0 ? Math.max(...populatedBuckets.map((b) => b.error)) : 0;

  // Direction: is the system systematically over or under confident?
  const avgConfidence = samples.reduce((sum, s) => sum + s.confidence, 0) / samples.length;
  const avgAccuracy = samples.filter((s) => s.correct).length / samples.length;
  const overconfident = avgConfidence > avgAccuracy + 0.05;
  const underconfident = avgAccuracy > avgConfidence + 0.05;

  let interpretation: string;
  if (ece < 0.05) {
    interpretation = "Well calibrated. Confidence scores correspond to actual correctness.";
  } else if (ece < 0.1) {
    interpretation = `Moderately calibrated (ECE=${ece.toFixed(3)}). ${overconfident ? "Tends to be overconfident." : underconfident ? "Tends to be underconfident." : "No strong directional bias."}`;
  } else {
    interpretation = `Poorly calibrated (ECE=${ece.toFixed(3)}). ${overconfident ? "OVERCONFIDENT: confidence scores cannot be trusted for policy gates." : "UNDERCONFIDENT: system is better than it thinks."}`;
  }

  return {
    totalDecisions: samples.length,
    buckets,
    ece,
    mce,
    overconfident,
    underconfident,
    interpretation,
  };
}
