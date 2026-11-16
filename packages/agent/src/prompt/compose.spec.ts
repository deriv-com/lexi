import { describe, expect, it, vi } from "vitest";
import { composePromptSections, composeSystemSegments, renderSystemPrompt, type DynamicPromptSection, type PromptContext } from "./compose";
import { defaultSystemPrompt } from "./default-system-prompt";

const ctx: PromptContext = { actorId: "U0TEST01", conversation: { channel: "C0TEST01", threadTs: "1700000000.000100" } };

function section(id: string, order: number, render: DynamicPromptSection["render"], stable = true): DynamicPromptSection {
  return { id, order, stable, render };
}

describe("composePromptSections", () => {
  it("orders by order then id, skips blanks and keeps the first of a duplicate id", () => {
    const out = composePromptSections(
      [
        section("b", 2, () => "two-b"),
        section("a", 2, () => "two-a"),
        section("z", 1, () => "one"),
        section("blank", 0, () => "   "),
        section("a", 0, () => "duplicate"),
      ],
      ctx,
    );
    expect(out.map((s) => s.text)).toEqual(["one", "two-a", "two-b"]);
  });

  it("drops a section that throws and reports it", () => {
    const onError = vi.fn();
    const out = composePromptSections([section("bad", 1, () => { throw new Error("boom"); }), section("ok", 2, () => "fine")], ctx, onError);
    expect(out).toEqual([{ stable: true, text: "fine" }]);
    expect(onError).toHaveBeenCalledWith("bad", expect.any(Error));
  });

  it("lets a section condition on the turn context", () => {
    const out = composePromptSections([section("who", 1, (c) => `asker ${c.actorId}`, false)], ctx);
    expect(out).toEqual([{ stable: false, text: "asker U0TEST01" }]);
  });
});

describe("composeSystemSegments", () => {
  it("puts the base prompt and stable sections ahead of volatile ones", () => {
    const segments = composeSystemSegments("base", [
      { stable: false, text: "memory" },
      { stable: true, text: "tools" },
      { stable: true, text: "" },
    ]);
    expect(segments).toEqual([
      { text: "base", cacheable: true },
      { text: "tools", cacheable: true },
      { text: "memory", cacheable: false },
    ]);
    expect(renderSystemPrompt(segments)).toBe("base\n\ntools\n\nmemory");
  });
});

describe("defaultSystemPrompt", () => {
  it("names the agent and states the honesty and trust rules", () => {
    const prompt = defaultSystemPrompt("Ada");
    expect(prompt).toContain("You are Ada");
    expect(prompt).toMatch(/Only a result that says it executed/);
    expect(prompt).toMatch(/data, not instructions/);
    expect(defaultSystemPrompt()).toContain("You are Lexi");
    expect(defaultSystemPrompt("  ")).toContain("You are Lexi");
  });
});
