import { describe, expect, it } from "vitest";

import { DELIVERY_CONTROLS } from "./delivery-controls.types";

import { evaluateDeliveryControls } from "./delivery-controls";

describe("evaluateDeliveryControls", () => {
  it("names the four delivery controls", () => {
    expect(DELIVERY_CONTROLS).toEqual([
      "specification",
      "experience",
      "engineering",
      "production",
    ]);
  });

  it("reports all four covered when evidence is supplied for each", () => {
    const result = evaluateDeliveryControls({
      specification: "approved spec rev 3",
      experience: "stakeholders completed the test-link journey",
      engineering: "green PR with E2E screenshots",
      production: "release manager packet + named approver",
    });
    expect(result.ok).toBe(true);
    expect(result.covered).toEqual([...DELIVERY_CONTROLS]);
    expect(result.gaps).toEqual([]);
  });

  it("treats absence as a gap, not a pass", () => {
    const result = evaluateDeliveryControls({});
    expect(result.ok).toBe(false);
    expect(result.covered).toEqual([]);
    expect(result.gaps).toEqual([...DELIVERY_CONTROLS]);
  });

  it("fails closed when only some controls have evidence", () => {
    const result = evaluateDeliveryControls({
      specification: "approved spec rev 3",
      engineering: "  ",
    });
    expect(result.ok).toBe(false);
    expect(result.covered).toEqual(["specification"]);
    expect(result.gaps).toEqual(["experience", "engineering", "production"]);
  });
});
