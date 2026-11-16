import { describe, expect, it, vi } from "vitest";
import { createSpecToolModule, HUMAN_ONLY_SPEC_ACTIONS, SPEC_TOOL_PERMISSIONS, type SpecToolExecutor } from "./spec-module";
import { staticRepoScope } from "../shared/repo-scope";
import { ctx, text, toolOf } from "../testing/fixtures";

function executor(overrides: Partial<SpecToolExecutor> = {}): SpecToolExecutor {
  const ok = vi.fn(async () => ({ executed: true, reason: "done", data: { specId: "spec-1" }, auditId: "spec-1" }));
  return {
    startSession: ok,
    updateDraft: vi.fn(async () => ({ executed: true, reason: "recorded" })),
    submitForReview: vi.fn(async () => ({ executed: false, reason: "The draft is not ready: scope is open." })),
    generateTaskBreakdown: vi.fn(async () => ({ executed: true, reason: "proposed", data: [{ title: "Retry deposits" }] })),
    createSpecTasks: vi.fn(async () => ({ executed: true, reason: "created 1 task" })),
    ...overrides,
  };
}

const build = (exec = executor()) => createSpecToolModule({ executor: exec, repositories: staticRepoScope(["acme/web"]) });

describe("spec tools", () => {
  it("declares permissions, and every tool but the preview is mutating", () => {
    for (const tool of build().tools) {
      const name = tool.definition.name as keyof typeof SPEC_TOOL_PERMISSIONS;
      expect(tool.requiredPermission).toBe(SPEC_TOOL_PERMISSIONS[name]);
      expect(Boolean(tool.mutating)).toBe(name !== "generate_task_breakdown");
    }
  });

  it("never offers an approval or retirement tool", () => {
    const names = build().tools.map((t) => t.definition.name);
    for (const human of HUMAN_ONLY_SPEC_ACTIONS) expect(names).not.toContain(human);
  });

  it("starts a session, defaulting the requester to the caller", async () => {
    const exec = executor();
    const result = await toolOf(build(exec), "start_spec_session").invoke(
      { title: "Retry failed deposits", targetRepository: "acme/web", seedAnswers: [{ dimension: "problem", answer: "Deposits fail silently", confidence: 1 }] },
      ctx,
    );
    expect(result.outcome).toMatchObject({ executed: true, auditId: "spec-1" });
    expect(exec.startSession).toHaveBeenCalledWith(
      { title: "Retry failed deposits", requestedBy: "U0TEST01", targetRepository: "acme/web", seedAnswers: [{ dimension: "problem", answer: "Deposits fail silently", confidence: 1 }] },
      { actorId: "U0TEST01", conversation: ctx.conversation },
    );
  });

  it("refuses an unknown dimension, a bad confidence and an out-of-scope repository", async () => {
    const exec = executor();
    const tool = toolOf(build(exec), "start_spec_session");
    expect((await tool.invoke({ title: "t", seedAnswers: [{ dimension: "vibes", answer: "a" }] }, ctx)).outcome?.executed).toBe(false);
    expect((await tool.invoke({ title: "t", seedAnswers: [{ dimension: "scope", answer: "a", confidence: 2 }] }, ctx)).outcome?.executed).toBe(false);
    expect((await tool.invoke({ title: "t", targetRepository: "other/repo" }, ctx)).outcome?.executed).toBe(false);
    expect(exec.startSession).not.toHaveBeenCalled();
  });

  it("accepts a deferral without an answer", async () => {
    const exec = executor();
    await toolOf(build(exec), "update_spec_draft").invoke({ specId: "spec-1", answers: [{ dimension: "rollout", deferReason: "No staged rollout" }] }, ctx);
    expect(exec.updateDraft).toHaveBeenCalledWith(
      { specId: "spec-1", answers: [{ dimension: "rollout", deferReason: "No staged rollout" }], userRequestedDraft: false },
      expect.anything(),
    );
  });

  it("relays an executor refusal as not executed", async () => {
    const result = await toolOf(build(), "submit_spec_for_review").invoke({ specId: "spec-1" }, ctx);
    expect(result.outcome).toMatchObject({ executed: false, blocked: true });
    expect(text(result)).toContain("not ready");
  });

  it("turns an executor failure into a refusal", async () => {
    const exec = executor({ createSpecTasks: vi.fn(async () => { throw new Error("store down"); }) });
    const result = await toolOf(build(exec), "create_spec_tasks").invoke({ specId: "s", tasks: [{ title: "t", kind: "feature", repository: "acme/web" }] }, ctx);
    expect(result.outcome?.executed).toBe(false);
  });

  it("validates tasks before creating them", async () => {
    const exec = executor();
    const tool = toolOf(build(exec), "create_spec_tasks");
    expect((await tool.invoke({ specId: "s", tasks: [{ title: "t", kind: "bug", repository: "acme/web" }] }, ctx)).outcome?.executed).toBe(false);
    expect((await tool.invoke({ specId: "s", tasks: [{ title: "t", kind: "chore", repository: "other/repo" }] }, ctx)).outcome?.executed).toBe(false);
    expect(exec.createSpecTasks).not.toHaveBeenCalled();
  });

  it("previews a breakdown as data", async () => {
    const out = JSON.parse(text(await toolOf(build(), "generate_task_breakdown").invoke({ specId: "s", repositories: ["acme/web"] }, ctx)));
    expect(out.data).toEqual([{ title: "Retry deposits" }]);
  });
});
