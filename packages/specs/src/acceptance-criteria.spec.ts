/**
 * Acceptance-criterion ids — the stability properties, asserted directly.
 *
 * These ids are the address that the acceptance-to-test matrix, per-criterion
 * budgets and the evidence index all point at. What makes them
 * usable is not that they exist but that they hold still under edits to *other*
 * criteria, so the tests below are about which edits move an id and which do
 * not. A test that only checked "an id is produced" would pass against a
 * counter, which is exactly the design this replaced.
 */
import { describe, it, expect } from "vitest";
import { acceptanceCriterionId, parseAcceptanceCriteria } from "./task-candidates";

const THREE = ["- Deposit succeeds on mobile web", "- A failure shows a retry", "- Balance updates"].join("\n");

describe("acceptance criterion ids — what must not move them", () => {
  it("survives inserting a criterion above", () => {
    const before = parseAcceptanceCriteria(THREE);
    const after = parseAcceptanceCriteria(["- A brand new first criterion", THREE].join("\n"));

    const balanceBefore = before.find((c) => c.text.startsWith("Balance"));
    const balanceAfter = after.find((c) => c.text.startsWith("Balance"));

    expect(balanceBefore?.id).toBe(balanceAfter?.id);
    // ...while the ordinal does move, which is why it is not the identity.
    expect(balanceBefore?.ordinal).toBe(3);
    expect(balanceAfter?.ordinal).toBe(4);
  });

  it("survives deleting a criterion above", () => {
    const before = parseAcceptanceCriteria(THREE);
    const after = parseAcceptanceCriteria(THREE.split("\n").slice(1).join("\n"));

    expect(before[2]?.id).toBe(after[1]?.id);
  });

  it("survives reordering", () => {
    const before = parseAcceptanceCriteria(THREE);
    const reversed = parseAcceptanceCriteria(THREE.split("\n").reverse().join("\n"));

    expect(new Set(before.map((c) => c.id))).toEqual(new Set(reversed.map((c) => c.id)));
  });

  it("survives re-indentation, list-marker changes and wrapped whitespace", () => {
    const dash = acceptanceCriterionId("- Deposit succeeds on mobile web");
    const bullet = acceptanceCriterionId("  • Deposit succeeds on mobile web");
    const numbered = acceptanceCriterionId("1. Deposit succeeds on mobile web");
    const wrapped = acceptanceCriterionId("Deposit   succeeds\ton mobile web");

    expect(new Set([dash, bullet, numbered, wrapped]).size).toBe(1);
  });
});

describe("acceptance criterion ids — what must move them", () => {
  /**
   * The deliberate trade documented on `AcceptanceCriterion`: a reword mints a
   * new id rather than being matched back to its predecessor. An orphaned
   * reference is visible and answerable; a silently re-pointed one would leave
   * a test claiming to cover a criterion whose meaning had moved.
   */
  it("changes when the criterion is reworded", () => {
    expect(acceptanceCriterionId("Deposit succeeds on mobile web")).not.toBe(
      acceptanceCriterionId("Deposit succeeds on mobile web and native"),
    );
  });

  it("changes on a case edit — a case change is a text change", () => {
    expect(acceptanceCriterionId("Deposit succeeds")).not.toBe(acceptanceCriterionId("deposit succeeds"));
  });
});

describe("parsing", () => {
  it("numbers ordinals from one, in reading order", () => {
    expect(parseAcceptanceCriteria(THREE).map((c) => c.ordinal)).toEqual([1, 2, 3]);
  });

  it("collapses identical criteria so one id never addresses two rows", () => {
    const criteria = parseAcceptanceCriteria(
      ["- Balance updates", "- Balance updates", "- Something else"].join("\n"),
    );

    expect(criteria).toHaveLength(2);
    expect(new Set(criteria.map((c) => c.id)).size).toBe(2);
  });

  it("returns nothing for empty or absent text rather than a phantom criterion", () => {
    expect(parseAcceptanceCriteria(undefined)).toEqual([]);
    expect(parseAcceptanceCriteria("   \n\n  ")).toEqual([]);
  });

  it("produces the documented AC- + 8 hex shape", () => {
    for (const criterion of parseAcceptanceCriteria(THREE)) {
      expect(criterion.id).toMatch(/^AC-[0-9a-f]{8}$/);
    }
  });

  it("is pure — the same text always yields the same id", () => {
    expect(acceptanceCriterionId("Balance updates")).toBe(acceptanceCriterionId("Balance updates"));
  });
});
