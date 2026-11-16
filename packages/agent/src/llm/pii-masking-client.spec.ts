import { createPiiMasker } from "@lexi/privacy";
import { describe, expect, it, vi } from "vitest";
import { AnthropicLlmClient } from "./anthropic-client";
import { createLlmClient } from "./llm-factory";
import { OpenAiCompatLlmClient } from "./openai-compat-client";
import { PiiMaskingLlmClient } from "./pii-masking-client";
import { ScriptedLlm, textCompletion } from "./test-double";
import type { LlmMessage, LlmToolDefinition } from "./types";

const TOOL: LlmToolDefinition = {
  name: "lookup_customer_alice@example.com_tool",
  description: "Looks up a customer.",
  input_schema: { type: "object", properties: { email: { type: "string" } } },
};

describe("PiiMaskingLlmClient", () => {
  it("masks the system prompt, history, tool calls and tool results, and leaves tool names, ids and schemas alone", async () => {
    const inner = new ScriptedLlm([textCompletion("ok")]);
    const onMasked = vi.fn();
    const llm = new PiiMaskingLlmClient(inner, createPiiMasker(), onMasked);
    const messages: LlmMessage[] = [
      { role: "user", content: "<@U0TEST01>: earlier, bob@example.com called from +44 20 7946 0958" },
      { role: "assistant", content: [{ type: "text", text: "I emailed alice@example.com." }] },
      { role: "user", content: [{ type: "text", text: "Refund card 4111 1111 1111 1111 please" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_alice@example.com", name: TOOL.name, input: { email: "alice@example.com", n: 3 } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_alice@example.com", content: "IBAN GB82 WEST 1234 5698 7654 32, ip 203.0.113.7" },
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: [
              { type: "text", text: "reporter: alice@example.com" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
            ],
          },
        ],
      },
    ];
    const original = structuredClone(messages);

    await llm.complete(messages, [TOOL], {
      system: [
        { text: "You are Acme's agent. Escalate to oncall@example.com.", cacheable: true },
        { text: "Caller: <@U0TEST01>", cacheable: false },
      ],
      toolChoice: "auto",
    });

    const sent = inner.requests[0];
    expect(sent.options.system).toEqual([
      { text: "You are Acme's agent. Escalate to [email].", cacheable: true },
      { text: "Caller: <@U0TEST01>", cacheable: false },
    ]);
    expect(sent.options.toolChoice).toBe("auto");
    expect(sent.messages).toEqual([
      { role: "user", content: "<@U0TEST01>: earlier, [email] called from [phone]" },
      { role: "assistant", content: [{ type: "text", text: "I emailed [email]." }] },
      { role: "user", content: [{ type: "text", text: "Refund card [card] please" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_alice@example.com", name: TOOL.name, input: { email: "[email]", n: 3 } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_alice@example.com", content: "IBAN [iban], ip [ip]" },
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: [
              { type: "text", text: "reporter: [email]" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
            ],
          },
        ],
      },
    ]);
    // Tool definitions go through untouched, even where they look like data.
    expect(sent.tools).toEqual([TOOL]);
    // The caller's transcript is not mutated.
    expect(messages).toEqual(original);
    expect(onMasked).toHaveBeenCalledTimes(1);
    expect(onMasked.mock.calls[0][0]).toMatchObject({ email: 5, phone: 1, card: 1, iban: 1, ip: 1 });
  });

  it("does not report when there was nothing to mask", async () => {
    const onMasked = vi.fn();
    const llm = new PiiMaskingLlmClient(new ScriptedLlm([textCompletion("ok")]), createPiiMasker(), onMasked);
    await llm.complete([{ role: "user", content: "what changed in acme/repo#12?" }], []);
    expect(onMasked).not.toHaveBeenCalled();
  });

  it("passes the inner client's model and base URL through", () => {
    const llm = new PiiMaskingLlmClient(new ScriptedLlm([textCompletion("ok")], "claude-sonnet-5-5"), createPiiMasker());
    expect(llm.model).toBe("claude-sonnet-5-5");
    expect(llm.baseURL).toBe("https://llm.test");
  });
});

describe("createLlmClient PII masking", () => {
  it("masks by default, around either transport", () => {
    const claude = createLlmClient({ apiKey: "k", baseURL: "https://gateway.test", model: "claude-sonnet-5-5" });
    expect(claude).toBeInstanceOf(PiiMaskingLlmClient);
    expect((claude as PiiMaskingLlmClient).inner).toBeInstanceOf(AnthropicLlmClient);
    const other = createLlmClient({ apiKey: "k", baseURL: "https://gateway.test", model: "open-model-1" });
    expect((other as PiiMaskingLlmClient).inner).toBeInstanceOf(OpenAiCompatLlmClient);
  });

  it("does not mask when masking is turned off", () => {
    const llm = createLlmClient({ apiKey: "k", baseURL: "https://gateway.test", model: "claude-sonnet-5-5", piiMasking: false });
    expect(llm).toBeInstanceOf(AnthropicLlmClient);
  });
});
