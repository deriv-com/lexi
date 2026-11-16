import { describe, expect, it } from "vitest";
import { AnthropicLlmClient } from "./anthropic-client";
import { createLlmClient, isClaudeModel } from "./llm-factory";
import { OpenAiCompatLlmClient } from "./openai-compat-client";
import { resolveModelForIntent } from "./model-routing";

describe("createLlmClient", () => {
  it("sends Claude models to the Anthropic client without a /v1 suffix", () => {
    const llm = createLlmClient({ apiKey: "k", baseURL: "https://gateway.test/v1/", model: "claude-sonnet-5-5", piiMasking: false });
    expect(llm).toBeInstanceOf(AnthropicLlmClient);
    expect(llm.baseURL).toBe("https://gateway.test");
  });

  it("sends every other model to the OpenAI-compatible client with a /v1 suffix", () => {
    const llm = createLlmClient({ apiKey: "k", baseURL: "https://gateway.test", model: "open-model-1", piiMasking: false });
    expect(llm).toBeInstanceOf(OpenAiCompatLlmClient);
    expect(llm.baseURL).toBe("https://gateway.test/v1");
  });

  it("recognises Claude model ids case-insensitively", () => {
    expect(isClaudeModel(" Claude-sonnet-5-5")).toBe(true);
    expect(isClaudeModel("open-model-1")).toBe(false);
  });
});

describe("resolveModelForIntent", () => {
  it("prefers a pin, then the default, then the client's own model", () => {
    const routing = { defaultModel: "claude-sonnet-5-5", byIntent: { spec: "claude-opus-5-5" } };
    expect(resolveModelForIntent(routing, "spec")).toBe("claude-opus-5-5");
    expect(resolveModelForIntent(routing, "issue_query")).toBe("claude-sonnet-5-5");
    expect(resolveModelForIntent(undefined, "spec")).toBeUndefined();
    expect(resolveModelForIntent({ byIntent: { spec: "  " } }, "spec")).toBeUndefined();
  });
});
