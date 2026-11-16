import { describe, expect, it, vi } from "vitest";
import type { MemoryPack } from "@lexi/contracts";
import {
  createMemoryToolModule,
  MEMORY_FORGET_TEAM_PERMISSION,
  MEMORY_RECALL_PERMISSION,
  MEMORY_REMEMBER_PERMISSION,
  type MemoryToolsPort,
} from "./memory-module";
import { staticRepoScope } from "../shared/repo-scope";
import { ctx, text, toolOf } from "../testing/fixtures";

function pack(overrides: Partial<MemoryPack> = {}): MemoryPack {
  return { episodes: [], digests: [], decisions: [], rendered: "", tokenCost: 0, budget: { maxTokens: 2000 }, truncated: false, ...overrides };
}

function port(overrides: Partial<MemoryToolsPort> = {}): MemoryToolsPort {
  return {
    recall: vi.fn(async () => pack()),
    remember: vi.fn(async () => undefined),
    forgetOwnPreferences: vi.fn(async () => 2),
    forgetTeamConventions: vi.fn(async () => 0),
    ...overrides,
  };
}

describe("memory tools", () => {
  it("declares permissions and no mutation", () => {
    const module = createMemoryToolModule({ memory: port(), knowledge: { search: vi.fn(async () => []) } });
    const byName = Object.fromEntries(module.tools.map((t) => [t.definition.name, t]));
    expect(byName.recall_memory.requiredPermission).toBe(MEMORY_RECALL_PERMISSION);
    for (const name of ["remember_preference", "remember_team_convention", "forget_about_me"]) {
      expect(byName[name].requiredPermission).toBe(MEMORY_REMEMBER_PERMISSION);
    }
    // Clearing conventions removes them for everyone, so adding one is not enough.
    expect(byName.forget_team_convention.requiredPermission).toBe(MEMORY_FORGET_TEAM_PERMISSION);
    expect(byName.search_product_knowledge.requiredPermission).toBeUndefined();
    expect(module.tools.every((t) => !t.mutating)).toBe(true);
  });

  it("reports a resource only where the call is the caller's own or names a repository", async () => {
    const module = createMemoryToolModule({
      memory: port(),
      knowledge: { search: vi.fn(async () => []) },
      repositories: staticRepoScope([{ slug: "acme/web", team: "home" }]),
    });
    const resourceOf = (name: string, args: Record<string, unknown>) => toolOf(module, name).resource?.(args, ctx);
    expect(await resourceOf("recall_memory", { query: "q", scope: "personal" })).toEqual({ callerOnly: true });
    expect(await resourceOf("recall_memory", { query: "q" })).toBeUndefined();
    expect(await resourceOf("remember_preference", { preference: "p" })).toEqual({ callerOnly: true });
    expect(await resourceOf("forget_about_me", {})).toEqual({ callerOnly: true });
    expect(await resourceOf("remember_team_convention", { convention: "c" })).toBeUndefined();
    expect(await resourceOf("forget_team_convention", {})).toBeUndefined();
    expect(await resourceOf("search_product_knowledge", { query: "q", repo: "acme/web" })).toEqual({ repository: "acme/web", team: "home" });
    expect(await resourceOf("search_product_knowledge", { query: "q" })).toBeUndefined();
    expect(await resourceOf("search_product_knowledge", { query: "q", repo: "acme/other" })).toBeUndefined();
  });

  it("no schema lets the model name a memory subject", () => {
    const module = createMemoryToolModule({ memory: port() });
    for (const tool of module.tools) {
      const props = Object.keys((tool.definition.input_schema.properties ?? {}) as object);
      expect(props.some((p) => /subject|user|actor|who/i.test(p))).toBe(false);
    }
  });

  it("records a preference against the caller only", async () => {
    const memory = port();
    const result = await toolOf(createMemoryToolModule({ memory }), "remember_preference").invoke(
      { preference: "Keep answers short", basis: "observed", subjectUserId: "U0TEST99" },
      ctx,
    );
    expect(memory.remember).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "user", subjectUserId: "U0TEST01", kind: "preference", confidence: 0.7 }),
    );
    expect(text(result)).toContain('Recorded: "Keep answers short"');
  });

  it("records a team convention at org scope with attribution", async () => {
    const memory = port();
    await toolOf(createMemoryToolModule({ memory }), "remember_team_convention").invoke({ convention: "Tag the author on handovers", scope_note: "#releases" }, ctx);
    expect(memory.remember).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "org", kind: "decision", content: "Tag the author on handovers (applies: #releases)", provenance: expect.objectContaining({ actor: "U0TEST01" }) }),
    );
  });

  it("recalls personal memory for the caller and team memory at org scope", async () => {
    const memory = port({ recall: vi.fn(async () => pack({ episodes: [{} as never], rendered: "- prefers terse answers" })) });
    const tool = toolOf(createMemoryToolModule({ memory, recallTokenBudget: 500 }), "recall_memory");
    const out = text(await tool.invoke({ query: "style", scope: "personal" }, ctx));
    expect(memory.recall).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "style", scope: "user", subjectUserId: "U0TEST01", threadKey: "C0TEST01:1700000000.000100" }),
      { maxTokens: 500 },
    );
    expect(out).toContain("prefers terse answers");
    await tool.invoke({ query: "style" }, ctx);
    expect(vi.mocked(memory.recall).mock.calls[1][0]).toMatchObject({ scope: "org" });
    expect(vi.mocked(memory.recall).mock.calls[1][0]).not.toHaveProperty("subjectUserId");
  });

  it("says when nothing is recalled", async () => {
    const out = text(await toolOf(createMemoryToolModule({ memory: port() }), "recall_memory").invoke({ query: "x" }, ctx));
    expect(out).toContain("Nothing shared is recorded");
  });

  it("does not claim a write stuck when memory fails", async () => {
    const memory = port({ remember: vi.fn(async () => { throw new Error("db down"); }) });
    const result = await toolOf(createMemoryToolModule({ memory }), "remember_preference").invoke({ preference: "x" }, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("nothing was recorded");
  });

  it("forgets only the caller's preferences and reports counts", async () => {
    const memory = port();
    const module = createMemoryToolModule({ memory });
    expect(text(await toolOf(module, "forget_about_me").invoke({ contains: "terse" }, ctx))).toContain("Removed 2");
    expect(memory.forgetOwnPreferences).toHaveBeenCalledWith("U0TEST01", "terse");
    expect(text(await toolOf(module, "forget_team_convention").invoke({ contains: "x" }, ctx))).toContain('Nothing matched "x"');
  });

  it("omits the forget tools when the port cannot forget", () => {
    const names = createMemoryToolModule({ memory: { recall: vi.fn(), remember: vi.fn() } }).tools.map((t) => t.definition.name);
    expect(names).toEqual(["recall_memory", "remember_preference", "remember_team_convention"]);
  });

  it("searches product knowledge", async () => {
    const search = vi.fn(async () => [{ id: "1", sourceType: "repo_doc", sourceRef: "README.md", repo: "acme/web", content: "Checkout retries twice.", similarity: 0.81234 }]);
    const out = JSON.parse(text(await toolOf(createMemoryToolModule({ memory: port(), knowledge: { search } }), "search_product_knowledge").invoke({ query: "retry", limit: 99 }, ctx)));
    expect(search).toHaveBeenCalledWith("retry", { limit: 40 });
    expect(out.results[0]).toMatchObject({ sourceRef: "README.md", similarity: 0.812 });
  });
});
