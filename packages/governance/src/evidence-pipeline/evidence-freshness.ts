/**
 * Evidence freshness tracking.
 * Old evidence loses weight over time and may trigger re-investigation.
 */

export interface EvidenceFreshness {
  evidenceObservedAt?: Date;
  codeCheckedAt?: Date;
  prCheckedAt?: Date;
  releaseCheckedAt?: Date;
  lastReproducedAt?: Date;
  staleness: "fresh" | "aging" | "stale";
}

export interface FreshnessConfig {
  /** Days before evidence is "aging" (default: 7) */
  agingThresholdDays: number;
  /** Days before evidence is "stale" (default: 30) */
  staleThresholdDays: number;
}

const DEFAULT_FRESHNESS_CONFIG: FreshnessConfig = {
  agingThresholdDays: 7,
  staleThresholdDays: 30,
};

/**
 * Evaluate how fresh the most recent evidence is.
 * Returns the staleness level based on the newest relevant timestamp.
 */
export function evaluateEvidenceFreshness(
  timestamps: Partial<Omit<EvidenceFreshness, "staleness">>,
  config: FreshnessConfig = DEFAULT_FRESHNESS_CONFIG,
): EvidenceFreshness {
  const now = Date.now();
  const allDates = [
    timestamps.evidenceObservedAt,
    timestamps.codeCheckedAt,
    timestamps.prCheckedAt,
    timestamps.releaseCheckedAt,
    timestamps.lastReproducedAt,
  ].filter((d): d is Date => d instanceof Date);

  if (allDates.length === 0) {
    return { ...timestamps, staleness: "stale" };
  }

  const mostRecent = Math.max(...allDates.map((d) => d.getTime()));
  const ageInDays = (now - mostRecent) / (1000 * 60 * 60 * 24);

  let staleness: "fresh" | "aging" | "stale";
  if (ageInDays <= config.agingThresholdDays) {
    staleness = "fresh";
  } else if (ageInDays <= config.staleThresholdDays) {
    staleness = "aging";
  } else {
    staleness = "stale";
  }

  return {
    ...timestamps,
    staleness,
  };
}

/**
 * Compute a decay multiplier for evidence weight based on age.
 * Fresh evidence: 1.0, aging: linear decay, stale: 0.3 floor.
 */
export function evidenceDecayFactor(
  observedAt: Date,
  config: FreshnessConfig = DEFAULT_FRESHNESS_CONFIG,
): number {
  const ageInDays = (Date.now() - observedAt.getTime()) / (1000 * 60 * 60 * 24);

  if (ageInDays <= config.agingThresholdDays) return 1.0;
  if (ageInDays >= config.staleThresholdDays) return 0.3;

  // Linear decay between aging and stale thresholds
  const range = config.staleThresholdDays - config.agingThresholdDays;
  const elapsed = ageInDays - config.agingThresholdDays;
  return 1.0 - (elapsed / range) * 0.7; // Decays from 1.0 to 0.3
}
