import { describe, it, expect } from "vitest";
import { evaluateHardeningGate } from "./hardening-gate";

describe("evaluateHardeningGate", () => {
  const policy = { requireZeroOpenFindings: true };

  it("passes only with a human conclusion AND zero open findings", () => {
    const verdict = evaluateHardeningGate({ openFindings: [], concludedBy: "U123", policy });
    expect(verdict.passed).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it("zero findings without a conclusion means nobody has run the hardening pass yet", () => {
    const verdict = evaluateHardeningGate({ openFindings: [], concludedBy: null, policy });
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("no human has concluded the hardening");
  });

  it("a concluded hardening pass with open findings still refuses, naming them", () => {
    const verdict = evaluateHardeningGate({
      openFindings: [{ issueNumber: 42, title: "Switcher renders twice" }],
      concludedBy: "U123",
      policy,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons[0]).toContain("#42 Switcher renders twice");
  });

  it("truncates the named findings at five and counts the rest", () => {
    const openFindings = Array.from({ length: 8 }, (_, i) => ({
      issueNumber: i + 1,
      title: `finding ${i + 1}`,
    }));
    const verdict = evaluateHardeningGate({ openFindings, concludedBy: "U123", policy });
    expect(verdict.reasons[0]).toContain("8 open hardening finding(s)");
    expect(verdict.reasons[0]).toContain("(and 3 more)");
  });
});
