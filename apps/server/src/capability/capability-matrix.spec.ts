/**
 * The drift gate for `docs/capability-matrix.md`: rendered from every module
 * the server can register, so a hand-kept table cannot drift from what the
 * agent can actually do. Regenerate with `npm run docs:capability-matrix`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCapabilitySnapshot } from "@lexi/agent-tools";
import { capabilityProblems, renderCapabilityMatrix } from "@lexi/governance";
import { allToolModules } from "./all-tool-modules";

const DOC = path.resolve(__dirname, "../../../../docs/capability-matrix.md");

describe("docs/capability-matrix.md", () => {
  it("includes the opt-in modules", () => {
    const names = buildCapabilitySnapshot({ modules: allToolModules() }).modules.map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(["github-read", "app-build", "programme"]));
  });

  it("finds nothing wrong: every changing tool is governed by a permission some role can hold", () => {
    expect(capabilityProblems(buildCapabilitySnapshot({ modules: allToolModules() }))).toEqual([]);
  });

  it("matches what the tool modules render", () => {
    expect(readFileSync(DOC, "utf8"), "docs/capability-matrix.md is stale: run `npm run docs:capability-matrix`").toBe(
      renderCapabilityMatrix(buildCapabilitySnapshot({ modules: allToolModules() })),
    );
  });
});
