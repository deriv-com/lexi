import type { ToolCallContext, ToolModule, ToolResult } from "@lexi/agent";
import type { GithubIssueDto, GithubPullRequestDto } from "@lexi/github";

/** Shared test fixtures. Fictional people, repositories and Slack ids only. */

export const ctx: ToolCallContext = {
  actorId: "U0TEST01",
  conversation: { channel: "C0TEST01", threadTs: "1700000000.000100" },
  maxResultChars: 20_000,
};

export function issue(overrides: Partial<GithubIssueDto> = {}): GithubIssueDto {
  return {
    githubIssueId: 9001,
    githubNumber: 12,
    repoOwner: "acme",
    repoName: "web",
    title: "Checkout button does nothing",
    body: "Clicking pay on the checkout page has no effect.",
    url: "https://github.com/acme/web/issues/12",
    authorLogin: "alice",
    labels: ["bug"],
    state: "open",
    stateReason: null,
    assignees: [],
    githubCreatedAt: "2026-01-01T00:00:00Z",
    githubUpdatedAt: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

export function pullRequest(overrides: Partial<GithubPullRequestDto> = {}): GithubPullRequestDto {
  return {
    number: 34,
    state: "open",
    merged: false,
    mergedAt: null,
    url: "https://github.com/acme/web/pull/34",
    mergeable: true,
    headRef: "lexi/fix-checkout",
    baseRef: "release",
    headSha: "a".repeat(40),
    draft: false,
    ...overrides,
  };
}

export function toolOf(module: ToolModule, name: string) {
  const tool = module.tools.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`module ${module.name} has no tool ${name}`);
  return tool;
}

export function text(result: ToolResult): string {
  return typeof result.content === "string"
    ? result.content
    : result.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
}
