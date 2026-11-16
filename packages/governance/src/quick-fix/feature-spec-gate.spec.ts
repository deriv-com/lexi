/**
 * The teeth: `trigger_code_task(feature)` is
 * refused without an approved spec reference **at the referenced revision**.
 *
 * "At the referenced revision" is the load-bearing half. A spec approved at
 * r2 and revised to r3 is not an approved r3 — approval does not travel
 * across revisions, or the approval gate becomes a one-time formality that
 * any later edit can walk through.
 *
 * The second requirement is negative: NO_POLICY_MATCH routes to human review.
 * There is no input to this gate for which "nothing matched" means "go ahead".
 */
import { describe, it, expect } from "vitest";
import {
  evaluateQuickFixEligibility,
  QUICK_FIX_REASON_CODES,
  type QuickFixContext,
  type QuickFixPolicyConfig,
} from "./quick-fix-eligibility";
import { loadFeaturePolicy } from "../spec/feature-policy.schema";

const config: QuickFixPolicyConfig = {
  maxPriority: "P3",
  maxSeverity: "S3",
  maxFilesChanged: 3,
  maxLinesChanged: 80,
  forbiddenLabels: [],
  forbiddenComponents: [],
  forbiddenPathPatterns: [],
  maxOpenPrsPerReviewer: 3,
  maxOpenPrsPerIssue: 1,
  staleReminderDays: 7,
  staleCloseDays: 14,
  autofixLabel: "lexi:autofix",
};

/** A context that passes every pre-existing cap, isolating the spec gate. */
function ctx(overrides: Partial<QuickFixContext> = {}): QuickFixContext {
  return {
    taskType: "feature",
    reproduced: false,
    rootCausePaths: ["src/ui/cart.ts"],
    estimatedFilesChanged: 1,
    estimatedLinesChanged: 10,
    canAddRegressionTest: true,
    labels: [],
    openAutofixPrCount: 0,
    ...overrides,
  };
}

const approvedAtR3 = {
  specId: "spec-42",
  approvedRevision: 3,
  status: "APPROVED",
  supersededById: null,
};

describe("feature dispatch requires an approved spec", () => {
  it("refuses a feature with no spec reference at all", () => {
    const result = evaluateQuickFixEligibility(ctx(), config);
    expect(result.eligible).toBe(false);
    expect(result.outcome).toBe("ineligible");
    expect(result.reasonCodes).toContain(QUICK_FIX_REASON_CODES.SPEC_REFERENCE_MISSING);
  });

  it("refuses even when every other cap passes", () => {
    // Proves the refusal comes from the spec gate, not from a size or label cap.
    const result = evaluateQuickFixEligibility(ctx(), config);
    expect(result.reasons.some((r) => r.toLowerCase().includes("spec"))).toBe(true);
  });

  it("allows a feature whose spec is approved at the referenced revision", () => {
    const result = evaluateQuickFixEligibility(
      ctx({ specReference: { specId: "spec-42", revision: 3 }, specEvidence: approvedAtR3 }),
      config,
    );
    expect(result.eligible).toBe(true);
    expect(result.outcome).toBe("eligible");
    expect(result.reasons).toEqual([]);
  });

  it("refuses when the referenced revision is newer than the approved one", () => {
    // The spec moved on after approval. This is the case the gate exists for.
    const result = evaluateQuickFixEligibility(
      ctx({ specReference: { specId: "spec-42", revision: 4 }, specEvidence: approvedAtR3 }),
      config,
    );
    expect(result.eligible).toBe(false);
    expect(result.reasonCodes).toContain(QUICK_FIX_REASON_CODES.SPEC_REVISION_MISMATCH);
  });

  it("refuses when the referenced revision is older than the approved one", () => {
    // Dispatching against a stale revision builds something nobody approved
    // in its current form either.
    const result = evaluateQuickFixEligibility(
      ctx({ specReference: { specId: "spec-42", revision: 2 }, specEvidence: approvedAtR3 }),
      config,
    );
    expect(result.eligible).toBe(false);
    expect(result.reasonCodes).toContain(QUICK_FIX_REASON_CODES.SPEC_REVISION_MISMATCH);
  });

  it("refuses when the spec is not approved", () => {
    for (const status of ["DRAFTING", "DRAFT_READY", "IN_REVIEW", "CHANGES_REQUESTED", "REJECTED"]) {
      const result = evaluateQuickFixEligibility(
        ctx({
          specReference: { specId: "spec-42", revision: 3 },
          specEvidence: { ...approvedAtR3, status, approvedRevision: null },
        }),
        config,
      );
      expect(result.eligible, status).toBe(false);
      expect(result.reasonCodes, status).toContain(QUICK_FIX_REASON_CODES.SPEC_NOT_APPROVED);
    }
  });

  it("refuses when the spec has been superseded", () => {
    const result = evaluateQuickFixEligibility(
      ctx({
        specReference: { specId: "spec-42", revision: 3 },
        specEvidence: { ...approvedAtR3, supersededById: "spec-77" },
      }),
      config,
    );
    expect(result.eligible).toBe(false);
    expect(result.reasonCodes).toContain(QUICK_FIX_REASON_CODES.SPEC_SUPERSEDED);
  });

  it("routes to human review when the spec reference cannot be verified", () => {
    // A reference with no resolved evidence is an unverifiable claim, not a
    // pass. It is also not a definite refusal — the spec may well be approved
    // and the lookup simply failed — so it goes to a human.
    const result = evaluateQuickFixEligibility(
      ctx({ specReference: { specId: "spec-42", revision: 3 } }),
      config,
    );
    expect(result.eligible).toBe(false);
    expect(result.outcome).toBe("human_review");
    expect(result.reasonCodes).toContain(QUICK_FIX_REASON_CODES.SPEC_EVIDENCE_MISSING);
  });

  it("routes to human review when the evidence is for a different spec", () => {
    const result = evaluateQuickFixEligibility(
      ctx({
        specReference: { specId: "spec-42", revision: 3 },
        specEvidence: { ...approvedAtR3, specId: "spec-99" },
      }),
      config,
    );
    expect(result.eligible).toBe(false);
    expect(result.outcome).toBe("human_review");
    expect(result.reasonCodes).toContain(QUICK_FIX_REASON_CODES.SPEC_EVIDENCE_MISMATCH);
  });

  it("can be relaxed by config, and only by config", () => {
    const relaxed = loadFeaturePolicy();
    const off = {
      ...relaxed,
      dispatch: { ...relaxed.dispatch, requireApprovedSpecForFeature: false },
    };
    const result = evaluateQuickFixEligibility(ctx(), config, off);
    expect(result.eligible).toBe(true);
  });

  it("requires the spec by default when no feature policy is supplied", () => {
    // Fail closed: a caller that forgot to pass the policy gets the strict
    // behaviour, not the permissive one.
    expect(evaluateQuickFixEligibility(ctx(), config).eligible).toBe(false);
  });
});

