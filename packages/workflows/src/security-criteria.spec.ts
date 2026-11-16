import { describe, expect, it } from "vitest";

import { SECURITY_REVIEW_CRITERIA } from "./security-criteria.types";

import { evaluateSecurityCriteria } from "./security-criteria";

describe("evaluateSecurityCriteria", () => {
  it("encodes the review table as a frozen 17-row catalogue", () => {
    expect(SECURITY_REVIEW_CRITERIA).toHaveLength(17);
    expect(new Set(SECURITY_REVIEW_CRITERIA.map((c) => c.id)).size).toBe(17);
    expect(SECURITY_REVIEW_CRITERIA[0]!.id).toBe("SEC-01");
    expect(SECURITY_REVIEW_CRITERIA[16]!.id).toBe("SEC-17");
    expect(SECURITY_REVIEW_CRITERIA[16]!.category).toBe("Operations");
  });

  it("allows only when every catalogue row has non-empty evidence", () => {
    const evidence = Object.fromEntries(
      SECURITY_REVIEW_CRITERIA.map((c) => [c.id, `evidence for ${c.id}`]),
    );
    const result = evaluateSecurityCriteria(evidence);
    expect(result.allowed).toBe(true);
    expect(result.refusals).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.coveredIds).toHaveLength(17);
  });

  it("fails closed when evidence is absent — does not invent a pass", () => {
    const result = evaluateSecurityCriteria({});
    expect(result.allowed).toBe(false);
    expect(result.coveredIds).toEqual([]);
    expect(result.missing).toHaveLength(17);
    expect(result.refusals.every((r) => r.code === "MISSING_EVIDENCE")).toBe(true);
  });

  it("fails closed when only some rows have evidence", () => {
    const result = evaluateSecurityCriteria({
      "SEC-01": "reviewed caching preserves auth",
      "SEC-05": "no secrets in source",
    });
    expect(result.allowed).toBe(false);
    expect(result.coveredIds).toEqual(["SEC-01", "SEC-05"]);
    expect(result.missing).toHaveLength(15);
    expect(result.refusals.find((r) => r.criterionId === "SEC-02")?.code).toBe("MISSING_EVIDENCE");
  });

  it("treats whitespace-only evidence as missing", () => {
    const evidence = Object.fromEntries(SECURITY_REVIEW_CRITERIA.map((c) => [c.id, "attached"]));
    evidence["SEC-07"] = "   ";
    const result = evaluateSecurityCriteria(evidence);
    expect(result.allowed).toBe(false);
    expect(result.missing.map((c) => c.id)).toEqual(["SEC-07"]);
  });
});
