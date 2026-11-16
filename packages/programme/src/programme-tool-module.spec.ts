import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import { ToolRegistry, type ToolCallContext } from "@lexi/agent";
import { AuthorizationService, authorizationConfigSchema } from "@lexi/governance";
import {
  createProgrammeToolModule,
  PROGRAMME_INTENT_CLASSES,
  PROGRAMME_TOOL_PERMISSIONS,
  HUMAN_ONLY_PROGRAMME_TOOLS,
  PROGRAMME_PERMISSIONS,
  READ_ONLY_PROGRAMME_TOOLS,
} from "./programme-tool-module";

const noBuild = {
  invokeTool: async () => ({ ok: false, text: "not used", executed: false }),
};

/** The module's schemas, the shape the model sees. */
function buildProgrammeToolModule(options: { programmeEnabled?: boolean; allowedRepoKeys?: string[] } = {}) {
  const module = createProgrammeToolModule({ ...options, build: noBuild });
  return { ...module, tools: module.tools.map((tool) => tool.definition) };
}

describe("programme tool schemas", () => {
  const enabled = { programmeEnabled: true, allowedRepoKeys: ["acme_web"] };

  it("withholds every tool while the flag is off (never advertise-then-refuse)", () => {
    expect(buildProgrammeToolModule().tools).toEqual([]);
    expect(buildProgrammeToolModule({ programmeEnabled: false, allowedRepoKeys: ["x"] }).tools).toEqual([]);
  });

  it("withholds every tool when no target repo is legal, even with the flag on", () => {
    expect(buildProgrammeToolModule({ programmeEnabled: true, allowedRepoKeys: [] }).tools).toEqual([]);
  });

  it("exposes the twelve programme tools when enabled with targets", () => {
    const module = buildProgrammeToolModule(enabled);
    expect(module.tools.map((tool) => tool.name).sort()).toEqual([
      // add_milestones: milestones used to exist only as a side effect of
      // commissioning, so a programme created without Figma keys or a
      // uiSource had none and could never be planned.
      "add_milestones",
      // cancel_build_tasks retires individual tasks. Distinct from
      // cancel_programme: a milestone re-planned onto a repo that already
      // carries finished work has tasks that must never run, and nothing else
      // could remove one — propose_milestone_plan cannot see programme-level
      // tasks, and a re-plan regenerates them.
      "cancel_build_tasks",
      // cancel_programme frees the repo: one live programme per repo, and a
      // paused one used to block a clean slate with no tool able to end it.
      "cancel_programme",
      "get_programme_status",
      "pause_programme",
      // The two halves of "Lexi authors the technical spec": a read that
      // assembles the inputs so she can ask only what they cannot answer, and
      // a write that keeps the answers for every later brief.
      "prepare_technical_spec",
      "propose_milestone_plan",
      "record_programme_decision",
      // resume_programme is not optional garnish: without it a pause is
      // one-way. The state machine allows PAUSED to return to work and
      // nothing else performs that transition.
      "resume_programme",
      "retry_build_task",
      // Re-scopes a task's criteria: a milestone planned without a criteria
      // map spreads every spec criterion onto its screens, and the gate then
      // refuses the one criterion-proving PR for ever.
      "set_task_criteria",
      "start_app_rebuild",
      // One screen built once per model, pinned — the like-for-like
      // comparison a ladder cannot give (its escalation rung only sees the
      // tasks the first rung failed).
      "start_model_bench",
    ]);
  });

  it("puts cancel on the commissioning rung and decisions on the steering rung", () => {
    expect(PROGRAMME_TOOL_PERMISSIONS.cancel_programme).toBe("programme.programme.cancel");
    // Retiring tasks is NOT the retry rung: retrying spends one task's
    // attempts, retiring reshapes the milestone and unblocks dependents.
    expect(PROGRAMME_TOOL_PERMISSIONS.cancel_build_tasks).toBe("programme.task.cancel");
    expect(PROGRAMME_TOOL_PERMISSIONS.cancel_build_tasks).not.toBe(
      PROGRAMME_TOOL_PERMISSIONS.retry_build_task,
    );
    expect(PROGRAMME_TOOL_PERMISSIONS.record_programme_decision).toBe("programme.decision.record");
    // Narrowing what a PR must prove is a scope decision, not a retry.
    expect(PROGRAMME_TOOL_PERMISSIONS.set_task_criteria).toBe("programme.task.rescope");
    expect(PROGRAMME_TOOL_PERMISSIONS.set_task_criteria).not.toBe(PROGRAMME_TOOL_PERMISSIONS.retry_build_task);
    // Preparing the technical spec reads; it must never need more than a read.
    expect(PROGRAMME_TOOL_PERMISSIONS.prepare_technical_spec).toBe("programme.read");
    // Adding milestones shapes programme scope, like commissioning; planning
    // them stays on the dispatch rung.
    expect(PROGRAMME_TOOL_PERMISSIONS.add_milestones).toBe("programme.programme.create");
  });

  it("lets propose_milestone_plan name the milestone's own spec", () => {
    // The service has honoured args.specId since per-milestone specs landed,
    // but the schema is additionalProperties:false — without the property the
    // model could never send it, and a milestone spec session had no way to
    // govern its milestone.
    const plan = buildProgrammeToolModule(enabled).tools.find((tool) => tool.name === "propose_milestone_plan")!;
    const schema = plan.input_schema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.properties).toHaveProperty("specId");
    expect(schema.required).not.toContain("specId");
  });

  it("pairs every pause with a resume — a stop with no start is a dead end", () => {
    const names = buildProgrammeToolModule(enabled).tools.map((tool) => tool.name);
    expect(names).toContain("pause_programme");
    expect(names).toContain("resume_programme");
  });

  it("never exposes the human-only tools or any merge tool", () => {
    const names = buildProgrammeToolModule(enabled).tools.map((tool) => tool.name);
    for (const humanOnly of HUMAN_ONLY_PROGRAMME_TOOLS) {
      expect(names).not.toContain(humanOnly);
    }
    expect(names.some((name) => name.includes("merge"))).toBe(false);
  });

  it("builds the target-repo enum from the caller's allowlist, not a literal", () => {
    const module = buildProgrammeToolModule({
      programmeEnabled: true,
      allowedRepoKeys: ["static_site_ai"],
    });
    const start = module.tools.find((tool) => tool.name === "start_app_rebuild");
    const schema = start?.input_schema as {
      properties: { targetRepoKey: { enum: string[] } };
    };
    expect(schema.properties.targetRepoKey.enum).toEqual(["static_site_ai"]);
  });

  it("declares explicit intent classes — never core", () => {
    expect(buildProgrammeToolModule(enabled).intentClasses).toEqual(PROGRAMME_INTENT_CLASSES);
    expect(PROGRAMME_INTENT_CLASSES.length).toBeGreaterThan(0);
  });
});

