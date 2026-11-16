import { describe, it, expect, vi } from "vitest";
import {
  buildSpecProvenance,
  loadSpecProvenance,
  loadSpecProvenanceRecord,
  specProvenanceMetadata,
  SPEC_PROVENANCE_STATUS,
  type SpecProvenanceWorkItemStore,
} from "./spec-provenance";

/**
 * The WRITE half of the spec exit gate, as a pure builder plus a read helper.
 *
 * The builder is where "record, do not re-derive" is enforced: it accepts the
 * evidence the entrance gate already resolved and refuses to invent any part
 * of it. The read helper is the verifier's entry point — it must be able to
 * tell "no spec was required" from "a spec was required and is missing",
 * because collapsing those two is how a hole in the audit chain reads as clean.
 */

const REFERENCE = { specId: "spec-1", revision: 2 };

const EVIDENCE = {
  specId: "spec-1",
  approvedRevision: 2,
  status: "APPROVED",
  contentHash: "sha256:approved-bytes",
  approvedAt: "2026-08-01T09:30:00.000Z",
  approvedBy: "U_APPROVER",
};

describe("buildSpecProvenance", () => {
  it("captures the whole SpecProvenance shape from resolved evidence", () => {
    expect(buildSpecProvenance({ reference: REFERENCE, evidence: EVIDENCE })).toEqual({
      specId: "spec-1",
      revision: 2,
      contentHash: "sha256:approved-bytes",
      approvedAt: "2026-08-01T09:30:00.000Z",
      approvedBy: "U_APPROVER",
    });
  });

  /**
   * The revision recorded is the one the gate VALIDATED (the approved
   * revision), never the caller's claim. They are equal whenever the gate
   * passed — but sourcing it from the claim would mean a future gate change
   * silently records an unapproved number.
   */
  it("takes the revision from the evidence, not from the caller's claim", () => {
    const provenance = buildSpecProvenance({
      reference: { specId: "spec-1", revision: 99 },
      evidence: EVIDENCE,
    });

    expect(provenance?.revision).toBe(2);
  });

  /**
   * Without the hash, provenance pins a pointer rather than the approved
   * bytes, and a post-approval redraft becomes undetectable. A provenance
   * record that cannot do its one job must not be manufactured.
   */
  it("refuses to build provenance with no contentHash", () => {
    expect(
      buildSpecProvenance({
        reference: REFERENCE,
        evidence: { ...EVIDENCE, contentHash: undefined },
      }),
    ).toBeNull();
  });

  it("refuses to build provenance with a blank contentHash", () => {
    expect(
      buildSpecProvenance({ reference: REFERENCE, evidence: { ...EVIDENCE, contentHash: "  " } }),
    ).toBeNull();
  });

  it("refuses to build provenance from unresolved evidence", () => {
    expect(buildSpecProvenance({ reference: REFERENCE, evidence: null })).toBeNull();
  });

  it("refuses to build provenance from an unapproved spec", () => {
    expect(
      buildSpecProvenance({
        reference: REFERENCE,
        evidence: { ...EVIDENCE, status: "IN_REVIEW", approvedRevision: null },
      }),
    ).toBeNull();
  });

  /** Automation cannot approve (`humanOnly`); an unattributed approval is not one. */
  it("refuses to build provenance with no approver", () => {
    expect(
      buildSpecProvenance({ reference: REFERENCE, evidence: { ...EVIDENCE, approvedBy: undefined } }),
    ).toBeNull();
  });
});

describe("specProvenanceMetadata", () => {
  it("marks a recorded capture and carries the provenance", () => {
    const provenance = buildSpecProvenance({ reference: REFERENCE, evidence: EVIDENCE })!;

    expect(specProvenanceMetadata(provenance)).toEqual({
      specProvenanceStatus: SPEC_PROVENANCE_STATUS.RECORDED,
      specProvenance: provenance,
    });
  });

  it("marks a required-but-missing capture without inventing provenance", () => {
    expect(specProvenanceMetadata(null)).toEqual({
      specProvenanceStatus: SPEC_PROVENANCE_STATUS.MISSING,
    });
  });

  it("marks a path that needs no spec as not_required", () => {
    expect(specProvenanceMetadata(null, { specRequired: false })).toEqual({
      specProvenanceStatus: SPEC_PROVENANCE_STATUS.NOT_REQUIRED,
    });
  });
});

function store(workItem: unknown): SpecProvenanceWorkItemStore {
  return {
    workItem: { findUnique: vi.fn(async () => workItem) },
  } as unknown as SpecProvenanceWorkItemStore;
}

