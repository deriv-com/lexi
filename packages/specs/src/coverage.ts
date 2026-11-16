import type { CoverageDimension, CoverageEntry, CoverageRecord, CoverageStatus } from "@lexi/contracts";
import { COVERAGE_DIMENSIONS } from "./coverage-dimensions";

/**
 * The coverage engine — machine-readable clarification state.
 *
 * Coverage is held as structured state rather than prose so that two rules can
 * be enforced by code instead of by asking the model to behave:
 *
 *   1. `isReadyToDraft()` is a deterministic function of this record, with no
 *      LLM call in the loop.
 *   2. A dimension that is already covered or explicitly deferred is never
 *      re-asked, however the conversation drifts.
 *
 * Relationship to the frozen contract: `@lexi/contracts` freezes a three-value
 * `CoverageStatus` (`open | covered | deferred`) with no confidence. The spec
 * pipeline needs four states and a confidence, so `SpecCoverageEntry` *extends* the
 * frozen entry: it adds `state`, `confidence` and `notes`, and keeps `status`
 * populated as a derived mirror. Every record here is therefore still a valid
 * `CoverageRecord`, which is what `SpecSession.coverage` persists and what
 * `ThreadState.coverage` carries — no other stream has to know about the
 * richer shape to read it correctly.
 */

/**
 * The four-state machine the clarification loop reasons over.
 *
 * `PARTIAL` is the state that earns its keep: "they mentioned mobile but not
 * which OS versions" is neither unknown nor answered, and collapsing it into
 * either one would make Lexi re-ask from scratch or stop asking too early.
 */
export type CoverageState = "UNKNOWN" | "PARTIAL" | "COVERED" | "EXPLICITLY_DEFERRED";

export interface SpecCoverageEntry extends CoverageEntry {
  state: CoverageState;
  /** 0..1. Only meaningful for `COVERED`; forced to 0 for `UNKNOWN`. */
  confidence: number;
  /** The actual answer, in the user's words where possible. Feeds rendering. */
  notes?: string;
}

export interface SpecCoverageRecord extends CoverageRecord {
  dimensions: Partial<Record<CoverageDimension, SpecCoverageEntry>>;
}

/** What a caller may set. `status` is never passed — it is always derived. */
export interface CoverageUpdate {
  state: CoverageState;
  confidence?: number;
  evidence?: string;
  sourceTurnId?: string;
  notes?: string;
  reason?: string;
}

/** The frozen three-value status, derived from the richer state. */
export function coverageStatusFor(state: CoverageState): CoverageStatus {
  switch (state) {
    case "COVERED":
      return "covered";
    case "EXPLICITLY_DEFERRED":
      return "deferred";
    case "PARTIAL":
    case "UNKNOWN":
      return "open";
  }
}

function clampConfidence(value: number | undefined, state: CoverageState): number {
  // An unknown dimension cannot be confident about anything, whatever the
  // caller passed — otherwise a mis-set confidence could satisfy the readiness
  // threshold for a dimension nobody has answered.
  if (state === "UNKNOWN") return 0;
  // A direct answer defaults to certain; callers inferring from the thread are
  // expected to pass a lower number explicitly.
  const raw = value ?? 1;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(0, raw));
}

function entry(state: CoverageState, update: Omit<CoverageUpdate, "state"> = {}): SpecCoverageEntry {
  return {
    state,
    status: coverageStatusFor(state),
    confidence: clampConfidence(update.confidence, state),
    ...(update.evidence !== undefined ? { evidence: update.evidence } : {}),
    ...(update.sourceTurnId !== undefined ? { sourceTurnId: update.sourceTurnId } : {}),
    ...(update.notes !== undefined ? { notes: update.notes } : {}),
    ...(update.reason !== undefined ? { reason: update.reason } : {}),
  };
}

/** A fresh session: nine dimensions, all unknown, no questions asked yet. */
export function createCoverageRecord(): SpecCoverageRecord {
  const dimensions: Partial<Record<CoverageDimension, SpecCoverageEntry>> = {};
  for (const dimension of COVERAGE_DIMENSIONS) {
    dimensions[dimension] = entry("UNKNOWN");
  }
  return { dimensions, questionTurns: 0, readyToDraft: false };
}

/**
 * Returns a new record with one dimension updated. Immutable so a caller can
 * diff before/after — which is how the question policy tells whether a turn
 * actually made progress or just burned a round.
 */
export function recordCoverage(
  record: SpecCoverageRecord,
  dimension: CoverageDimension,
  update: CoverageUpdate,
): SpecCoverageRecord {
  return {
    ...record,
    dimensions: { ...record.dimensions, [dimension]: entry(update.state, update) },
  };
}

