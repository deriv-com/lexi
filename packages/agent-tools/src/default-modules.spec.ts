import { describe, expect, it, vi } from "vitest";
import { RepoRegistry } from "@lexi/workitems";
import { ToolRegistry } from "@lexi/agent";
import { createDefaultToolModules, type DefaultToolModuleDeps } from "./default-modules";
import { governanceAuthorizer } from "./authorizer/governance-authorizer";
import { exampleAuthorizationService, grantedPermissions, loadExampleAuthorization } from "./testing/example-authorization";
import { ctx, issue, pullRequest } from "./testing/fixtures";

function github(): NonNullable<DefaultToolModuleDeps["github"]> {
  return {
    getIssue: vi.fn(async () => issue()),
    getPullRequest: vi.fn(async () => pullRequest()),
    listComments: vi.fn(async () => []),
    listIssues: vi.fn(async () => []),
    getFileContents: vi.fn(async () => null),
    getPullRequestFiles: vi.fn(async () => []),
    listWorkflowRunJobs: vi.fn(async () => []),
    listWorkflowRunArtifacts: vi.fn(async () => []),
    downloadWorkflowJobLogs: vi.fn(async () => ""),
    downloadWorkflowRunArtifact: vi.fn(async () => Buffer.alloc(0)),
    addComment: vi.fn(async () => ({ id: 1, authorLogin: null, body: "", createdAt: "" })),
    addLabels: vi.fn(async () => []),
    removeLabels: vi.fn(async () => undefined),
    closeIssue: vi.fn(async () => issue()),
    reopenIssue: vi.fn(async () => issue()),
    createIssue: vi.fn(async () => issue()),
    createPullRequest: vi.fn(async () => ({ ...pullRequest(), draft: true })),
    closePullRequest: vi.fn(async () => pullRequest()),
    reopenPullRequest: vi.fn(async () => pullRequest()),
    mergePullRequest: vi.fn(async () => ({ merged: true, sha: "d".repeat(40), message: "ok" })),
    getReviewStatus: vi.fn(async () => ({ number: 34, url: "", state: "open" as const, draft: false, reviews: [], checks: [], requestedReviewers: [], requestedTeams: [], mergeable: true })),
    getDefaultBranch: vi.fn(async () => "main"),
    dispatchWorkflow: vi.fn(async () => undefined),
    findDispatchedRun: vi.fn(async () => null),
  };
}

const registry = new RepoRegistry({
  version: 1,
  source: { issues: { organization: "acme", repository: "issues", roles: ["issues"] } },
  products: {
    web: { organization: "acme", repository: "web", platform: "web", team: "home", roles: ["code", "specs", "issues"] },
    mobile: { organization: "acme", repository: "mobile", platform: "mobile", team: "p2p", roles: ["code", "specs", "issues"] },
  },
} as never);

function everything(gh = github()): DefaultToolModuleDeps {
  return {
    github: gh,
    registry,
    slackReader: { conversations: { replies: vi.fn(async () => ({ ok: true, messages: [] })) } },
    slackPoster: { sendMessage: vi.fn(async () => ({ ok: true })), updateMessage: vi.fn() },
    memory: { recall: vi.fn(), remember: vi.fn(), forgetOwnPreferences: vi.fn(), forgetTeamConventions: vi.fn() },
    knowledge: { search: vi.fn(async () => []) },
    specExecutor: { startSession: vi.fn(), updateDraft: vi.fn(), submitForReview: vi.fn(), generateTaskBreakdown: vi.fn(), createSpecTasks: vi.fn() },
    options: { labelAllowlist: ["bug"], correlate: { attempts: 1 } },
  };
}

