import { describe, it, expect } from "vitest";
import { evaluateAutoClose } from "./auto-close-policy";

describe("evaluateAutoClose slack manual evidence", () => {
  it("blocks auto-close for shallow manual_slack cannot-reproduce", () => {
    const result = evaluateAutoClose({
      classification: "CANNOT_REPRODUCE",
      decisionConfidence: 0.9,
      resultDetails: {
        evidenceSource: "manual_slack",
        incompleteEvidence: true,
        reproduced: false,
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("incompleteEvidence");
  });

  it("blocks auto-close when reproduction metadata is missing for CANNOT_REPRODUCE", () => {
    const result = evaluateAutoClose({
      classification: "CANNOT_REPRODUCE",
      decisionConfidence: 0.9,
      resultDetails: null,
    });
    expect(result.allowed).toBe(false);
  });
});
