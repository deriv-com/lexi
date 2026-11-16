import { describe, it, expect } from "vitest";
import { FigmaMutationGateway, parseFigmaFileKeys } from "./mutation-gateway";

const PRODUCTION_FILE = "ProdDesign0001";

describe("parseFigmaFileKeys", () => {
  it("returns nothing for an empty value", () => {
    expect(parseFigmaFileKeys("")).toEqual([]);
    expect(parseFigmaFileKeys(undefined)).toEqual([]);
  });

  it("splits on commas and whitespace and de-duplicates", () => {
    expect(parseFigmaFileKeys("Abc, Def\nAbc")).toEqual(["Abc", "Def"]);
  });
});

describe("FigmaMutationGateway", () => {
  it("denies a forbidden file even if registerCreated is called", () => {
    const gateway = new FigmaMutationGateway({ forbiddenFileKeys: [PRODUCTION_FILE] });
    const registered = gateway.registerCreated(PRODUCTION_FILE);
    expect(registered.ok).toBe(false);
    if (!registered.ok) expect(registered.reason).toMatch(/forbidden/);
  });

  it("denies an empty file key", async () => {
    const gateway = new FigmaMutationGateway();
    const decision = await gateway.assertWritable("   ");
    expect(decision.ok).toBe(false);
  });

  it("denies an unknown file key", async () => {
    const gateway = new FigmaMutationGateway();
    const decision = await gateway.assertWritable("NotLexiOwned");
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/not a Lexi-owned prototype/);
  });

  it("allows a file key registered after create", async () => {
    const gateway = new FigmaMutationGateway();
    expect(gateway.registerCreated("AbC123xyz")).toEqual({ ok: true });
    await expect(gateway.assertWritable("AbC123xyz")).resolves.toEqual({ ok: true });
  });

  it("allows a file key the store says was created here", async () => {
    const gateway = new FigmaMutationGateway({
      lookup: async (key) => key === "BoundKey99",
    });
    await expect(gateway.assertWritable("BoundKey99")).resolves.toEqual({ ok: true });
  });

  it("denies a forbidden key even when the store claims it", async () => {
    const gateway = new FigmaMutationGateway({
      forbiddenFileKeys: [PRODUCTION_FILE],
      lookup: async () => true,
    });
    const decision = await gateway.assertWritable(PRODUCTION_FILE);
    expect(decision.ok).toBe(false);
  });
});
