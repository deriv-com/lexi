import { describe, expect, it, vi } from "vitest";
import { ScriptedLlm, textCompletion, toolCallCompletion } from "../llm/test-double";
import type { LlmContentBlock, LlmToolResultBlock } from "../llm/types";
import type { AgentObserver } from "../observer";
import type { AgentTool, ToolCallContext, ToolModule, ToolResult } from "../tools/agent-tool";
import type { Authorizer } from "../tools/authorizer";
import { ToolRegistry } from "../tools/tool-registry";
import type { TurnInput } from "../turn";
import { AgentRuntime, buildMessages, type AgentRuntimeOptions } from "./agent-runtime";

const allow: Authorizer = { authorize: () => ({ allowed: true, reason: "allowed" }) };

const input: TurnInput = {
  actorId: "U0TEST01",
  conversation: { channel: "C0TEST01", threadTs: "1700000000.000100" },
  text: "What is in the README?",
};

function readTool(name: string, result: (args: Record<string, unknown>, ctx: ToolCallContext) => ToolResult | Promise<ToolResult>): AgentTool {
  return {
    definition: { name, description: name, input_schema: { type: "object", properties: {} } },
    invoke: vi.fn(async (args: Record<string, unknown>, ctx: ToolCallContext) => result(args, ctx)),
  };
}

function writeTool(name: string, result?: (args: Record<string, unknown>) => ToolResult): AgentTool {
  return {
    definition: { name, description: name, input_schema: { type: "object", properties: {} } },
    mutating: true,
    requiredPermission: "issue.comment",
    invoke: vi.fn(async (args: Record<string, unknown>) =>
      result ? result(args) : { content: "done", outcome: { authorized: true, executed: true, blocked: false, reason: "comment posted" } },
    ),
  };
}

function runtime(llm: ScriptedLlm, modules: ToolModule[], extra: Partial<AgentRuntimeOptions> = {}) {
  const registry = new ToolRegistry({ authorizer: allow });
  for (const module of modules) registry.register(module);
  return new AgentRuntime({ llm, registry, ...extra });
}

/** The tool_result blocks of the last user message the model was sent. */
function lastToolResults(llm: ScriptedLlm): LlmToolResultBlock[] {
  const messages = llm.requests[llm.requests.length - 1].messages;
  const last = messages[messages.length - 1];
  return (last.content as LlmContentBlock[]).filter((b): b is LlmToolResultBlock => b.type === "tool_result");
}