/**
 * Marks a dimension as deliberately out of scope. Counts as satisfied by
 * `isReadyToDraft`, so the reason is mandatory: an unexplained deferral is how
 * scope quietly reappears three weeks later as "we never agreed that".
 */
export function deferDimension(
  record: SpecCoverageRecord,
  dimension: CoverageDimension,
  reason: string,
): SpecCoverageRecord {
  if (!reason || reason.trim().length === 0) {
    throw new Error(`Cannot defer coverage dimension "${dimension}" without a reason.`);
  }
  return recordCoverage(record, dimension, {
    state: "EXPLICITLY_DEFERRED",
    confidence: 0,
    reason: reason.trim(),
  });
}

/**
 * Whether a dimension no longer needs asking: covered at or above the policy
 * threshold, or explicitly deferred by the user.
 *
 * A low-confidence `COVERED` is deliberately *not* settled. That is the line
 * between an answer and a guess, and drawing it here is what stops the loop
 * from declaring victory over an inference nobody confirmed.
 */
export function isDimensionSettled(
  entryOrUndefined: SpecCoverageEntry | undefined,
  minConfidence: number,
): boolean {
  if (!entryOrUndefined) return false;
  if (entryOrUndefined.state === "EXPLICITLY_DEFERRED") return true;
  if (entryOrUndefined.state !== "COVERED") return false;
  return entryOrUndefined.confidence >= minConfidence;
}

/** Settled dimensions, in frozen policy order. */
export function settledDimensions(record: SpecCoverageRecord, minConfidence: number): CoverageDimension[] {
  return COVERAGE_DIMENSIONS.filter((dimension) =>
    isDimensionSettled(record.dimensions[dimension], minConfidence),
  );
}

/** Dimensions still worth a question, in frozen policy order. */
export function openDimensions(record: SpecCoverageRecord, minConfidence: number): CoverageDimension[] {
  return COVERAGE_DIMENSIONS.filter(
    (dimension) => !isDimensionSettled(record.dimensions[dimension], minConfidence),
  );
}

/** Back-fills `state` for an entry persisted in the frozen three-value shape. */
function stateFromStatus(status: unknown): CoverageState {
  switch (status) {
    case "covered":
      return "COVERED";
    case "deferred":
      return "EXPLICITLY_DEFERRED";
    default:
      return "UNKNOWN";
  }
}

/**
 * Rehydrates a record read back from `SpecSession.coverage`, which is `Json`
 * and therefore arrives as `unknown`.
 *
 * Tolerates three inputs on purpose: a full spec-pipeline record, a shared-shape
 * record written by another package (no `state` — back-filled from `status`),
 * and junk. Unknown dimension keys are dropped rather than carried, so a typo
 * upstream cannot invent a tenth dimension that nothing can ever satisfy.
 */
export function normalizeCoverageRecord(raw: unknown): SpecCoverageRecord {
  const source = (raw ?? {}) as Partial<SpecCoverageRecord> & { dimensions?: unknown };
  const rawDimensions = (source.dimensions ?? {}) as Record<string, unknown>;
  const dimensions: Partial<Record<CoverageDimension, SpecCoverageEntry>> = {};

  for (const dimension of COVERAGE_DIMENSIONS) {
    const candidate = rawDimensions[dimension] as Partial<SpecCoverageEntry> | undefined;
    if (!candidate || typeof candidate !== "object") {
      dimensions[dimension] = entry("UNKNOWN");
      continue;
    }

    const state: CoverageState =
      candidate.state && isCoverageState(candidate.state)
        ? candidate.state
        : stateFromStatus(candidate.status);

    dimensions[dimension] = entry(state, {
      confidence: candidate.confidence,
      evidence: candidate.evidence,
      sourceTurnId: candidate.sourceTurnId,
      notes: candidate.notes,
      reason: candidate.reason,
    });
  }

  // Keys outside the frozen nine are discarded by construction: the loop above
  // reads only the known dimensions, so a stray key is never copied across.
  const questionTurns = Number.isInteger(source.questionTurns) ? (source.questionTurns as number) : 0;

  return {
    dimensions,
    questionTurns: Math.max(0, questionTurns),
    readyToDraft: source.readyToDraft === true,
  };
}

function isCoverageState(value: unknown): value is CoverageState {
  return (
    value === "UNKNOWN" || value === "PARTIAL" || value === "COVERED" || value === "EXPLICITLY_DEFERRED"
  );
}
