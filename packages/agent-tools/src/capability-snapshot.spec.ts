/**
 * The default modules' half of the capability snapshot. The drift gate for
 * `docs/capability-matrix.md` lives in apps/server, which can also build the
 * opt-in modules this package cannot depend on.
 */
import { describe, expect, it } from "vitest";
import { capabilityProblems } from "@lexi/governance";
import { allDefaultToolModules, buildCapabilitySnapshot } from "./capability-snapshot";

describe("buildCapabilitySnapshot", () => {
  it("covers every default module and every tool it registers", () => {
    const modules = allDefaultToolModules();
    const snapshot = buildCapabilitySnapshot({ modules });
    expect(snapshot.modules.map((m) => m.name)).toEqual(modules.map((m) => m.name));
    expect(snapshot.modules.map((m) => m.name)).toEqual(["github-read", "github-write", "agent-fix", "work-items", "slack", "memory", "spec"]);
    const tools = snapshot.modules.flatMap((m) => m.tools);
    expect(tools.length).toBe(modules.flatMap((m) => m.tools).length);
    // An extraction that silently found nothing would render a short, confidently wrong table.
    expect(tools.length).toBeGreaterThan(30);
    expect(tools.some((t) => t.mutating)).toBe(true);
  });

  it("finds nothing wrong: every changing tool is governed by a permission some role can hold", () => {
    expect(capabilityProblems(buildCapabilitySnapshot())).toEqual([]);
  });

  it("never calls a dependency while building", () => {
    expect(() => buildCapabilitySnapshot()).not.toThrow();
  });
});
