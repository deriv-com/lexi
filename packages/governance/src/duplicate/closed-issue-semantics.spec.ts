/**
 * These paths were dead code before this suite existed: resolveClosedIssueAction
 * was implemented but called from nowhere, and listCandidateIssues hardcoded
 * closedReason to "completed" — which would have classified every closed issue
 * as a regression the moment the rules were wired up.
 */
import { describe, expect, it, vi } from "vitest";
import type { GithubIssueDto, GitHubProvider } from "@lexi/github";
import {
  ClosedIssueResolver,
  followCanonicalChain,
  raisePriorityLabels,
} from "./closed-issue-resolver";

const OWNER = "acme-internal";
const REPO = "issues";

function issue(overrides: Partial<GithubIssueDto> & { githubNumber: number }): GithubIssueDto {
  return {
    githubIssueId: overrides.githubNumber * 1000,
    repoOwner: OWNER,
    repoName: REPO,
    title: `Issue ${overrides.githubNumber}`,
    body: null,
    url: `https://github.com/${OWNER}/${REPO}/issues/${overrides.githubNumber}`,
    authorLogin: "reporter",
    labels: [],
    state: "closed",
    stateReason: null,
    assignees: [],
    githubCreatedAt: "2024-01-01T00:00:00Z",
    githubUpdatedAt: "2024-01-02T00:00:00Z",
    ...overrides,
  };
}

const MUTATION_METHODS = [
  "createIssue",
  "addComment",
  "setLabels",
  "addLabels",
  "removeLabels",
  "assignUsers",
  "closeIssue",
  "reopenIssue",
] as const;

function fakeGithub(issues: GithubIssueDto[]) {
  const byNumber = new Map(issues.map((i) => [i.githubNumber, i]));
  const github = {
    listBugHuntIssues: vi.fn(),
    listIssues: vi.fn(),
    createIssue: vi.fn(async (_o: string, _r: string, title: string, _b: string, labels?: string[]) =>
      issue({ githubNumber: 999, title, labels: labels ?? [], state: "open" }),
    ),
    getIssue: vi.fn(async (_o: string, _r: string, n: number) => {
      const found = byNumber.get(n);
      if (!found) throw new Error(`issue #${n} not found`);
      return found;
    }),
    getPullRequest: vi.fn(),
    listComments: vi.fn(),
    addComment: vi.fn(async (_o: string, _r: string, _n: number, body: string) => ({
      id: 1,
      authorLogin: "bot",
      body,
      createdAt: "2024-01-03T00:00:00Z",
    })),
    listTimeline: vi.fn(),
    listLinkedPullRequests: vi.fn(),
    setLabels: vi.fn(async () => []),
    addLabels: vi.fn(async () => []),
    removeLabels: vi.fn(async () => undefined),
    assignUsers: vi.fn(async () => []),
    closeIssue: vi.fn(async (_o: string, _r: string, n: number) => issue({ githubNumber: n })),
    reopenIssue: vi.fn(async (_o: string, _r: string, n: number) => issue({ githubNumber: n, state: "open" })),
  };
  return github as unknown as GitHubProvider & typeof github;
}

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function resolver(
  github: GitHubProvider,
  overrides: Partial<{ enabled: boolean; maxChainDepth: number; regressionLabel: string }> = {},
) {
  return new ClosedIssueResolver(
    github,
    {
      owner: OWNER,
      repo: REPO,
      enabled: true,
      maxChainDepth: 10,
      regressionLabel: "regression",
      ...overrides,
    },
    logger,
  );
}

const submission = {
  title: "Deposit button does nothing",
  url: "https://github.com/acme-internal/intake/issues/7",
  summary: "Clicking Deposit produces no network request.",
};

