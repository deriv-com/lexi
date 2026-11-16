import { describe, it, expect, vi } from "vitest";
import { OctokitGithubProvider } from "./octokit-github.provider";
import { GitHubMutationGateway } from "./github-mutation-gateway";

function fixture() {
  const rest = {
    git: { getRef: vi.fn(async () => ({ data: { object: { sha: "old" } } })), createRef: vi.fn(async () => ({ data: { object: { sha: "base" } } })),
      getCommit: vi.fn(async () => ({ data: { tree: { sha: "tree" } } })), createTree: vi.fn(async () => ({ data: { sha: "new-tree" } })),
      createCommit: vi.fn(async () => ({ data: { sha: "new" } })), updateRef: vi.fn(async () => ({})) },
    pulls: { list: vi.fn(async () => ({ data: [{ number: 9, html_url: "https://github.com/org/app/pull/9", state: "open" }] })), create: vi.fn() },
  };
  const provider = new OctokitGithubProvider({ rest } as never, { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never);
  const input = { branch: "lexi/spec-abc", base: "main", path: "docs/specs/issue-1.md", body: "# CSV", title: "spec: CSV", expectedHead: "old" };
  return { rest, provider, input };
}
describe("spec-only publisher", () => {
  it("writes one Markdown file and updates its branch without force", async () => {
    const f = fixture(); expect(await f.provider.publishSpec("org", "app", f.input)).toMatchObject({ number: 9, head: "new" });
    expect(f.rest.git.createTree).toHaveBeenCalledWith(expect.objectContaining({ tree: [{ path: f.input.path, mode: "100644", type: "blob", content: "# CSV" }] }));
    expect(f.rest.git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
    expect(f.rest.pulls.create).not.toHaveBeenCalled();
  });
  it("cannot publish through a disabled mutation gateway", async () => {
    const f = fixture();
    const gateway = new GitHubMutationGateway(f.provider, { writesEnabled: false, dryRun: false }, { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never);
    await expect(gateway.publishSpec("org", "app", f.input)).rejects.toThrow();
    expect(f.rest.git.getRef).not.toHaveBeenCalled();
  });
  it("rejects a changed branch before writing", async () => {
    const f = fixture(); await expect(f.provider.publishSpec("org", "app", { ...f.input, expectedHead: "other" })).rejects.toThrow(/changed/);
    expect(f.rest.git.createTree).not.toHaveBeenCalled();
  });
  it("does not adopt a branch without a persisted head", async () => {
    const f = fixture(); await expect(f.provider.publishSpec("org", "app", { ...f.input, expectedHead: undefined })).rejects.toThrow(/already exists/);
    expect(f.rest.git.createTree).not.toHaveBeenCalled();
  });
  it.each([".github/workflows/ci.yml", "docs/specs/../../README.md", "src/app.ts"])("rejects writes to %s", async path => {
    const f = fixture(); await expect(f.provider.publishSpec("org", "app", { ...f.input, path })).rejects.toThrow(/Invalid/);
    expect(f.rest.git.getRef).not.toHaveBeenCalled();
  });
});
