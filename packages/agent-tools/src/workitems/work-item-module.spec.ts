import { describe, expect, it, vi } from "vitest";
import { RepoRegistry } from "@lexi/workitems";
import { createWorkItemToolModule, CREATE_ISSUE_PERMISSION } from "./work-item-module";
import { ctx, issue, text, toolOf } from "../testing/fixtures";

const registry = new RepoRegistry({
  version: 1,
  source: { issues: { organization: "acme", repository: "issues", roles: ["issues"] } },
  products: {
    web: { organization: "acme", repository: "web", platform: "web", team: "web", roles: ["code", "issues"] },
    next: { organization: "acme", repository: "web-next", roles: ["code", "issues"], placeholder: true },
    docs: { organization: "acme", repository: "docs", roles: ["code"] },
  },
} as never);

function build(createIssue = vi.fn(async () => issue({ githubNumber: 101, url: "https://github.com/acme/web/issues/101" }))) {
  return { createIssue, module: createWorkItemToolModule({ registry, github: { createIssue }, labelAllowlist: ["bug"] }) };
}

describe("work item tools", () => {
  it("create_issue is mutating, needs work_item.create, and scopes to the repository and team", () => {
    const tool = toolOf(build().module, "create_issue");
    expect(tool.mutating).toBe(true);
    expect(tool.requiredPermission).toBe(CREATE_ISSUE_PERMISSION);
    expect(tool.resource?.({ repository: "web" })).toEqual({ repository: "acme/web", team: "web" });
  });

  it("lists registered repositories with their roles", async () => {
    const out = JSON.parse(text(await toolOf(build().module, "list_repositories").invoke({}, ctx)));
    expect(out.map((r: { key: string }) => r.key)).toEqual(["issues", "web", "next", "docs"]);
  });

  it("files an issue by registry key or slug", async () => {
    const { createIssue, module } = build();
    const result = await toolOf(module, "create_issue").invoke({ repository: "web", title: "Pay broken", body: "Steps...", labels: ["bug"] }, ctx);
    expect(result.outcome).toMatchObject({ executed: true, auditId: "101" });
    expect(createIssue).toHaveBeenCalledWith("acme", "web", "Pay broken", "Steps...", ["bug"]);
    await toolOf(module, "create_issue").invoke({ repository: "acme/issues", title: "t", body: "" }, ctx);
    expect(createIssue).toHaveBeenLastCalledWith("acme", "issues", "t", "", undefined);
  });

  it.each([
    [{ repository: "docs", title: "t", body: "b" }, "not a repository"],
    [{ repository: "next", title: "t", body: "b" }, "not a repository"],
    [{ repository: "web", title: "", body: "b" }, "title"],
    [{ repository: "web", title: "t", body: "b", labels: ["p0"] }, "p0"],
  ])("refuses %o", async (args, expected) => {
    const { createIssue, module } = build();
    const result = await toolOf(module, "create_issue").invoke(args, ctx);
    expect(result.outcome?.executed).toBe(false);
    expect(text(result)).toContain(expected);
    expect(createIssue).not.toHaveBeenCalled();
  });
});