describe("ClosedIssueResolver", () => {
  it("reopens an issue closed as not_planned", async () => {
    const github = fakeGithub([issue({ githubNumber: 10, stateReason: "not_planned" })]);
    const result = await resolver(github).resolve(10, submission);

    expect(result.action).toBe("REOPEN");
    expect(result.executed).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.reopenedIssue).toBe(10);
    expect(github.reopenIssue).toHaveBeenCalledWith(OWNER, REPO, 10);
    expect(github.addComment).toHaveBeenCalledTimes(1);
    expect(github.addComment.mock.calls[0][3]).toContain(submission.summary);
  });

  it("reopens an issue labelled lexi:not-observed", async () => {
    const github = fakeGithub([
      issue({ githubNumber: 11, stateReason: null, labels: ["lexi:not-observed"] }),
    ]);
    const result = await resolver(github).resolve(11, submission);

    expect(result.action).toBe("REOPEN");
    expect(result.executed).toBe(true);
    expect(result.reopenedIssue).toBe(11);
    expect(github.reopenIssue).toHaveBeenCalledWith(OWNER, REPO, 11);
  });

  it("files a regression for an issue closed as completed", async () => {
    const github = fakeGithub([issue({ githubNumber: 12, stateReason: "completed" })]);
    const result = await resolver(github).resolve(12, submission);

    expect(result.action).toBe("REGRESSION");
    expect(result.executed).toBe(true);
    expect(result.regressionIssue).toBe(999);
    expect(github.reopenIssue).not.toHaveBeenCalled();

    const [, , title, body, labels] = github.createIssue.mock.calls[0];
    expect(title).toBe(`[Regression] ${submission.title}`);
    expect(body).toContain("#12");
    expect(body).toContain(submission.summary);
    expect(labels).toContain("regression");

    expect(github.addComment).toHaveBeenCalledTimes(1);
    const [, , commentedOn, commentBody] = github.addComment.mock.calls[0];
    expect(commentedOn).toBe(12);
    expect(commentBody).toContain("#999");
  });

  it("raises the priority label by one level on the regression issue", async () => {
    const github = fakeGithub([
      issue({ githubNumber: 13, stateReason: "completed", labels: ["bug", "priority:P3"] }),
    ]);
    const result = await resolver(github).resolve(13, submission);

    expect(result.action).toBe("REGRESSION");
    const labels = github.createIssue.mock.calls[0][4] as string[];
    expect(labels).toContain("priority:P2");
    expect(labels).not.toContain("priority:P3");
    expect(labels).toContain("bug");
  });

  it("resolves a duplicate chain to its ultimate canonical without mutating", async () => {
    const github = fakeGithub([
      issue({ githubNumber: 20, labels: ["duplicate"], body: "Duplicate of #21" }),
      issue({ githubNumber: 21, labels: ["duplicate"], body: "Duplicate of #22" }),
      issue({ githubNumber: 22, state: "open", labels: ["bug"] }),
    ]);
    const result = await resolver(github).resolve(20, submission);

    expect(result.action).toBe("RESOLVE_CANONICAL");
    expect(result.executed).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.ultimateCanonical).toBe(22);
    expect(result.chain).toEqual([20, 21, 22]);

    for (const method of MUTATION_METHODS) {
      expect(github[method]).not.toHaveBeenCalled();
    }
  });

  it("open issue is left alone entirely", async () => {
    const github = fakeGithub([issue({ githubNumber: 30, state: "open" })]);
    const result = await resolver(github).resolve(30, submission);

    expect(result.action).toBe("NONE");
    expect(result.executed).toBe(false);
    expect(result.blocked).toBe(false);
    for (const method of MUTATION_METHODS) {
      expect(github[method]).not.toHaveBeenCalled();
    }
  });

  it("with the flag disabled still decides the action but performs no mutation", async () => {
    const github = fakeGithub([issue({ githubNumber: 40, stateReason: "not_planned" })]);
    const result = await resolver(github, { enabled: false }).resolve(40, submission);

    expect(result.action).toBe("REOPEN");
    expect(result.executed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("CLOSED_ISSUE_SEMANTICS_ENABLED=false");
    for (const method of MUTATION_METHODS) {
      expect(github[method]).not.toHaveBeenCalled();
    }
  });

  it("reports a write-gate rejection as blocked instead of throwing", async () => {
    const github = fakeGithub([issue({ githubNumber: 50, stateReason: "not_planned" })]);
    github.reopenIssue.mockRejectedValueOnce(new Error("writes disabled by mutation gateway"));

    const result = await resolver(github).resolve(50, submission);

    expect(result.action).toBe("REOPEN");
    expect(result.executed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("writes disabled by mutation gateway");
    expect(result.reopenedIssue).toBeUndefined();
    expect(github.addComment).not.toHaveBeenCalled();
  });
});

describe("followCanonicalChain", () => {
  const refs = (text: string) => [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

  it("terminates on an A -> B -> A cycle", async () => {
    const nodes = new Map([
      [1, { number: 1, state: "closed", labels: ["duplicate"], body: "dup of #2" }],
      [2, { number: 2, state: "closed", labels: ["duplicate"], body: "dup of #1" }],
    ]);
    const result = await followCanonicalChain(1, async (n) => nodes.get(n) ?? null, refs, 10);

    expect(result.stoppedBecause).toBe("cycle");
    expect(result.chain).toEqual([1, 2]);
    expect(result.ultimate).toBe(2);
  });

  it("stops at the depth cap on a chain longer than maxDepth", async () => {
    const fetchIssue = async (n: number) => ({
      number: n,
      state: "closed",
      labels: ["duplicate"],
      body: `dup of #${n + 1}`,
    });
    const result = await followCanonicalChain(1, fetchIssue, refs, 3);

    expect(result.stoppedBecause).toBe("depth");
    expect(result.chain).toEqual([1, 2, 3]);
  });
});

describe("raisePriorityLabels", () => {
  it("raises P3 to P2", () => {
    expect(raisePriorityLabels(["priority:P3"])).toEqual(["priority:P2"]);
  });

  it("raises P1 to P0", () => {
    expect(raisePriorityLabels(["priority:P1"])).toEqual(["priority:P0"]);
  });

  it("floors at P0", () => {
    expect(raisePriorityLabels(["priority:P0"])).toEqual(["priority:P0"]);
  });

  it("leaves label sets without a priority untouched", () => {
    expect(raisePriorityLabels(["bug", "severity:high"])).toEqual(["bug", "severity:high"]);
  });
});
