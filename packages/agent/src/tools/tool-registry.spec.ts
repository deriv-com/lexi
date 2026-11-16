import { describe, expect, it, vi } from "vitest";
import type { AgentTool, ToolCallContext } from "./agent-tool";
import type { Authorizer } from "./authorizer";
import { ToolRegistry } from "./tool-registry";

const ctx: ToolCallContext = {
  actorId: "U0TEST01",
  conversation: { channel: "C0TEST01", threadTs: "1700000000.000100" },
  maxResultChars: 10_000,
};

function tool(name: string, extra: Partial<AgentTool> = {}): AgentTool {
  return {
    definition: { name, description: name, input_schema: { type: "object", properties: {} } },
    invoke: vi.fn(async () => ({ content: `${name} ran` })),
    ...extra,
  };
}

const allow: Authorizer = { authorize: () => ({ allowed: true, reason: "ok" }) };

describe("ToolRegistry", () => {
  it("runs a read-only tool without asking the authorizer", async () => {
    const authorize = vi.fn();
    const registry = new ToolRegistry({ authorizer: { authorize } }).register({ name: "m", tools: [tool("read")] });
    expect(await registry.invoke("read", {}, ctx)).toEqual({ content: "read ran" });
    expect(authorize).not.toHaveBeenCalled();
  });

  it("refuses a tool it does not know", async () => {
    const registry = new ToolRegistry();
    const result = await registry.invoke("made_up", {}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("made_up");
  });

  it("denies governed tools when no authorizer is configured", async () => {
    const write = tool("write", { mutating: true, requiredPermission: "issue.comment" });
    const registry = new ToolRegistry().register({ name: "m", tools: [write] });
    const result = await registry.invoke("write", {}, ctx);
    expect(result.outcome).toMatchObject({ authorized: false, executed: false, blocked: true });
    expect(write.invoke).not.toHaveBeenCalled();
  });

  it("passes the actor, permission and resource to the authorizer", async () => {
    const authorize = vi.fn(() => ({ allowed: true, reason: "ok" }));
    const write = tool("comment", {
      mutating: true,
      requiredPermission: "issue.comment",
      resource: (args) => ({ issueNumber: args.number as number }),
    });
    const registry = new ToolRegistry({ authorizer: { authorize } }).register({ name: "m", tools: [write] });
    await registry.invoke("comment", { number: 7 }, ctx);
    expect(authorize).toHaveBeenCalledWith({ actorId: "U0TEST01", action: "issue.comment", resource: { issueNumber: 7 } });
    expect(write.invoke).toHaveBeenCalledOnce();
  });

  it("awaits an async resource and hands it the call context", async () => {
    const authorize = vi.fn(() => ({ allowed: true, reason: "ok" }));
    const resource = vi.fn(async () => ({ repository: "acme/web", team: "home" }));
    const write = tool("pause", { mutating: true, requiredPermission: "programme.pause", resource });
    const registry = new ToolRegistry({ authorizer: { authorize } }).register({ name: "m", tools: [write] });
    await registry.invoke("pause", { programmeKey: "p" }, ctx);
    expect(resource).toHaveBeenCalledWith({ programmeKey: "p" }, ctx);
    expect(authorize).toHaveBeenCalledWith({
      actorId: "U0TEST01",
      action: "programme.pause",
      resource: { repository: "acme/web", team: "home" },
    });
  });

  it("treats a resource lookup that fails as a denial", async () => {
    const authorize = vi.fn(() => ({ allowed: true, reason: "ok" }));
    const write = tool("pause", {
      mutating: true,
      requiredPermission: "programme.pause",
      resource: async () => {
        throw new Error("store down");
      },
    });
    const registry = new ToolRegistry({ authorizer: { authorize } }).register({ name: "m", tools: [write] });
    const result = await registry.invoke("pause", {}, ctx);
    expect(result.outcome).toMatchObject({ authorized: false, executed: false });
    expect(authorize).not.toHaveBeenCalled();
    expect(write.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["throws", { authorize: () => { throw new Error("boom"); } }],
    ["rejects", { authorize: () => Promise.reject(new Error("down")) }],
    ["returns nothing", { authorize: () => undefined as never }],
    ["returns a truthy non-boolean", { authorize: () => ({ allowed: "yes" as never, reason: "" }) }],
  ] as Array<[string, unknown]>)("treats an authorizer that %s as a denial", async (_label, authorizer) => {
    const write = tool("write", { mutating: true, requiredPermission: "x" });
    const registry = new ToolRegistry({ authorizer: authorizer as Authorizer }).register({ name: "m", tools: [write] });
    const result = await registry.invoke("write", {}, ctx);
    expect(result.outcome?.authorized).toBe(false);
    expect(write.invoke).not.toHaveBeenCalled();
  });

  it("denies a governed call with no actor", async () => {
    const write = tool("write", { mutating: true, requiredPermission: "x" });
    const registry = new ToolRegistry({ authorizer: allow }).register({ name: "m", tools: [write] });
    const result = await registry.invoke("write", {}, { ...ctx, actorId: "" });
    expect(result.outcome?.authorized).toBe(false);
  });

  it("refuses to register a mutating tool without a permission", () => {
    expect(() => new ToolRegistry().register({ name: "m", tools: [tool("w", { mutating: true })] })).toThrow(/requiredPermission/);
  });

  it("refuses duplicate and invalid names", () => {
    const registry = new ToolRegistry().register({ name: "a", tools: [tool("t")] });
    expect(() => registry.register({ name: "b", tools: [tool("t")] })).toThrow(/twice/);
    expect(() => registry.register({ name: "c", tools: [tool("bad name")] })).toThrow(/invalid name/);
  });

  it("turns a throwing tool into an error result", async () => {
    const broken = tool("broken", { invoke: async () => { throw new Error("nope"); } });
    const registry = new ToolRegistry().register({ name: "m", tools: [broken] });
    expect(await registry.invoke("broken", {}, ctx)).toEqual({ isError: true, content: 'Tool "broken" failed: nope' });
  });

  it("rejects non-object arguments", async () => {
    const registry = new ToolRegistry().register({ name: "m", tools: [tool("t")] });
    expect((await registry.invoke("t", ["a"], ctx)).isError).toBe(true);
  });

  it("subsets by intent class but keeps core modules, and sends everything for unknown", () => {
    const registry = new ToolRegistry()
      .register({ name: "core", tools: [tool("core_t")] })
      .register({ name: "spec", tools: [tool("spec_t")], intentClasses: ["spec"] })
      .register({ name: "fix", tools: [tool("fix_t")], intentClasses: ["fix"] });
    const names = (cls?: string) => registry.definitions(cls).map((d) => d.name);
    expect(names("spec")).toEqual(["core_t", "spec_t"]);
    expect(names("unknown")).toEqual(["core_t", "spec_t", "fix_t"]);
    expect(names()).toEqual(["core_t", "spec_t", "fix_t"]);
  });

  it("reports refusals to the observer and survives an observer that throws", async () => {
    const onToolCall = vi.fn(() => { throw new Error("observer down"); });
    const registry = new ToolRegistry({ observer: { onToolCall } });
    await expect(registry.invoke("ghost", {}, ctx)).resolves.toMatchObject({ isError: true });
    expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({ name: "ghost", refused: "unknown_tool" }));
  });
});
