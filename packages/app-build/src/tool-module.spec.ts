import { readFileSync } from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { ToolRegistry, type ToolCallContext, type ToolResult } from "@lexi/agent";
import { governanceAuthorizer } from "@lexi/agent-tools";
import { WriteGateBlockedError } from "@lexi/github";
import { AuthorizationService, authorizationConfigSchema } from "@lexi/governance";
import { AppBuildService } from "./service";
import { InMemoryAppBuildStore } from "./store";
import { APP_BUILD_PERMISSIONS, APP_BUILD_TOOL_NAMES, createAppBuildToolModule } from "./tool-module";
import { FakeGithub, reportBody } from "./testing/fake-github";

const ctx = (actorId = "U0TEST03"): ToolCallContext => ({
  actorId,
  conversation: { channel: "C0TEST01", threadTs: "1700000000.000100" },
  maxResultChars: 20_000,
});

function setup(extra: { defaultRepository?: string; readPermission?: string } = {}) {
  const github = new FakeGithub();
  const store = new InMemoryAppBuildStore();
  const service = new AppBuildService({ github, store, correlate: { attempts: 1 } });
  const module = createAppBuildToolModule({ service, repositories: [{ slug: "acme/web", team: "home", defaultBranch: "main" }], ...extra });
  const tool = (name: string) => {
    const found = module.tools.find((t) => t.definition.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };
  return { github, store, module, tool };
}

const text = (result: ToolResult) => (typeof result.content === "string" ? result.content : JSON.stringify(result.content));

function exampleAuthorization(): AuthorizationService {
  const file = path.resolve(__dirname, "../../../examples/config/authorization.yaml");
  return new AuthorizationService(authorizationConfigSchema.parse(loadYaml(readFileSync(file, "utf8"))));
}

describe("app-build tool module", () => {
  it("declares the write tools mutating with their permissions, and the status tool read-only", () => {
    const { module, tool } = setup();
    expect(module.tools.map((t) => t.definition.name)).toEqual([...APP_BUILD_TOOL_NAMES]);
    expect(tool("start_app_build")).toMatchObject({ mutating: true, requiredPermission: "app_build.trigger" });
    expect(tool("stop_app_build")).toMatchObject({ mutating: true, requiredPermission: "app_build.stop" });
    expect(tool("send_app_build_feedback")).toMatchObject({ mutating: true, requiredPermission: "app_build.feedback" });
    expect(tool("get_app_build_status").mutating).toBeFalsy();
    expect(tool("get_app_build_status").requiredPermission).toBeUndefined();
    expect(tool("start_app_build").resource?.({ repository: "acme/web" })).toEqual({ repository: "acme/web", team: "home" });
    expect(module.intentClasses?.length).toBeGreaterThan(0);
    expect(() => new ToolRegistry().register(module)).not.toThrow();
  });

  it("starts a build and reports it executed", async () => {
    const { github, tool } = setup();
    const result = await tool("start_app_build").invoke({ repository: "acme/web", app: "web", maxSessions: 10 }, ctx());
    expect(result.outcome).toMatchObject({ executed: true });
    expect(github.dispatches).toEqual([{ workflowFile: "app-build.yml", ref: "main", inputs: { app: "web", session: "1", max_sessions: "10" } }]);
  });

  it.each([
    [{ repository: "other/repo", app: "web" }, "not a repository"],
    [{ repository: "acme/web", app: "desktop" }, "web\" or \"mobile"],
    [{ repository: "acme/web", app: "web", session: 0 }, "session must be"],
    [{ repository: "acme/web", app: "web", maxSessions: "5" }, "maxSessions must be"],
    [{ repository: "acme/web", app: "web", restartPhase: "deploy" }, "restartPhase must be"],
    [{ app: "web" }, "No repository"],
  ])("refuses bad arguments %#", async (args, expected) => {
    const { github, tool } = setup();
    const result = await tool("start_app_build").invoke(args, ctx());
    expect(result.outcome).toMatchObject({ executed: false, blocked: true });
    expect(text(result)).toContain(expected);
    expect(github.dispatches).toHaveLength(0);
  });

  it("uses the default repository when none is passed, for the call and its authorization resource", async () => {
    const { github, tool } = setup({ defaultRepository: "acme/web" });
    expect(tool("start_app_build").resource?.({ app: "web" })).toEqual({ repository: "acme/web", team: "home" });
    const result = await tool("start_app_build").invoke({ app: "mobile" }, ctx());
    expect(result.outcome?.executed).toBe(true);
    expect(github.dispatches[0].inputs.app).toBe("mobile");
  });

  it("reports the write gate as not performed, and a provider failure as failed", async () => {
    const { github, tool } = setup();
    github.writeError = new WriteGateBlockedError("github.dispatchWorkflow", "GOVERNED_WRITES_ENABLED=false");
    const gated = await tool("start_app_build").invoke({ repository: "acme/web", app: "web" }, ctx());
    expect(gated.outcome).toMatchObject({ executed: false });
    expect(text(gated)).toMatch(/Writes are disabled/);

    github.writeError = null;
    github.dispatchError = new Error("HTTP 403 token=ghs_abcdef123 refused");
    const failed = await tool("start_app_build").invoke({ repository: "acme/web", app: "web" }, ctx());
    expect(failed.isError).toBe(true);
    expect(text(failed)).not.toContain("ghs_abcdef123");
  });

  it("stops, posts feedback, and reports a no-op stop honestly", async () => {
    const { github, tool } = setup();
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    expect((await tool("stop_app_build").invoke({ repository: "acme/web", app: "web" }, ctx())).outcome?.executed).toBe(true);
    const again = await tool("stop_app_build").invoke({ repository: "acme/web", app: "web" }, ctx());
    expect(again.outcome).toMatchObject({ executed: false, blocked: false });
    const feedback = await tool("send_app_build_feedback").invoke({ repository: "acme/web", app: "web", message: "Use the brand colours." }, ctx());
    expect(feedback.outcome?.executed).toBe(true);
    expect(github.posted[0].body).toContain("Use the brand colours.");
    const empty = await tool("send_app_build_feedback").invoke({ repository: "acme/web", app: "web", message: "  " }, ctx());
    expect(empty.outcome?.executed).toBe(false);
  });

  it("reads status within the result budget, and refuses an unknown repository or app", async () => {
    const { github, tool } = setup();
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    github.addLoopComment(7, reportBody({ app: "web", session: 3, questions: ["Which locale first?"] }));
    const result = await tool("get_app_build_status").invoke({ repository: "acme/web", app: "web" }, ctx());
    expect(text(result)).toContain("Which locale first?");
    expect(result.outcome).toBeUndefined();
    const short = await tool("get_app_build_status").invoke({ repository: "acme/web" }, { ...ctx(), maxResultChars: 300 });
    expect(text(short)).toMatch(/Truncated/);
    expect((await tool("get_app_build_status").invoke({ repository: "nope/nope" }, ctx())).isError).toBe(true);
    expect((await tool("get_app_build_status").invoke({ repository: "acme/web", app: "tv" }, ctx())).isError).toBe(true);
  });

  it("reports a status read failure as an error, not as an empty build", async () => {
    const { github, tool } = setup();
    github.pullsReadable = false;
    const result = await tool("get_app_build_status").invoke({ repository: "acme/web", app: "web" }, ctx());
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not readable/);
  });
});

