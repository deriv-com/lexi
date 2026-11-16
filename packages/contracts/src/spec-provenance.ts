/**
 * Spec provenance — the exit gate's frozen surface.
 *
 * The pipeline has an ENTRANCE gate: `trigger_code_task(feature)` refuses
 * to dispatch without an approved spec at a referenced revision. Nothing checked
 * the other end. `packages/workflows` contained no reference to `specId` or
 * `specRevision` at all, so an approved spec authorised work and was then never
 * consulted again — the classic drift the spec-driven model exists to close:
 * the implementation and its tests can encode the same misreading and both pass.
 *
 * This module is types only. It is the seam between two independently built
 * halves, and it is deliberately narrow:
 *
 *   - the WRITE half records what the entrance gate resolved, at the moment it
 *     resolved it (see `SpecProvenance`);
 *   - the READ half reconstructs expectations from that exact revision and
 *     compares them with what was built (see `SpecConformanceReport`).
 *
 * Storage needs no migration. `WorkItem.specId` and `WorkItem.metadata` (Json)
 * already exist; `QuickFixAttempt.workItemId` already links the fix chain, so a
 * PR can reach its authorising spec through the work item.
 */

/**
 * What the entrance gate resolved, captured at authorisation time.
 *
 * Recorded rather than re-derived. Re-resolving "the current approved revision"
 * at verification time would silently follow a post-approval redraft, which is
 * precisely the drift being detected — the check would agree with whatever the
 * spec says *now* and never notice that it changed after the work was
 * authorised. `contentHash` is what makes that detectable: it pins the bytes
 * that were approved, not the pointer to them.
 */
export interface SpecProvenance {
  /** SpecSession/SpecDocument id that authorised the work. */
  specId: string;
  /** The revision that was approved — not `latest`. */
  revision: number;
  /** Hash of the approved body. A later redraft changes this. */
  contentHash: string;
  /** ISO-8601. When approval was granted. */
  approvedAt: string;
  /** Slack id of the human approver. Automation cannot approve (`humanOnly`). */
  approvedBy: string;
}

/** Where a verification verdict came from, so a report is never anonymous. */
export type ConformanceSource = "spec_provenance" | "unverifiable";

/**
 * A single point of comparison between approved intent and built artefact.
 *
 * Five statuses, not a binary match/mismatch:
 *   - `satisfied` — required and present as specified
 *   - `diverged` — required, but implemented differently
 *   - `missing` — required by the spec, not in the artefact
 *   - `extra` — in the artefact, no spec requirement (reopens the spec)
 *   - `indeterminate` — honest "I could not tell"; never a false pass
 *
 * Collapsing `extra` into `diverged` would send more code to the Executor
 * instead of returning the finding to the Planner.
 */
export interface ConformancePoint {
  /**
   * The requirement, quoted or closely paraphrased from the approved spec.
   * For `extra`, this names the observed behaviour that no requirement asks for.
   */
  requirement: string;
  /** Coverage dimension it came from, when attributable. */
  dimension?: string;
  status: "satisfied" | "diverged" | "extra" | "missing" | "indeterminate";
  /** What was actually built, in the evidence's terms. */
  observed?: string;
  /** Files/PRs the judgement rests on. Never empty for `diverged`, `extra`, or `missing`. */
  evidence?: string[];
}

/**
 * The verifier's output.
 *
 * REPORT, NOT GATE. This never blocks a merge or a deploy. `evaluateSpecGate`
 * contains no model judgement by design, and humans own the production gate —
 * a model-driven verdict that could fail a PR would put model judgement in a
 * governance position the architecture refuses it. Drift is surfaced to a
 * human, who decides.
 */
export interface SpecConformanceReport {
  workItemId: string;
  /** Absent when `source` is `unverifiable`. */
  provenance?: SpecProvenance;
  source: ConformanceSource;
  /**
   * True only when the spec body still hashes to `provenance.contentHash`.
   * False means the spec was redrafted after it authorised this work, so the
   * comparison is against the text that was approved, not the text that exists.
   */
  specUnchangedSinceApproval: boolean;
  points: ConformancePoint[];
  /** Roll-up. `unverifiable` when provenance is missing — never `satisfied`. */
  verdict: "conforms" | "drifted" | "indeterminate" | "unverifiable";
  /** One human-readable paragraph. Safe to post to Slack unedited. */
  summary: string;
}
