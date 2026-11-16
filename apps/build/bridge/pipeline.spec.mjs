import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.mjs";
import { checkDispatch, parseSpec, runPipeline } from "./pipeline.mjs";
import { designSystemSteering, mcpServers, seedWorkspace, slugify, workspaceFor } from "./workspace.mjs";

const tmp = (prefix) => mkdtempSync(path.join(os.tmpdir(), prefix));

describe("workspace seeding", () => {
  it("slugs intents into folder names", () => {
    expect(slugify("Build Acme Markets — a first-trade app!")).toBe("build-acme-markets-a-first-trade-app");
    expect(slugify("!!!")).toBe("untitled-product");
    expect(workspaceFor("Hello world", "/root")).toBe(path.join("/root", "hello-world"));
  });

  it("seeds the sample spec, skills, steering, AGENTS.md and an empty MCP set by default", () => {
    const ws = path.join(tmp("lexi-ws-"), "p");
    const out = seedWorkspace(ws, loadConfig({}));
    expect(out.freshSpec).toBe(true);
    expect(out.referenceApp).toBeNull();
    expect(readFileSync(path.join(ws, "business-spec.md"), "utf8")).toMatch(/Acme Markets/);
    expect(existsSync(path.join(ws, ".lexi", "skills", "hallmark", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(ws, ".lexi", "skills", "taste", "LICENSE"))).toBe(true);
    expect(existsSync(path.join(ws, ".lexi", "skills", "prototype", "SKILL.md"))).toBe(true);
    expect(readFileSync(path.join(ws, ".lexi", "steering", "design-system.md"), "utf8")).toMatch(/none configured/);
    expect(readFileSync(path.join(ws, "AGENTS.md"), "utf8")).toMatch(/\.lexi\/steering\/lexi-table\.md/);
    expect(existsSync(path.join(ws, ".kiro", "steering", "lexi-table.md"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(ws, ".mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
    expect(JSON.parse(readFileSync(path.join(ws, "package.json"), "utf8")).dependencies).toEqual({ react: "^19.0.0", "react-dom": "^19.0.0" });
  });

  it("plugs in a design-system package, a docs folder, a reference app and MCP sources", () => {
    const base = tmp("lexi-cfg-");
    const docs = path.join(base, "docs");
    const app = path.join(base, "app");
    mkdirSync(docs);
    mkdirSync(app);
    writeFileSync(path.join(docs, "api.md"), "# API");
    const cfg = loadConfig({
      LEXI_DESIGN_SYSTEM: "@acme/design-system",
      LEXI_SOURCES_DIR: docs,
      LEXI_REFERENCE_APP_DIR: app,
      LEXI_MOBBIN_MCP_URL: "https://api.mobbin.com/mcp",
      LEXI_FIGMA_MCP_URL: "https://mcp.figma.com/mcp",
    });
    const ws = path.join(base, "ws");
    const out = seedWorkspace(ws, cfg);
    expect(out.referenceApp).toBe(app);
    expect(lstatSync(path.join(ws, "references", "app")).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(ws, "docs", "api.md"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(ws, "package.json"), "utf8")).dependencies["@acme/design-system"]).toBe("*");
    expect(readFileSync(path.join(ws, ".lexi", "steering", "design-system.md"), "utf8")).toMatch(/@acme\/design-system/);
    expect(Object.keys(JSON.parse(readFileSync(path.join(ws, ".mcp.json"), "utf8")).mcpServers)).toEqual(["mobbin", "figma"]);
  });

  it("copies a design-system document verbatim", () => {
    const base = tmp("lexi-dsdoc-");
    writeFileSync(path.join(base, "kit.md"), "# Our kit\nUse teal.");
    const ws = path.join(base, "ws");
    seedWorkspace(ws, loadConfig({ LEXI_DESIGN_SYSTEM: path.join(base, "kit.md") }));
    expect(readFileSync(path.join(ws, ".lexi", "steering", "design-system.md"), "utf8")).toBe("# Our kit\nUse teal.");
  });

  it("keeps steering text and MCP servers consistent with the config", () => {
    expect(designSystemSteering({ kind: "file", path: "/x" })).toBeNull();
    expect(mcpServers({ mobbinMcpUrl: null, figmaMcpUrl: null })).toEqual({});
  });
});

describe("parseSpec", () => {
  it("reads audience, journey, rules and the decisions block", () => {
    const spec = parseSpec(readFileSync(new URL("./seed/business-spec.md", import.meta.url), "utf8"));
    expect(spec.audience).toMatch(/first small investment/);
    expect(spec.rules.length).toBe(5);
    expect(spec.decisions[0].title).toBe("Who is the first release for?");
  });
});

describe("checkDispatch", () => {
  const none = { prototype: false, ship: false };
  it("refuses unknown agents and playbooks", () => {
    expect(checkDispatch({ agent: "ghost", playbook: "x" }, none)).toMatch(/unknown agent/);
    expect(checkDispatch({ agent: "scout", playbook: "production" }, none)).toMatch(/no playbook/);
  });
  it("blocks Forge until the prototype is approved, then checks the region", () => {
    expect(checkDispatch({ agent: "forge", playbook: "integrate" }, none)).toMatch(/BLOCKED/);
    expect(checkDispatch({ agent: "forge", playbook: "region", element: "sidebar" }, { prototype: true, ship: false })).toMatch(/region needs element/);
    expect(checkDispatch({ agent: "forge", playbook: "region", element: "hero" }, { prototype: true, ship: false })).toBeNull();
    expect(checkDispatch({ agent: "scout", playbook: "reference" }, none)).toBeNull();
  });
});

/** A runner double: answers Lexi's manager turns from a script and every worker with a canned result. */
function scriptedRunner(managerActions, workerJson = {}) {
  const prompts = [];
  let turn = 0;
  return {
    prompts,
    async run({ prompt, onSay }) {
      prompts.push(prompt);
      if (prompt.includes("MANAGING this job yourself")) {
        const json = managerActions[Math.min(turn++, managerActions.length - 1)];
        return { text: "", json };
      }
      onSay?.("working on it");
      return { text: "", json: workerJson };
    },
  };
}

function harness(actions, { approvals = [], workerJson } = {}) {
  const root = tmp("lexi-run-");
  const events = [];
  const runner = scriptedRunner(actions, workerJson);
  let a = 0;
  const ctx = {
    intent: "Build a tiny notes app",
    emit: (ev) => events.push(ev),
    runner,
    config: { ...loadConfig({ LEXI_WORKSPACE_ROOT: root }), maxSteps: 8, phaseTimeoutMs: 5000 },
    askDecision: async () => 0,
    askApproval: async () => approvals[a++] || { verdict: "approve" },
  };
  return { root, events, runner, ctx };
}

describe("runPipeline (with a runner double)", () => {
  it("refuses Forge before the prototype approval, then ships only after the ship approval", async () => {
    const { events, runner, ctx, root } = harness([
      { say: "Forge first", action: { type: "dispatch", agent: "forge", playbook: "integrate", brief: "go" } },
      { phase: "Prototype", action: { type: "dispatch", agent: "pixel", playbook: "prototype", brief: "draw it" } },
      { action: { type: "approval", kind: "prototype", title: "Prototype ok?" } },
      { phase: "Build", action: { type: "dispatch", agent: "forge", playbook: "integrate", brief: "build it" } },
      { action: { type: "ship", summary: "done" } },
    ], { workerJson: { summary: "built", edits: [{ element: "hero", html: "<p>hi</p>" }] } });
    await runPipeline(ctx);

    const workerPrompts = runner.prompts.filter((p) => !p.includes("MANAGING this job yourself"));
    expect(workerPrompts).toHaveLength(2); // pixel, then forge — the first forge was refused in code
    const ship = events.find((e) => e.type === "ship");
    expect(ship.preview).toBe("/preview/build-a-tiny-notes-app/");
    expect(events.filter((e) => e.type === "approval")).toHaveLength(0); // approvals go through ctx, not events
    expect(events.some((e) => e.type === "edit" && e.element === "hero")).toBe(true);
    const shipped = readFileSync(path.join(root, "build-a-tiny-notes-app", "SHIPPED.md"), "utf8");
    expect(shipped).toMatch(/BLOCKED by guardrail/);
    expect(events.at(-1).type).toBe("done");
  });

  it("does not ship when the human declines the ship approval", async () => {
    const { events, ctx } = harness([
      { action: { type: "ship" } },
      { action: { type: "done", summary: "stopping" } },
    ], { approvals: [{ verdict: "changes", instruction: "not yet" }] });
    await runPipeline(ctx);
    expect(events.some((e) => e.type === "ship")).toBe(false);
    expect(events.at(-1).type).toBe("done");
  });

  it("stops after three invalid manager turns", async () => {
    const { events, ctx } = harness([{ say: "hmm" }]);
    await runPipeline(ctx);
    expect(events.some((e) => e.type === "sys" && /couldn't settle/.test(e.text))).toBe(true);
  });
});
