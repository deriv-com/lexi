/**
 * Permanent regression test for digest truthfulness.
 *
 * Reporting `0` for an uninstrumented counter tells an operator that nothing
 * happened, when in fact nothing was measured. That is a correctness defect: it
 * makes a blind spot look like a clean run. `null` must therefore render as
 * "not measured" and stay distinguishable from a genuine `0`.
 */
import { describe, it, expect } from "vitest";
import { buildDigest, formatDigestMarkdown, type DigestInput } from "./digest-builder";

const NULLABLE_FIELDS = [
  "intakeAccepted",
  "intakeRejected",
  "intakeNeedsInfo",
  "assigned",
  "duplicateClusters",
  "pendingClosures",
  "closures",
  "manualReviewQueue",
  "quickFixPrs",
  "policyBlocks",
  "reopenSignals",
] as const;

function allNullInput(overrides: Partial<DigestInput> = {}): DigestInput {
  return {
    runId: "run-1",
    scannedCount: 0,
    intakeAccepted: null,
    intakeRejected: null,
    intakeNeedsInfo: null,
    triaged: 0,
    assigned: null,
    duplicateClusters: null,
    reproductionOutcomes: null,
    pendingClosures: null,
    closures: null,
    manualReviewQueue: null,
    reproductionDegradation: null,
    quickFixPrs: null,
    policyBlocks: null,
    reopenSignals: null,
    deferredByBudget: 0,
    ...overrides,
  };
}

function allItems(input: DigestInput): string[] {
  return buildDigest(input).sections.flatMap((section) => section.items);
}

describe("digest not-measured semantics", () => {
  it.each(NULLABLE_FIELDS)("renders a null %s as 'not measured', never as 0", (field) => {
    const items = allItems(allNullInput({ [field]: null } as Partial<DigestInput>));
    const nullRendered = items.filter((item) => item.endsWith("not measured"));
    expect(nullRendered.length).toBeGreaterThan(0);

    const markdown = formatDigestMarkdown(buildDigest(allNullInput({ [field]: null } as Partial<DigestInput>)));
    expect(markdown).toContain("not measured");
  });

  it("renders an explicit 0 as '0', keeping it distinguishable from null", () => {
    const zeroed = allItems(allNullInput({ closures: 0, pendingClosures: 0 }));
    expect(zeroed).toContain("Closures: 0");
    expect(zeroed).toContain("Pending closures: 0");

    const nulled = allItems(allNullInput({ closures: null, pendingClosures: null }));
    expect(nulled).toContain("Closures: not measured");
    expect(nulled).toContain("Pending closures: not measured");
    expect(nulled).not.toContain("Closures: 0");
  });

  it("distinguishes not-measured, false, and true for reproductionDegradation", () => {
    expect(allItems(allNullInput({ reproductionDegradation: null }))).toContain("Reproduction degradation: not measured");
    expect(allItems(allNullInput({ reproductionDegradation: false }))).toContain("Reproduction degradation: no");
    expect(allItems(allNullInput({ reproductionDegradation: true }))).toContain("Reproduction degradation: yes");
  });

  it("treats both null and an empty reproduction map as a single not-measured item", () => {
    for (const outcomes of [null, {}] as const) {
      const section = buildDigest(allNullInput({ reproductionOutcomes: outcomes })).sections.find(
        (s) => s.title === "Reproduction",
      );
      expect(section).toBeDefined();
      expect(section?.items).toEqual(["not measured"]);
    }
  });

  it("renders populated reproduction outcomes instead of not-measured", () => {
    const section = buildDigest(
      allNullInput({ reproductionOutcomes: { reproduced: 2, failed: 1 } }),
    ).sections.find((s) => s.title === "Reproduction");
    expect(section?.items).toEqual(["reproduced: 2", "failed: 1"]);
    expect(section?.items).not.toContain("not measured");
  });

  it("a fully-null digest contains no bare ': 0' line for any nullable field", () => {
    const markdown = formatDigestMarkdown(buildDigest(allNullInput()));
    const zeroLines = markdown
      .split("\n")
      .filter((line) => line.startsWith("- ") && line.endsWith(": 0"));

    // Only the non-nullable counters (Scanned, Triaged, Deferred by budget) may
    // legitimately report 0 here; no nullable field may.
    expect(zeroLines.sort()).toEqual(["- Deferred by budget: 0", "- Scanned: 0", "- Triaged: 0"]);
    for (const field of NULLABLE_FIELDS) {
      expect(markdown).not.toMatch(new RegExp(`${field}.*: 0$`, "m"));
    }
  });
});