describe("authorization through the registry", () => {
  const registry = () => new ToolRegistry({ authorizer: governanceAuthorizer(exampleAuthorization()) }).register(setup().module);

  it("grants every app-build permission to some role in the example config", () => {
    const yaml = readFileSync(path.resolve(__dirname, "../../../examples/config/authorization.yaml"), "utf8");
    for (const permission of Object.values(APP_BUILD_PERMISSIONS)) expect(yaml).toContain(`- ${permission}`);
  });

  it("lets an engineer stop and steer but not start, a team lead start, and a viewer only read", async () => {
    const reg = registry();
    const start = { repository: "acme/web", app: "web" };
    // U0TEST03 is an engineer, U0TEST01 a home team lead, U0TEST05 QA (viewer rungs only for app builds).
    expect((await reg.invoke("start_app_build", start, ctx("U0TEST03"))).outcome).toMatchObject({ authorized: false, executed: false });
    expect((await reg.invoke("stop_app_build", start, ctx("U0TEST03"))).outcome?.authorized).not.toBe(false);
    expect((await reg.invoke("start_app_build", start, ctx("U0TEST01"))).outcome).toMatchObject({ executed: true });
    expect((await reg.invoke("stop_app_build", start, ctx("U0TEST05"))).outcome).toMatchObject({ authorized: false });
    expect((await reg.invoke("get_app_build_status", { repository: "acme/web" }, ctx("U0TEST05"))).isError).toBeFalsy();
  });

  it("applies team scope to a start: a p2p team lead may not start a home-team build", async () => {
    const result = await registry().invoke("start_app_build", { repository: "acme/web", app: "web" }, ctx("U0TEST02"));
    expect(result.outcome).toMatchObject({ authorized: false, executed: false });
  });
});
