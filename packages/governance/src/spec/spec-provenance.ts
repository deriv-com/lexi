/**
 * Spec provenance — the WRITE half of the spec exit gate.
 *
 * The spec gate gave the pipeline an ENTRANCE gate: `evaluateQuickFixEligibility`
 * refuses a feature dispatch without an approved spec at the referenced
 * revision. There was no exit gate — nothing downstream ever consulted the
 * spec again, so an approved document authorised work and then dropped out of
 * the record entirely.
 *
 * This module holds the two halves of closing that: the pure builder that
 * turns what the entrance gate RESOLVED into a `SpecProvenance`, and the read
 * helper the verifier uses to get it back from a work item.
 *
 * The whole design rests on one rule: RECORD, DO NOT RE-DERIVE. A reader that
 * asks "what is the current approved revision of spec X" silently follows a
 * post-approval redraft, which is the exact drift the exit gate exists to
 * catch — it would agree with whatever the spec says now and never notice it
 * changed after the work was authorised. `contentHash` is what makes the
 * change detectable, so a provenance record without one is refused rather
 * than written: it would pin a pointer instead of the approved bytes and read
 * as clean while proving nothing.
 */

import type { SpecProvenance } from "@lexi/contracts";

/**
 * Statuses recognised as approved, mirroring `evaluateFeatureSpecGate`'s
 * `APPROVED_STATUS`. The builder re-checks rather than trusting the caller:
 * it is the last point before bytes are persisted as an authorisation record.
 */
const APPROVED_STATUS = "APPROVED";

/**
 * Where the capture stands for one work item.
 *
 * `NOT_REQUIRED` and `MISSING` are deliberately distinct. Both mean "no
 * provenance here", but only one is a finding: a chore or bug legitimately has
 * no spec, while a feature that dispatched without recording one is a hole in
 * the audit chain. Collapsing them would make every hole look like a clean
 * chore, which is the failure this whole module exists to prevent.
 */
export const SPEC_PROVENANCE_STATUS = {
  RECORDED: "recorded",
  MISSING: "missing",
  NOT_REQUIRED: "not_required",
} as const;

export type SpecProvenanceStatus =
  (typeof SPEC_PROVENANCE_STATUS)[keyof typeof SPEC_PROVENANCE_STATUS];

/** `WorkItem.metadata` keys this module owns. */
export const SPEC_PROVENANCE_METADATA_KEY = "specProvenance";
export const SPEC_PROVENANCE_STATUS_METADATA_KEY = "specProvenanceStatus";

/**
 * The entrance gate's resolved evidence, as the capture point sees it.
 *
 * Structurally identical to `SpecEvidencePort`'s return plus the approval
 * facts (`contentHash`, `approvedAt`, `approvedBy`) read from the same
 * approved `SpecDocument` row the gate validated. They are optional because
 * an older store may not surface them — and an absence must produce a legible
 * `MISSING`, not a fabricated record.
 */
export interface ResolvedSpecEvidence {
  specId: string;
  approvedRevision: number | null;
  status: string;
  contentHash?: string | undefined;
  approvedAt?: string | undefined;
  approvedBy?: string | undefined;
  supersededById?: string | null | undefined;
}

/**
 * The slice of Prisma this module reads. Narrow on purpose: a read helper the
 * verifier calls should not be able to write, and a structural port keeps the
 * helper unit-testable without a database. `PrismaService` satisfies it.
 */
export interface SpecProvenanceWorkItemStore {
  workItem: {
    findUnique(args: {
      where: { id: string };
    }): Promise<{ specId?: string | null; metadata?: unknown } | null>;
  };
}

/**
 * What a work item says about its authorising spec.
 *
 * `unknown_work_item` is separate from `MISSING` because "this id resolves to
 * nothing" is a different problem from "this work item was dispatched without
 * provenance", and a verifier reporting the second when it means the first is
 * reporting a governance failure that did not happen.
 */
export type SpecProvenanceRecord =
  | { status: typeof SPEC_PROVENANCE_STATUS.RECORDED; provenance: SpecProvenance }
  | { status: typeof SPEC_PROVENANCE_STATUS.MISSING }
  | { status: typeof SPEC_PROVENANCE_STATUS.NOT_REQUIRED }
  | { status: "unknown_work_item" };

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates a persisted blob back into a `SpecProvenance`.
 *
 * Applied on the read side as well as the write side because a half-written
 * record is not provenance: handing one back would let a verifier believe it
 * had pinned bytes it never had, and report `conforms` off a hash that is not
 * there.
 */
function parseProvenance(value: unknown): SpecProvenance | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;

  if (!nonBlank(candidate.specId)) return null;
  if (typeof candidate.revision !== "number" || !Number.isFinite(candidate.revision)) return null;
  if (!nonBlank(candidate.contentHash)) return null;
  if (!nonBlank(candidate.approvedAt)) return null;
  if (!nonBlank(candidate.approvedBy)) return null;

  return {
    specId: candidate.specId,
    revision: candidate.revision,
    contentHash: candidate.contentHash,
    approvedAt: candidate.approvedAt,
    approvedBy: candidate.approvedBy,
  };
}