describe("loadSpecProvenance", () => {
  const recorded = {
    specId: "spec-1",
    metadata: {
      specProvenanceStatus: SPEC_PROVENANCE_STATUS.RECORDED,
      specProvenance: {
        specId: "spec-1",
        revision: 2,
        contentHash: "sha256:approved-bytes",
        approvedAt: "2026-08-01T09:30:00.000Z",
        approvedBy: "U_APPROVER",
      },
    },
  };

  it("returns the recorded provenance for a work item that has it", async () => {
    expect(await loadSpecProvenance(store(recorded), "wi-1")).toEqual(recorded.metadata.specProvenance);
  });

  it("returns null for an unknown work item", async () => {
    expect(await loadSpecProvenance(store(null), "nope")).toBeNull();
  });

  it("returns null when the work item carries no provenance", async () => {
    expect(await loadSpecProvenance(store({ specId: null, metadata: {} }), "wi-2")).toBeNull();
  });

  /**
   * A half-written blob is not provenance. Handing back a record missing the
   * hash would let a verifier believe it had pinned bytes it never had.
   */
  it("returns null for a malformed provenance blob", async () => {
    const malformed = store({
      specId: "spec-1",
      metadata: { specProvenance: { specId: "spec-1", revision: 2 } },
    });

    expect(await loadSpecProvenance(malformed, "wi-3")).toBeNull();
  });

  it("returns null when metadata is not an object", async () => {
    expect(await loadSpecProvenance(store({ specId: "spec-1", metadata: "nope" }), "wi-4")).toBeNull();
  });

  it("returns null for a blank workItemId rather than querying", async () => {
    const s = store(recorded);
    expect(await loadSpecProvenance(s, "")).toBeNull();
    expect(s.workItem.findUnique).not.toHaveBeenCalled();
  });
});

describe("loadSpecProvenanceRecord", () => {
  it("reports recorded provenance", async () => {
    const s = store({
      specId: "spec-1",
      metadata: {
        specProvenanceStatus: SPEC_PROVENANCE_STATUS.RECORDED,
        specProvenance: {
          specId: "spec-1",
          revision: 2,
          contentHash: "sha256:approved-bytes",
          approvedAt: "2026-08-01T09:30:00.000Z",
          approvedBy: "U_APPROVER",
        },
      },
    });

    expect(await loadSpecProvenanceRecord(s, "wi-1")).toEqual({
      status: SPEC_PROVENANCE_STATUS.RECORDED,
      provenance: expect.objectContaining({ contentHash: "sha256:approved-bytes" }),
    });
  });

  /**
   * The distinction the verifier needs: a chore that never needed a spec is
   * clean, a feature whose spec went unrecorded is a hole. Both have no
   * provenance; only one is a finding.
   */
  it("distinguishes not_required from missing", async () => {
    const chore = store({
      specId: null,
      metadata: { specProvenanceStatus: SPEC_PROVENANCE_STATUS.NOT_REQUIRED },
    });
    const hole = store({
      specId: "spec-1",
      metadata: { specProvenanceStatus: SPEC_PROVENANCE_STATUS.MISSING },
    });

    expect((await loadSpecProvenanceRecord(chore, "wi-c")).status).toBe(
      SPEC_PROVENANCE_STATUS.NOT_REQUIRED,
    );
    expect((await loadSpecProvenanceRecord(hole, "wi-h")).status).toBe(
      SPEC_PROVENANCE_STATUS.MISSING,
    );
  });

  /**
   * A work item written before this capture existed carries no status at all.
   * It must not read as `not_required` — that would silently absolve every
   * pre-existing feature dispatch.
   */
  it("treats an unmarked work item as missing, not as not_required", async () => {
    const legacy = store({ specId: "spec-1", metadata: {} });

    expect((await loadSpecProvenanceRecord(legacy, "wi-legacy")).status).toBe(
      SPEC_PROVENANCE_STATUS.MISSING,
    );
  });

  it("reports an unknown work item distinctly", async () => {
    expect((await loadSpecProvenanceRecord(store(null), "nope")).status).toBe("unknown_work_item");
  });

  /** A status claiming `recorded` over a malformed blob is still a hole. */
  it("downgrades a recorded status with an unusable blob to missing", async () => {
    const lying = store({
      specId: "spec-1",
      metadata: {
        specProvenanceStatus: SPEC_PROVENANCE_STATUS.RECORDED,
        specProvenance: { specId: "spec-1", revision: 2 },
      },
    });

    expect((await loadSpecProvenanceRecord(lying, "wi-lie")).status).toBe(
      SPEC_PROVENANCE_STATUS.MISSING,
    );
  });
});
