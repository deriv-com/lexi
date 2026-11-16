import { describe, it, expect } from "vitest";
import type { AcceptanceCriterion, AcceptanceTestBinding } from "@lexi/contracts";
import { deriveAcStatuses, evaluateAcMatrix } from "./ac-matrix-evaluate";

const criterion = (id: string, ordinal: number): AcceptanceCriterion => ({
  id,
  text: `criterion ${id}`,
  ordinal,
});

const binding = (
  criterionId: string,
  status: AcceptanceTestBinding["status"],
): AcceptanceTestBinding => ({
  criterionId,
  testRef: `e2e/${criterionId}.spec.ts`,
  kind: "e2e",
  status,
});

describe("evaluateAcMatrix", () => {
  it("partitions unbound / proven / missingRed per the matrix contract", () => {
    const criteria = [criterion("AC-a", 1), criterion("AC-b", 2), criterion("AC-c", 3)];
    const bindings = [binding("AC-a", "green"), binding("AC-b", "missing")];
    const result = evaluateAcMatrix(criteria, bindings);
    expect(result.proven.map((c) => c.id)).toEqual(["AC-a"]);
    expect(result.missingRed.map((c) => c.id)).toEqual(["AC-b"]);
    expect(result.unbound.map((c) => c.id)).toEqual(["AC-c"]);
  });

  it("a red binding counts as proven — failing evidence is evidence", () => {
    const result = evaluateAcMatrix([criterion("AC-a", 1)], [binding("AC-a", "red")]);
    expect(result.proven.map((c) => c.id)).toEqual(["AC-a"]);
  });
});

describe("deriveAcStatuses", () => {
  it("green wins over red; declared-but-colourless is missing; none is unbound", () => {
    const statuses = deriveAcStatuses(
      ["AC-a", "AC-b", "AC-c", "AC-d"],
      [binding("AC-a", "red"), binding("AC-a", "green"), binding("AC-b", "red"), binding("AC-c", "missing")],
    );
    expect(statuses).toEqual([
      { criterionId: "AC-a", status: "green" },
      { criterionId: "AC-b", status: "red" },
      { criterionId: "AC-c", status: "missing" },
      { criterionId: "AC-d", status: "unbound" },
    ]);
  });
});