/**
 * Turn the entrance gate's resolution into a provenance record.
 *
 * Pure, and deliberately unable to look anything up — the only way it can
 * describe a spec is from evidence the caller already resolved. That is what
 * makes "record, do not re-derive" structural rather than a convention.
 *
 * `revision` comes from `evidence.approvedRevision`, never from the caller's
 * `reference.revision`. The gate has already proved they are equal whenever it
 * passed, so today they agree; sourcing it from the claim would mean any future
 * loosening of the gate silently records a revision nobody approved.
 *
 * Returns `null` — never a partial record — when the evidence cannot support a
 * complete one. The caller must surface that as `MISSING`.
 */
export function buildSpecProvenance(input: {
  reference: { specId: string; revision: number };
  evidence: ResolvedSpecEvidence | null | undefined;
}): SpecProvenance | null {
  const { reference, evidence } = input;
  if (!evidence) return null;
  if (evidence.specId !== reference.specId) return null;
  if (evidence.status !== APPROVED_STATUS) return null;
  if (typeof evidence.approvedRevision !== "number") return null;

  return parseProvenance({
    specId: evidence.specId,
    revision: evidence.approvedRevision,
    contentHash: evidence.contentHash,
    approvedAt: evidence.approvedAt,
    approvedBy: evidence.approvedBy,
  });
}

/**
 * The `WorkItem.metadata` fragment for one capture.
 *
 * Always writes a status, including when there is no provenance — an absent
 * status is indistinguishable from a work item written before this existed,
 * and silence is what the exit gate is here to stop.
 *
 * `specRequired: false` is how a bug or chore says "no spec was needed"
 * without manufacturing one.
 */
export function specProvenanceMetadata(
  provenance: SpecProvenance | null,
  options?: { specRequired?: boolean },
): Record<string, unknown> {
  if (options?.specRequired === false) {
    return { [SPEC_PROVENANCE_STATUS_METADATA_KEY]: SPEC_PROVENANCE_STATUS.NOT_REQUIRED };
  }
  if (!provenance) {
    return { [SPEC_PROVENANCE_STATUS_METADATA_KEY]: SPEC_PROVENANCE_STATUS.MISSING };
  }
  return {
    [SPEC_PROVENANCE_STATUS_METADATA_KEY]: SPEC_PROVENANCE_STATUS.RECORDED,
    [SPEC_PROVENANCE_METADATA_KEY]: provenance,
  };
}

/**
 * The verifier's entry point: the provenance recorded for a work item, or
 * `null` when there is none to be had.
 *
 * A PR reaches this through `QuickFixAttempt.workItemId`. Use
 * {@link loadSpecProvenanceRecord} when the reason for a `null` matters — this
 * one cannot distinguish "no spec was required" from "a spec was required and
 * is missing", and those are not the same finding.
 */
export async function loadSpecProvenance(
  store: SpecProvenanceWorkItemStore,
  workItemId: string,
): Promise<SpecProvenance | null> {
  if (!nonBlank(workItemId)) return null;

  const row = await store.workItem.findUnique({ where: { id: workItemId } });
  if (!row || !row.metadata || typeof row.metadata !== "object") return null;

  const metadata = row.metadata as Record<string, unknown>;
  return parseProvenance(metadata[SPEC_PROVENANCE_METADATA_KEY]);
}

/**
 * The status-carrying read: what the work item claims, verified against what
 * it actually holds.
 *
 * Two deliberate downgrades:
 *   - a work item with no status at all reads as `MISSING`, not
 *     `NOT_REQUIRED`. Anything written before this capture existed carries no
 *     status, and defaulting to `NOT_REQUIRED` would silently absolve every
 *     feature dispatch that predates the exit gate.
 *   - a status claiming `RECORDED` over a blob that will not parse also reads
 *     as `MISSING`. The claim is not the evidence.
 */
export async function loadSpecProvenanceRecord(
  store: SpecProvenanceWorkItemStore,
  workItemId: string,
): Promise<SpecProvenanceRecord> {
  if (!nonBlank(workItemId)) return { status: "unknown_work_item" };

  const row = await store.workItem.findUnique({ where: { id: workItemId } });
  if (!row) return { status: "unknown_work_item" };

  const metadata =
    row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : {};
  const status = metadata[SPEC_PROVENANCE_STATUS_METADATA_KEY];

  if (status === SPEC_PROVENANCE_STATUS.NOT_REQUIRED) {
    return { status: SPEC_PROVENANCE_STATUS.NOT_REQUIRED };
  }

  const provenance = parseProvenance(metadata[SPEC_PROVENANCE_METADATA_KEY]);
  if (provenance) return { status: SPEC_PROVENANCE_STATUS.RECORDED, provenance };

  return { status: SPEC_PROVENANCE_STATUS.MISSING };
}