const ENABLED = { programmeEnabled: true, allowedRepoKeys: ["acme_web"] };
const ctx = (actorId = "U0TEST01"): ToolCallContext => ({
  actorId,
  conversation: { channel: "C0TEST01", threadTs: "1700000000.000100" },
  maxResultChars: 10_000,
});

function exampleAuthorization(): AuthorizationService {
  const file = resolve(__dirname, "../../../examples/config/authorization.yaml");
  return new AuthorizationService(authorizationConfigSchema.parse(loadYaml(readFileSync(file, "utf8"))));
}

describe("createProgrammeToolModule", () => {
  it("gives every tool its rung, and marks every tool but the two reads as mutating", () => {
    const module = createProgrammeToolModule({ ...ENABLED, build: noBuild });
    for (const tool of module.tools) {
      const name = tool.definition.name as keyof typeof PROGRAMME_TOOL_PERMISSIONS;
      expect(tool.requiredPermission).toBe(PROGRAMME_TOOL_PERMISSIONS[name]);
      expect(tool.mutating).toBe(!READ_ONLY_PROGRAMME_TOOLS.includes(name));
    }
    expect(module.promptSections?.length).toBe(1);
    expect(createProgrammeToolModule({ build: noBuild }).promptSections).toBeUndefined();
  });

  it("invokes the build service as the authenticated actor, never a model-supplied id", async () => {
    const invokeTool = vi.fn().mockResolvedValue({ ok: true, text: "Paused acme_web_rebuild.", executed: true });
    const module = createProgrammeToolModule({ ...ENABLED, build: { invokeTool } });
    const pause = module.tools.find((tool) => tool.definition.name === "pause_programme")!;
    const result = await pause.invoke({ programmeKey: "acme_web_rebuild", reason: "checks", userId: "U0TEST07" }, ctx());
    expect(invokeTool).toHaveBeenCalledWith(
      "pause_programme",
      { programmeKey: "acme_web_rebuild", reason: "checks", userId: "U0TEST07" },
      { userId: "U0TEST01", channel: "C0TEST01", threadTs: "1700000000.000100" },
    );
    expect(result).toEqual({
      content: "Paused acme_web_rebuild.",
      outcome: { authorized: true, executed: true, blocked: false, reason: "Paused acme_web_rebuild." },
    });
  });

  it("reports a service refusal as blocked and not executed", async () => {
    const build = { invokeTool: async () => ({ ok: false, text: "Programme x is COMPLETE.\nNothing to pause.", executed: false }) };
    const pause = createProgrammeToolModule({ ...ENABLED, build }).tools.find((t) => t.definition.name === "pause_programme")!;
    expect(await pause.invoke({}, ctx())).toEqual({
      content: "Programme x is COMPLETE.\nNothing to pause.",
      isError: true,
      outcome: { authorized: true, executed: false, blocked: true, reason: "Programme x is COMPLETE." },
    });
  });

  it("returns reads without a governed outcome, truncated to the result budget", async () => {
    const build = { invokeTool: async () => ({ ok: true, text: "x".repeat(500), executed: false }) };
    const status = createProgrammeToolModule({ ...ENABLED, build }).tools.find((t) => t.definition.name === "get_programme_status")!;
    const result = await status.invoke({ programmeKey: "p" }, { ...ctx(), maxResultChars: 100 });
    expect(result.outcome).toBeUndefined();
    expect((result.content as string).length).toBe(100);
    expect(result.content).toContain("truncated");
  });

  it("registers in the agent's ToolRegistry, which refuses an actor without the rung before the service runs", async () => {
    const invokeTool = vi.fn().mockResolvedValue({ ok: true, text: "done", executed: true });
    const authorization = exampleAuthorization();
    const registry = new ToolRegistry({
      authorizer: { authorize: (request) => authorization.evaluate(request) },
    }).register(createProgrammeToolModule({ ...ENABLED, build: { invokeTool } }));

    // Carol is an engineer: she may retry a task but not cancel a programme.
    const refused = await registry.invoke("cancel_programme", { programmeKey: "p", reason: "r" }, ctx("U0TEST03"));
    expect(refused.outcome).toMatchObject({ authorized: false, executed: false });
    expect(invokeTool).not.toHaveBeenCalled();

    const retried = await registry.invoke("retry_build_task", { programmeKey: "p", buildTaskId: "t", reason: "r" }, ctx("U0TEST03"));
    expect(retried.outcome).toMatchObject({ authorized: true, executed: true });

    // Alice is a team lead for home: commissioning on home is hers, on p2p it
    // is not, and with no repository to check her scope against it is refused.
    const create = (resource?: { team: string; repository: string }) =>
      authorization.evaluate({ actorId: "U0TEST01", action: "programme.programme.create", ...(resource ? { resource } : {}) }).allowed;
    expect(create({ team: "home", repository: "acme/home-rebuild" })).toBe(true);
    expect(create({ team: "p2p", repository: "acme/p2p-rebuild" })).toBe(false);
    expect(create()).toBe(false);
  });

  it("checks a team-scoped lead against the team that owns the programme's repository", async () => {
    const invokeTool = vi.fn().mockResolvedValue({ ok: true, text: "Paused.", executed: true });
    const repos: Record<string, { repository: string; team: string }> = {
      home_prog: { repository: "acme/home-rebuild", team: "home" },
      p2p_prog: { repository: "acme/p2p-rebuild", team: "p2p" },
    };
    const toolResource = vi.fn(async (_name: string, args: Record<string, unknown>) => repos[args.programmeKey as string]);
    const authorization = exampleAuthorization();
    const registry = new ToolRegistry({
      authorizer: { authorize: (request) => authorization.evaluate(request) },
    }).register(createProgrammeToolModule({ ...ENABLED, build: { invokeTool, toolResource } }));

    const own = await registry.invoke("pause_programme", { programmeKey: "home_prog", reason: "r" }, ctx("U0TEST01"));
    expect(own.outcome).toMatchObject({ authorized: true, executed: true });

    // Another team's programme, and one that does not resolve, are refused before the service runs.
    invokeTool.mockClear();
    const other = await registry.invoke("pause_programme", { programmeKey: "p2p_prog", reason: "r" }, ctx("U0TEST01"));
    expect(other.outcome).toMatchObject({ authorized: false, executed: false });
    const unknown = await registry.invoke("pause_programme", { programmeKey: "nope", reason: "r" }, ctx("U0TEST01"));
    expect(unknown.outcome).toMatchObject({ authorized: false, executed: false });
    expect(invokeTool).not.toHaveBeenCalled();

    // An unscoped admin is unaffected.
    const admin = await registry.invoke("pause_programme", { programmeKey: "nope", reason: "r" }, ctx("U0TEST07"));
    expect(admin.outcome).toMatchObject({ authorized: true });
  });

  it("every programme permission is grantable by some role in the example authorization.yaml", () => {
    // A tool whose rung no role holds is advertised and then refused for everyone.
    const authorization = exampleAuthorization();
    const grantedSomewhere = (action: string) =>
      ["U0TEST07", "U0TEST01", "U0TEST03", "U0TEST05"].some(
        (actorId) => authorization.evaluate({ actorId, action }).allowed,
      );
    for (const permission of Object.values(PROGRAMME_PERMISSIONS)) {
      expect(grantedSomewhere(permission), permission).toBe(true);
    }
  });
});