describe("createDefaultToolModules", () => {
  it("builds every module when every dependency is present, with no duplicate tool names", () => {
    const modules = createDefaultToolModules(everything());
    expect(modules.map((m) => m.name)).toEqual(["github-read", "github-write", "agent-fix", "work-items", "slack", "memory", "spec"]);
    expect(() => new ToolRegistry().register(modules[0])).not.toThrow();
    const registryAll = new ToolRegistry();
    for (const module of modules) registryAll.register(module);
    expect(registryAll.definitions().length).toBeGreaterThan(30);
  });

  it("skips modules whose dependency is absent", () => {
    expect(createDefaultToolModules({})).toEqual([]);
    expect(createDefaultToolModules({ github: github() }).map((m) => m.name)).toEqual([]);
    expect(createDefaultToolModules({ github: github(), repositories: ["acme/web"] }).map((m) => m.name)).toEqual(["github-read", "github-write", "agent-fix"]);
    expect(
      createDefaultToolModules({ github: github(), repositories: ["acme/web"], options: { githubWrites: false, agentFix: false } }).map((m) => m.name),
    ).toEqual(["github-read"]);
    expect(createDefaultToolModules({ memory: { recall: vi.fn(), remember: vi.fn() } }).map((m) => m.name)).toEqual(["memory"]);
  });

  it("every permission a tool requires is granted by some role in the example config", () => {
    const granted = grantedPermissions(loadExampleAuthorization());
    const required = createDefaultToolModules({ ...everything(), options: { ...everything().options, readPermission: "issue.read" } })
      .flatMap((m) => m.tools)
      .map((t) => t.requiredPermission)
      .filter((p): p is string => Boolean(p));
    const missing = [...new Set(required)].filter((p) => !granted.has(p));
    expect(missing).toEqual([]);
  });

  it("with a read permission, every tool is governed, so an unlisted person can read nothing", async () => {
    const modules = createDefaultToolModules({ ...everything(), options: { ...everything().options, readPermission: "issue.read" } });
    const ungoverned = modules.flatMap((m) => m.tools).filter((t) => !t.requiredPermission).map((t) => t.definition.name);
    expect(ungoverned).toEqual([]);

    const tools = new ToolRegistry({ authorizer: governanceAuthorizer(exampleAuthorizationService()) });
    for (const module of modules) tools.register(module);
    const result = await tools.invoke("get_thread_context", {}, { ...ctx, actorId: "U0NOBODY" });
    expect(result.outcome).toMatchObject({ authorized: false, executed: false });
  });

  it("keeps a tool's own permission when it has one", () => {
    const modules = createDefaultToolModules({ ...everything(), options: { ...everything().options, readPermission: "issue.read" } });
    const recall = modules.flatMap((m) => m.tools).find((t) => t.definition.name === "recall_memory");
    expect(recall?.requiredPermission).toBe("memory.recall");
  });

  it("every mutating tool declares a permission", () => {
    for (const tool of createDefaultToolModules(everything()).flatMap((m) => m.tools)) {
      if (tool.mutating) expect(tool.requiredPermission, tool.definition.name).toBeTruthy();
    }
  });
});

describe("authorization through the registry", () => {
  function registryWith(gh = github()) {
    const toolRegistry = new ToolRegistry({ authorizer: governanceAuthorizer(exampleAuthorizationService()) });
    for (const module of createDefaultToolModules(everything(gh))) toolRegistry.register(module);
    return toolRegistry;
  }

  it("an actor without the permission cannot run a write, and the write is never attempted", async () => {
    const gh = github();
    // Erin holds the qa role, which does not include pr.merge.
    const result = await registryWith(gh).invoke("merge_pull_request", { repository: "web", number: 34 }, { ...ctx, actorId: "U0TEST05" });
    expect(result.outcome).toMatchObject({ authorized: false, executed: false, blocked: true });
    expect(gh.getPullRequest).not.toHaveBeenCalled();
    expect(gh.mergePullRequest).not.toHaveBeenCalled();
  });

  it("someone not in the access list cannot comment", async () => {
    const gh = github();
    const result = await registryWith(gh).invoke("comment_on_issue", { repository: "web", number: 12, body: "hi" }, { ...ctx, actorId: "U0TEST99" });
    expect(result.outcome?.authorized).toBe(false);
    expect(gh.addComment).not.toHaveBeenCalled();
  });

  it("a team-scoped lead cannot write to another team's repository", async () => {
    const gh = github();
    // Alice leads home; the mobile repository belongs to the p2p team.
    const denied = await registryWith(gh).invoke("comment_on_issue", { repository: "mobile", number: 1, body: "x" }, ctx);
    expect(denied.outcome?.authorized).toBe(false);
    const allowed = await registryWith(gh).invoke("comment_on_issue", { repository: "web", number: 1, body: "x" }, ctx);
    expect(allowed.outcome?.executed).toBe(true);
  });

  it("an authorized engineer's merge goes through", async () => {
    const gh = github();
    const result = await registryWith(gh).invoke("merge_pull_request", { repository: "web", number: 34 }, { ...ctx, actorId: "U0TEST03" });
    expect(result.outcome).toMatchObject({ authorized: true, executed: true });
  });
});