function lastText(llm: ScriptedLlm): string {
  const messages = llm.requests[llm.requests.length - 1].messages;
  const last = messages[messages.length - 1];
  return (last.content as LlmContentBlock[])
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

describe("AgentRuntime", () => {
  it("returns the model's answer", async () => {
    const llm = new ScriptedLlm([textCompletion("The README describes setup.")]);
    const result = await runtime(llm, []).runTurn(input);
    expect(result).toMatchObject({ outcome: "answered", text: "The README describes setup.", iterations: 1, toolCalls: [] });
  });

  it("runs tool calls with identity from the turn input, never from model output", async () => {
    const read = readTool("read_file", (_args, ctx) => ({ content: `read as ${ctx.actorId}` }));
    const llm = new ScriptedLlm([
      toolCallCompletion([{ name: "read_file", input: { path: "README.md", actorId: "U0OTHER9" } }]),
      textCompletion("Done."),
    ]);
    const result = await runtime(llm, [{ name: "files", tools: [read] }]).runTurn(input);

    expect(result).toMatchObject({ outcome: "answered", text: "Done.", iterations: 2, toolCalls: [{ name: "read_file", isError: false }] });
    const ctx = (read.invoke as ReturnType<typeof vi.fn>).mock.calls[0][1] as ToolCallContext;
    expect(ctx.actorId).toBe("U0TEST01");
    expect(ctx.conversation).toEqual(input.conversation);
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(lastToolResults(llm)[0].content).toBe("read as U0TEST01");
  });

  it("builds the system prompt from the base, module sections and extra sections, and subsets tools by intent", async () => {
    const llm = new ScriptedLlm([textCompletion("ok")]);
    const core: ToolModule = { name: "core", tools: [readTool("core_read", () => ({ content: "" }))], promptSections: [{ stable: true, text: "core guidance" }] };
    const specOnly: ToolModule = {
      name: "spec",
      intentClasses: ["spec"],
      tools: [readTool("spec_read", () => ({ content: "" }))],
      promptSections: [{ stable: true, text: "spec guidance" }],
    };
    await runtime(llm, [core, specOnly], {
      prompt: {
        agentName: "Ada",
        sections: [
          { stable: false, text: "volatile note" },
          { id: "asker", order: 1, stable: false, render: (c) => `asked by ${c.actorId}` },
        ],
      },
    }).runTurn({ ...input, intentClass: "issue_query" });

    const request = llm.requests[0];
    expect(request.tools.map((t) => t.name)).toEqual(["core_read"]);
    const system = request.options.system ?? [];
    expect(system[0].text).toContain("You are Ada");
    expect(system.map((s) => [s.text.slice(0, 20), s.cacheable])).toEqual([
      [system[0].text.slice(0, 20), true],
      ["core guidance", true],
      ["volatile note", false],
      ["asked by U0TEST01", false],
    ]);
    expect(request.options.toolChoice).toBe("auto");
  });

  it("uses the routed model for the intent class", async () => {
    const llm = new ScriptedLlm([textCompletion("ok")]);
    await runtime(llm, [], { modelRouting: { byIntent: { spec: "claude-opus-5-5" } } }).runTurn({ ...input, intentClass: "spec" });
    expect(llm.requests[0].options.model).toBe("claude-opus-5-5");
  });

  it("reports a refusal as refused, with the model's explanation, never as empty text", async () => {
    const llm = new ScriptedLlm([textCompletion("", "refusal")]);
    const result = await runtime(llm, []).runTurn(input);
    expect(result.outcome).toBe("refused");
    expect(result.text).toContain("declined");

    const explained = await runtime(new ScriptedLlm([textCompletion("Not something I can help with.", "refusal")]), []).runTurn(input);
    expect(explained.text).toContain("Not something I can help with.");
  });

  it("marks an answer cut off at the length limit", async () => {
    const result = await runtime(new ScriptedLlm([textCompletion("Partial answer", "max_tokens")]), []).runTurn(input);
    expect(result.outcome).toBe("answered");
    expect(result.text).toMatch(/^Partial answer\n\n\(This reply was cut off/);
  });

  it("treats an empty reply at the length limit as an error with an explanation", async () => {
    const result = await runtime(new ScriptedLlm([textCompletion("", "max_tokens")]), []).runTurn(input);
    expect(result.outcome).toBe("llm_error");
    expect(result.text).toContain("output allowance");
  });

  it("nudges once after an empty reply, then answers", async () => {
    const llm = new ScriptedLlm([textCompletion(""), textCompletion("Here it is.")]);
    const result = await runtime(llm, []).runTurn(input);
    expect(result).toMatchObject({ outcome: "answered", text: "Here it is.", iterations: 2 });
    expect(lastText(llm)).toContain("previous reply was empty");
  });

  it("gives up with non-empty text after two empty replies", async () => {
    const result = await runtime(new ScriptedLlm([textCompletion("")]), []).runTurn(input);
    expect(result.outcome).toBe("llm_error");
    expect(result.text).toContain("empty reply twice");
    expect(result.text).toContain("No tools had run.");
  });

  it("does not run tool calls from a reply cut off at the length limit", async () => {
    const write = writeTool("comment");
    const cutOff = { ...toolCallCompletion([{ name: "comment", input: { body: "half" } }]), stopReason: "max_tokens" };
    const llm = new ScriptedLlm([cutOff, textCompletion("Retrying later.")]);
    const result = await runtime(llm, [{ name: "w", tools: [write] }]).runTurn(input);
    expect(write.invoke).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual([{ name: "comment", isError: true, executed: false }]);
    expect(lastToolResults(llm)[0]).toMatchObject({ is_error: true, content: expect.stringContaining("cut off") });
  });

  it("lists executed actions when the iteration limit stops the turn", async () => {
    const write = writeTool("comment");
    const llm = new ScriptedLlm([
      toolCallCompletion([{ name: "comment", input: { body: "one" } }]),
      toolCallCompletion([{ name: "comment", input: { body: "two" } }]),
    ]);
    const result = await runtime(llm, [{ name: "w", tools: [write] }], { limits: { maxIterations: 2 } }).runTurn(input);
    expect(result.outcome).toBe("max_iterations");
    expect(result.iterations).toBe(2);
    expect(result.text).toContain("limit of 2 steps");
    expect(result.text).toContain("These actions already ran and were not undone");
    expect(result.text).toContain("- comment (comment posted)");
    expect(result.toolCalls).toEqual([
      { name: "comment", isError: false, executed: true },
      { name: "comment", isError: false, executed: true },
    ]);
  });

  it("does not count a refused write as executed", async () => {
    const write = writeTool("comment");
    const registry = new ToolRegistry({ authorizer: { authorize: () => ({ allowed: false, reason: "alice may not comment" }) } }).register({
      name: "w",
      tools: [write],
    });
    const llm = new ScriptedLlm([toolCallCompletion([{ name: "comment", input: {} }])]);
    const result = await new AgentRuntime({ llm, registry, limits: { maxIterations: 1 } }).runTurn(input);
    expect(result.toolCalls).toEqual([{ name: "comment", isError: true, executed: false }]);
    expect(result.text).toContain("No action that changes anything had run");
  });

  it("restates the governed outcome next to the tool's text", async () => {
    const write = writeTool("comment", () => ({ content: "queued", outcome: { authorized: true, executed: false, blocked: true, reason: "writes are disabled" } }));
    const llm = new ScriptedLlm([toolCallCompletion([{ name: "comment", input: {} }]), textCompletion("It was blocked.")]);
    await runtime(llm, [{ name: "w", tools: [write] }]).runTurn(input);
    expect(lastToolResults(llm)[0].content).toBe(
      "queued\n[Governed outcome: authorized=true, executed=false, blocked=true. Reason: writes are disabled]",
    );
  });

  it("stops at the deadline before the next call and reports what ran", async () => {
    let now = 0;
    const write = writeTool("comment", () => {
      now += 61_000;
      return { content: "done", outcome: { authorized: true, executed: true, blocked: false, reason: "comment posted" } };
    });
    const llm = new ScriptedLlm([toolCallCompletion([{ name: "comment", input: { body: "a" } }, { name: "comment", input: { body: "b" } }])]);
    const result = await runtime(llm, [{ name: "w", tools: [write] }], { clock: () => now, limits: { wallClockMs: 60_000 } }).runTurn(input);
    expect(result.outcome).toBe("timeout");
    expect(write.invoke).toHaveBeenCalledTimes(1);
    expect(result.text).toContain("ran out of time");
    expect(result.text).toContain("1 minute");
    expect(result.text).toContain("This action already ran and was not undone");
  });

  it("returns cancelled without calling the model when the signal is already aborted", async () => {
    const llm = new ScriptedLlm([textCompletion("never")]);
    const controller = new AbortController();
    controller.abort();
    const result = await runtime(llm, []).runTurn(input, { signal: controller.signal });
    expect(result.outcome).toBe("cancelled");
    expect(llm.callCount).toBe(0);
    expect(result.text).toContain("cancelled");
  });

  it("stops when cancelled mid-turn and lists the write that already ran", async () => {
    const controller = new AbortController();
    const write = writeTool("comment", () => {
      controller.abort();
      return { content: "done", outcome: { authorized: true, executed: true, blocked: false, reason: "comment posted" } };
    });
    const llm = new ScriptedLlm([toolCallCompletion([{ name: "comment", input: {} }]), textCompletion("never")]);
    const result = await runtime(llm, [{ name: "w", tools: [write] }]).runTurn(input, { signal: controller.signal });
    expect(result.outcome).toBe("cancelled");
    expect(llm.callCount).toBe(1);
    expect(result.text).toContain("- comment (comment posted)");
  });

  it("aborts an in-flight model call when the caller cancels", async () => {
    const controller = new AbortController();
    const llm = new ScriptedLlm([
      ({ options }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          setTimeout(() => controller.abort(), 5);
        }),
    ]);
    const result = await runtime(llm, []).runTurn(input, { signal: controller.signal });
    expect(result.outcome).toBe("cancelled");
  });

  it("reports a failed model call without echoing the provider's response", async () => {
    const error = Object.assign(new Error("400 secret-request-id prompt fragment"), { status: 400 });
    const result = await runtime(new ScriptedLlm([error]), []).runTurn(input);
    expect(result.outcome).toBe("llm_error");
    expect(result.text).toContain("HTTP 400");
    expect(result.text).not.toContain("secret-request-id");
  });

  it("trims an oversized tool result with an explicit note", async () => {
    const read = readTool("read_file", () => ({ content: "x".repeat(10_000) }));
    const llm = new ScriptedLlm([toolCallCompletion([{ name: "read_file", input: {} }]), textCompletion("ok")]);
    await runtime(llm, [{ name: "files", tools: [read] }], { limits: { maxToolResultChars: 2_000 } }).runTurn(input);
    const content = lastToolResults(llm)[0].content as string;
    expect(content.length).toBeLessThanOrEqual(2_000);
    expect(content).toContain("Truncated by the runtime");
    const ctx = (read.invoke as ReturnType<typeof vi.fn>).mock.calls[0][1] as ToolCallContext;
    expect(ctx.maxResultChars).toBe(2_000);
  });

  it("asks for a final answer, with tools disabled, once a read keeps returning the same result", async () => {
    const read = readTool("get_run", () => ({ content: "in_progress" }));
    const llm = new ScriptedLlm([
      toolCallCompletion([{ name: "get_run", input: { id: 1 } }]),
      toolCallCompletion([{ name: "get_run", input: { id: 1 } }]),
      toolCallCompletion([{ name: "get_run", input: { id: 1 } }]),
      ({ options }) => (options.toolChoice === "none" ? textCompletion("The run is still in progress.") : toolCallCompletion([{ name: "get_run", input: { id: 1 } }])),
    ]);
    const result = await runtime(llm, [{ name: "runs", tools: [read] }], { limits: { maxRepeatedToolCalls: 2 } }).runTurn(input);
    expect(result).toMatchObject({ outcome: "answered", text: "The run is still in progress.", iterations: 4 });
    expect(read.invoke).toHaveBeenCalledTimes(3);
    expect(llm.requests[3].options.toolChoice).toBe("none");
    expect(lastText(llm)).toContain("Tool use is stopped");
  });

  it("does not stop a turn whose distinct writes all acknowledge identically", async () => {
    const write = writeTool("remember", () => ({ content: '{"ok":true}', outcome: { authorized: true, executed: true, blocked: false, reason: "saved" } }));
    const llm = new ScriptedLlm([
      toolCallCompletion([{ name: "remember", input: { key: "a" } }, { name: "remember", input: { key: "b" } }, { name: "remember", input: { key: "c" } }]),
      textCompletion("Saved all three."),
    ]);
    const result = await runtime(llm, [{ name: "memory", tools: [write] }], { limits: { maxRepeatedToolCalls: 1 } }).runTurn(input);
    expect(result).toMatchObject({ outcome: "answered", text: "Saved all three." });
    expect(write.invoke).toHaveBeenCalledTimes(3);
    expect(llm.requests[1].options.toolChoice).toBe("auto");
  });

  it("does not repeat an identical write that already ran", async () => {
    const write = writeTool("comment");
    const llm = new ScriptedLlm([
      toolCallCompletion([{ name: "comment", input: { body: "hi" } }]),
      toolCallCompletion([{ name: "comment", input: { body: "hi" } }]),
      textCompletion("Posted once."),
    ]);
    const result = await runtime(llm, [{ name: "w", tools: [write] }]).runTurn(input);
    expect(write.invoke).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toEqual([
      { name: "comment", isError: false, executed: true },
      { name: "comment", isError: false, executed: false },
    ]);
    expect(lastToolResults(llm)[0].content).toContain("Not run again");
  });

  it("refuses unknown tools through the registry and keeps going", async () => {
    const llm = new ScriptedLlm([toolCallCompletion([{ name: "made_up", input: {} }]), textCompletion("I don't have that tool.")]);
    const result = await runtime(llm, []).runTurn(input);
    expect(result.toolCalls).toEqual([{ name: "made_up", isError: true }]);
    expect(lastToolResults(llm)[0]).toMatchObject({ is_error: true });
    expect(result.outcome).toBe("answered");
  });

  it("notifies the observer, and an observer that throws does not affect the turn", async () => {
    const onLlmCall = vi.fn(() => {
      throw new Error("observer bug");
    });
    const onTurnEnd = vi.fn();
    const observer: AgentObserver = { onLlmCall, onTurnEnd };
    const result = await runtime(new ScriptedLlm([textCompletion("ok")]), [], { observer }).runTurn(input);
    expect(result.outcome).toBe("answered");
    expect(onLlmCall).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-sonnet-5-5", stopReason: "end_turn" }));
    expect(onTurnEnd).toHaveBeenCalledWith(expect.objectContaining({ outcome: "answered", iterations: 1, conversation: input.conversation }));
  });
});

describe("buildMessages", () => {
  it("labels authors, merges consecutive turns, opens with a user turn and puts images first", () => {
    const messages = buildMessages({
      ...input,
      text: "and this?",
      history: [
        { role: "assistant", text: "Earlier reply" },
        { role: "user", text: "first", authorId: "U0TEST02" },
        { role: "user", text: "second", authorId: "U0TEST02" },
        { role: "assistant", text: "   " },
      ],
      attachments: [{ mediaType: "image/png", data: "AAAA" }],
    });
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "(Earlier messages in this conversation follow.)" }] },
      { role: "assistant", content: [{ type: "text", text: "Earlier reply" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "[from U0TEST02] first" },
          { type: "text", text: "[from U0TEST02] second" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "text", text: "[from U0TEST01] and this?" },
        ],
      },
    ]);
  });

  it("never sends an empty user message", () => {
    expect(buildMessages({ ...input, text: "  " })).toEqual([{ role: "user", content: [{ type: "text", text: "(empty message)" }] }]);
  });
});
