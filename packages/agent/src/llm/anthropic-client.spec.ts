import { describe, expect, it } from "vitest";
import { AnthropicLlmClient, ANTHROPIC_MAX_CACHE_BREAKPOINTS, countCacheBreakpoints, type LlmClientOptions } from "./anthropic-client";
import type { LlmToolDefinition } from "./types";

function fakeTransport(body: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wire bodies are asserted on by path
  const requests: Array<{ url: string; body: Record<string, any> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, requests };
}

const RESPONSE = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [
    { type: "text", text: "Looking." },
    { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "README.md" } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 },
};

const TOOLS: LlmToolDefinition[] = [
  { name: "read_file", description: "Read a file", input_schema: { type: "object", properties: {} } },
  { name: "search", description: "Search", input_schema: { type: "object", properties: {} } },
];

function client(extra: Partial<LlmClientOptions> = {}, body: Record<string, unknown> = RESPONSE) {
  const transport = fakeTransport(body);
  const llm = new AnthropicLlmClient({ apiKey: "test-key", baseURL: "https://gateway.test", model: "claude-sonnet-5-5", fetch: transport.fetchImpl, ...extra });
  return { llm, ...transport };
}

describe("AnthropicLlmClient", () => {
  it("parses text, tool calls, stop reason and cache accounting", async () => {
    const { llm, requests } = client();
    const result = await llm.complete([{ role: "user", content: "hi" }], TOOLS);
    expect(requests[0].url).toBe("https://gateway.test/v1/messages");
    expect(result.text).toBe("Looking.");
    expect(result.toolUses).toEqual([{ id: "toolu_1", name: "read_file", input: { path: "README.md" } }]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedInputTokens: 900, cacheCreationInputTokens: 50 });
  });

  it("puts stable system segments first and closes them and the tool array with breakpoints", async () => {
    const { llm, requests } = client();
    await llm.complete([{ role: "user", content: "hi" }], TOOLS, {
      system: [
        { text: "base", cacheable: true },
        { text: "per-turn memory", cacheable: false },
        { text: "tool guidance", cacheable: true },
        { text: "   ", cacheable: true },
      ],
    });
    const body = requests[0].body;
    expect(body.system).toEqual([
      { type: "text", text: "base" },
      { type: "text", text: "tool guidance", cache_control: { type: "ephemeral" } },
      { type: "text", text: "per-turn memory" },
    ]);
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(countCacheBreakpoints(body)).toBe(2);
    expect(body).not.toHaveProperty("temperature");
  });

  it("sends no breakpoints when caching is disabled", async () => {
    const { llm, requests } = client({ caching: { enabled: false } });
    await llm.complete([{ role: "user", content: "hi" }], TOOLS, { system: [{ text: "base", cacheable: true }] });
    expect(countCacheBreakpoints(requests[0].body)).toBe(0);
  });

  it("refuses to build a request past the breakpoint ceiling", () => {
    const { llm } = client();
    const marked = { role: "user" as const, content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] };
    const messages = Array.from({ length: ANTHROPIC_MAX_CACHE_BREAKPOINTS - 1 }, () => marked) as never;
    expect(() => llm.buildRequest(messages, TOOLS, { system: [{ text: "base", cacheable: true }] })).toThrow(/cache breakpoints/);
  });

  it("omits tools entirely when there are none, and forwards tool_choice none", async () => {
    const { llm, requests } = client();
    await llm.complete([{ role: "user", content: "hi" }], []);
    expect(requests[0].body).not.toHaveProperty("tools");
    await llm.complete([{ role: "user", content: "hi" }], TOOLS, { toolChoice: "none" });
    expect(requests[1].body.tool_choice).toEqual({ type: "none" });
  });

  it("reports a refusal with empty content as stop reason refusal, not as silence", async () => {
    const { llm } = client({}, { ...RESPONSE, content: [], stop_reason: "refusal" });
    const result = await llm.complete([{ role: "user", content: "hi" }], []);
    expect(result).toMatchObject({ text: "", toolUses: [], stopReason: "refusal" });
  });

  it("drops block types the loop does not understand", async () => {
    const { llm } = client({}, { ...RESPONSE, content: [{ type: "thinking", thinking: "...", signature: "s" }, { type: "text", text: "ok" }], stop_reason: "end_turn" });
    const result = await llm.complete([{ role: "user", content: "hi" }], []);
    expect(result.message.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("uses a per-request model override", async () => {
    const { llm, requests } = client();
    await llm.complete([{ role: "user", content: "hi" }], [], { model: "claude-opus-5-5" });
    expect(requests[0].body.model).toBe("claude-opus-5-5");
  });
});
