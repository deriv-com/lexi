import { describe, expect, it } from "vitest";
import { OpenAiCompatLlmClient, toChatMessages } from "./openai-compat-client";
import type { LlmMessage } from "./types";

function client(body: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wire bodies are asserted on by path
  const requests: Array<{ url: string; body: Record<string, any> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const llm = new OpenAiCompatLlmClient({ apiKey: "test-key", baseURL: "https://gateway.test/v1", model: "open-model-1", fetch: fetchImpl });
  return { llm, requests };
}

function chat(message: Record<string, unknown>, finish: string | null, usage?: Record<string, unknown>) {
  return { id: "c1", object: "chat.completion", created: 0, model: "open-model-1", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }], ...(usage ? { usage } : {}) };
}

describe("OpenAiCompatLlmClient", () => {
  it("normalises tool calls to Anthropic-shaped blocks", async () => {
    const { llm, requests } = client(
      chat(
        { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"login"}' } }] },
        "tool_calls",
        { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 60 } },
      ),
    );
    const result = await llm.complete([{ role: "user", content: "find it" }], [{ name: "search", description: "s", input_schema: { type: "object" } }], {
      system: [{ text: "base", cacheable: true }],
    });
    expect(requests[0].url).toBe("https://gateway.test/v1/chat/completions");
    expect(requests[0].body.messages[0]).toEqual({ role: "system", content: "base" });
    expect(requests[0].body.tools[0]).toEqual({ type: "function", function: { name: "search", description: "s", parameters: { type: "object" } } });
    expect(result.toolUses).toEqual([{ id: "call_1", name: "search", input: { q: "login" } }]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.usage).toEqual({ promptTokens: 40, completionTokens: 10, totalTokens: 110, cachedInputTokens: 60, cacheCreationInputTokens: 0 });
  });

  it("maps length to max_tokens and keeps the partial text", async () => {
    const { llm } = client(chat({ content: "partial" }, "length"));
    expect(await llm.complete([{ role: "user", content: "x" }], [])).toMatchObject({ text: "partial", stopReason: "max_tokens" });
  });

  it("reports a refusal with the model's explanation", async () => {
    const { llm } = client(chat({ content: null, refusal: "I can't help with that." }, "stop"));
    expect(await llm.complete([{ role: "user", content: "x" }], [])).toMatchObject({ text: "I can't help with that.", stopReason: "refusal" });
  });

  it("fails loudly when it claims tool calls but returns none", async () => {
    const { llm } = client(chat({ content: null, tool_calls: [] }, "tool_calls"));
    await expect(llm.complete([{ role: "user", content: "x" }], [])).rejects.toThrow(/no tool calls/);
  });

  it("sends tool_choice none only alongside tools", async () => {
    const { llm, requests } = client(chat({ content: "ok" }, "stop"));
    await llm.complete([{ role: "user", content: "x" }], [{ name: "t", description: "t", input_schema: {} }], { toolChoice: "none" });
    expect(requests[0].body.tool_choice).toBe("none");
  });
});

describe("toChatMessages", () => {
  it("turns tool results into tool messages ahead of any user text, and images into data URLs", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "what is this" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "look", input: { a: 1 } }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "seen" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } }], is_error: true },
          { type: "text", text: "now answer" },
        ],
      },
    ];
    expect(toChatMessages(messages)).toEqual([
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, { type: "text", text: "what is this" }] },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "look", arguments: '{"a":1}' } }] },
      { role: "tool", tool_call_id: "t1", content: "[tool error] seen\n[1 image(s) returned by the tool cannot be shown on this model's tool channel]" },
      { role: "user", content: [{ type: "text", text: "now answer" }] },
    ]);
  });
});
