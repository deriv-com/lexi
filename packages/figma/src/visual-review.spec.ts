import { describe, it, expect, vi } from "vitest";
import { createPrototypeVisualReview, qualityBarPrompt } from "./visual-review";

describe("createPrototypeVisualReview", () => {
  it("sends labelled screenshots with the fixed quality-bar prompt", async () => {
    const complete = vi.fn().mockResolvedValue({
      text: "VERDICT: FAIL\n- Get started: empty canvas",
    });
    const review = createPrototypeVisualReview({ complete }, "vision-model");
    const png = Buffer.from("fake-png-bytes-for-prototype-review-xx");
    const report = await review.review([{ label: "Get started", mimeType: "image/png", bytes: png }]);
    expect(report).toContain("VERDICT: FAIL");
    expect(complete).toHaveBeenCalledWith(
      [
        {
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "text",
              text: expect.stringMatching(/1440[\s\S]*Quality bar[\s\S]*blank canvas[\s\S]*Message goes here[\s\S]*VERDICT: PASS/),
            }),
            expect.objectContaining({ type: "text", text: "Screen: Get started" }),
            expect.objectContaining({
              type: "image",
              source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
            }),
          ]),
        },
      ],
      [],
      { model: "vision-model" },
    );
  });

  it("fails without calling the model when there are no screenshots", async () => {
    const complete = vi.fn();
    const report = await createPrototypeVisualReview({ complete }, "m").review([]);
    expect(report).toMatch(/^VERDICT: FAIL/);
    expect(complete).not.toHaveBeenCalled();
  });

  it("falls back to FAIL when the model returns nothing", async () => {
    const complete = vi.fn().mockResolvedValue({ text: "  " });
    const png = Buffer.from("x");
    const report = await createPrototypeVisualReview({ complete }, "m").review([{ label: "A", mimeType: "image/png", bytes: png }]);
    expect(report).toMatch(/^VERDICT: FAIL/);
  });
});

describe("qualityBarPrompt", () => {
  it("adds the deployment's rubric before the verdict format", () => {
    const prompt = qualityBarPrompt("Primary buttons are teal.");
    expect(prompt).toContain("Additional rules for this product's design system: Primary buttons are teal.");
    expect(prompt.indexOf("Primary buttons are teal.")).toBeLessThan(prompt.indexOf("VERDICT: PASS"));
  });

  it("leaves the rubric section out when none is given", () => {
    expect(qualityBarPrompt()).not.toContain("Additional rules");
  });
});