describe("NO_POLICY_MATCH never means allow", () => {
  it("routes an unrecognised taskType to human review", () => {
    const result = evaluateQuickFixEligibility(
      ctx({ taskType: "experiment" as never }),
      config,
    );
    expect(result.eligible).toBe(false);
    expect(result.outcome).toBe("human_review");
    expect(result.reasonCodes).toContain(QUICK_FIX_REASON_CODES.NO_POLICY_MATCH);
  });

  it("never returns eligible with a human_review outcome", () => {
    const results = [
      evaluateQuickFixEligibility(ctx({ taskType: "experiment" as never }), config),
      evaluateQuickFixEligibility(ctx({ specReference: { specId: "s", revision: 1 } }), config),
    ];
    for (const result of results) {
      if (result.outcome === "human_review") expect(result.eligible).toBe(false);
    }
  });

  it("carries a reason a human can act on", () => {
    const result = evaluateQuickFixEligibility(ctx({ taskType: "experiment" as never }), config);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.join(" ")).toContain("experiment");
  });
});

describe("existing behaviour is preserved", () => {
  it("still requires reproduction of a bug", () => {
    const result = evaluateQuickFixEligibility(
      ctx({ taskType: "bug", reproduced: false }),
      config,
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("Bug must be reproduced with clear evidence.");
  });

  it("lets a person confirm a bug without flipping reproduced", () => {
    const result = evaluateQuickFixEligibility(
      ctx({ taskType: "bug", reproduced: false, humanConfirmed: true }),
      config,
    );
    expect(result.eligible).toBe(true);
    expect(result.outcome).toBe("eligible");
  });

  it("does not treat humanConfirmed=false as an override", () => {
    const result = evaluateQuickFixEligibility(
      ctx({ taskType: "bug", reproduced: false, humanConfirmed: false }),
      config,
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("Bug must be reproduced with clear evidence.");
  });

  it("still allows a reproduced bug with no spec reference whatsoever", () => {
    // The spec requirement is a feature-path rule. Bugs are unaffected.
    const result = evaluateQuickFixEligibility(
      ctx({ taskType: "bug", reproduced: true }),
      config,
    );
    expect(result.eligible).toBe(true);
    expect(result.outcome).toBe("eligible");
  });

  it("still defaults an absent taskType to bug", () => {
    const result = evaluateQuickFixEligibility(
      { ...ctx(), taskType: undefined, reproduced: true },
      config,
    );
    expect(result.eligible).toBe(true);
  });

  it("still allows a chore with no spec reference", () => {
    const result = evaluateQuickFixEligibility(ctx({ taskType: "chore" }), config);
    expect(result.eligible).toBe(true);
  });

  it("still enforces every pre-existing cap on the feature path", () => {
    const result = evaluateQuickFixEligibility(
      ctx({
        specReference: { specId: "spec-42", revision: 3 },
        specEvidence: approvedAtR3,
        estimatedFilesChanged: 99,
        labels: ["security"],
      }),
      { ...config, forbiddenLabels: ["security"] },
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("exceeds cap"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("Forbidden label"))).toBe(true);
  });

  it("keeps the reasons array shape for callers that only read it", () => {
    const result = evaluateQuickFixEligibility(ctx({ taskType: "bug", reproduced: false }), config);
    expect(Array.isArray(result.reasons)).toBe(true);
    expect(typeof result.eligible).toBe("boolean");
  });
});
