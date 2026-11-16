import { describe, it, expect, vi } from "vitest";
import { PinoLoggerService } from "@lexi/logger";
import { DecisionEngine } from "./decision-engine";
import { AiProvider } from "./ai-provider.interface";
import { AiDecisionInput, Decision } from "./types";

const sampleInput: AiDecisionInput = {
  issue: {
    number: 7,
    title: "Crash on login",
    body: "App crashes",
    url: "https://github.com/x/y/issues/7",
    authorLogin: "tester",
    labels: ["bug"],
  },
  reproduction: null,
};

describe("DecisionEngine", () => {
  it("delegates to the underlying provider on success", async () => {
    const decision: Decision = {
      classification: "VERIFIED",
      component: "mobile",
      team: "Mobile",
      confidence: 0.8,
      labels: ["bug"],
      summary: "s",
      reasoning: "r",
      nextAction: "n",
    };
    const provider: AiProvider = { generateDecision: vi.fn().mockResolvedValue(decision) };
    const engine = new DecisionEngine(provider, new PinoLoggerService({ level: "silent" }));
    const result = await engine.decide(sampleInput);
    expect(result).toEqual(decision);
  });

  it("falls back to a safe manual-investigation decision when the provider throws", async () => {
    const provider: AiProvider = { generateDecision: vi.fn().mockRejectedValue(new Error("rate limited")) };
    const engine = new DecisionEngine(provider, new PinoLoggerService({ level: "silent" }));
    const result = await engine.decide(sampleInput);
    expect(result.classification).toBe("NEEDS_MANUAL_INVESTIGATION");
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toContain("rate limited");
  });
});
