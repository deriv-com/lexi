import { describe, expect, it } from "vitest";

import type { AcceptanceCriterion, AcceptanceTestBinding } from "@lexi/contracts";

import { evaluateAcTestMatrix } from "./ac-test-matrix";

const ac = (id: string, ordinal: number): AcceptanceCriterion => ({
  id,
  text: `criterion ${id}`,
  ordinal,
});

const bind = (
  criterionId: string,
  status: AcceptanceTestBinding["status"],
  kind: AcceptanceTestBinding["kind"] = "unit",
): AcceptanceTestBinding => ({
  criterionId,
  testRef: `${criterionId}.${kind}`,
  kind,
  status,
});

describe("evaluateAcTestMatrix", () => {
  it("places a red or green binding in proven", () => {
    const criteria = [ac("AC-aaaa0001", 1), ac("AC-aaaa0002", 2)];
    const result = evaluateAcTestMatrix(criteria, [
      bind("AC-aaaa0001", "red"),
      bind("AC-aaaa0002", "green", "widget"),
    ]);

    expect(result.unbound).toEqual([]);
    expect(result.missingRed).toEqual([]);
    expect(result.proven.map((c) => c.id)).toEqual(["AC-aaaa0001", "AC-aaaa0002"]);
  });

  it("treats a criterion with no binding as unbound", () => {
    const criteria = [ac("AC-bbbb0001", 1), ac("AC-bbbb0002", 2)];
    const result = evaluateAcTestMatrix(criteria, [bind("AC-bbbb0001", "red")]);

    expect(result.unbound.map((c) => c.id)).toEqual(["AC-bbbb0002"]);
    expect(result.proven.map((c) => c.id)).toEqual(["AC-bbbb0001"]);
    expect(result.missingRed).toEqual([]);
  });

  it("treats bindings that are never red and never green as unproven (missingRed)", () => {
    const criteria = [ac("AC-cccc0001", 1)];
    const result = evaluateAcTestMatrix(criteria, [bind("AC-cccc0001", "missing", "e2e")]);

    expect(result.unbound).toEqual([]);
    expect(result.proven).toEqual([]);
    expect(result.missingRed.map((c) => c.id)).toEqual(["AC-cccc0001"]);
  });

  it("does not invent a pass when every criterion is unbound", () => {
    const criteria = [ac("AC-dddd0001", 1), ac("AC-dddd0002", 2)];
    const result = evaluateAcTestMatrix(criteria, []);

    expect(result.proven).toEqual([]);
    expect(result.missingRed).toEqual([]);
    expect(result.unbound).toHaveLength(2);
  });

  it("does not generate tests — empty bindings stay empty", () => {
    const result = evaluateAcTestMatrix([ac("AC-eeee0001", 1)], []);
    expect(result.unbound).toHaveLength(1);
    expect(result.proven).toEqual([]);
  });
});
