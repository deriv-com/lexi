import { describe, it, expect, vi } from "vitest";
import { GitHubProvider, GithubCommentDto, GithubIssueDto, GithubPullRequestDto } from "@lexi/github";
import { PinoLoggerService } from "@lexi/logger";
import { CrossOrgClosureChecker } from "./cross-org-closure-checker";
import { IssueRecord } from "./types";
import { WorkflowStatus } from "@lexi/database";

function makeIssueRecord(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: "issue-1",
    githubIssueId: 1,
    githubNumber: 785,
    repoOwner: "acme",
    repoName: "issues",
    title: "Deposit button broken",
    body: null,
    url: "https://github.com/acme/issues/issues/785",
    authorLogin: "reporter",
    labels: ["bug"],
    state: "open",
    currentStatus: WorkflowStatus.QUEUED,
    assignedOwner: null,
    assignedTeam: null,
    githubCreatedAt: new Date(),
    githubUpdatedAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeComment(body: string, overrides: Partial<GithubCommentDto> = {}): GithubCommentDto {
  return { id: 1, authorLogin: "reporter", body, createdAt: new Date().toISOString(), ...overrides };
}

function makeGithub(overrides: Partial<GitHubProvider> = {}): GitHubProvider {
  return {
    listBugHuntIssues: vi.fn(),
    getIssue: vi.fn(),
    getPullRequest: vi.fn(),
    listComments: vi.fn().mockResolvedValue([]),
    addComment: vi.fn(),
    listTimeline: vi.fn(),
    listLinkedPullRequests: vi.fn(),
    setLabels: vi.fn(),
    addLabels: vi.fn(),
    removeLabels: vi.fn(),
    assignUsers: vi.fn(),
    closeIssue: vi.fn(),
    reopenIssue: vi.fn(),
    ...overrides,
  } as GitHubProvider;
}

describe("CrossOrgClosureChecker", () => {
  it("finds evidence from a closed issue linked in the issue body, when the linked owner is trusted", async () => {
    const issue = makeIssueRecord({
      body: "Same as https://github.com/acme-eng/web/issues/321",
    });
    const closedIssue: GithubIssueDto = {
      githubIssueId: 321,
      githubNumber: 321,
      repoOwner: "acme-eng",
      repoName: "web",
      title: "Deposit bug",
      body: null,
      url: "https://github.com/acme-eng/web/issues/321",
      authorLogin: "dev",
      labels: [],
      state: "closed",
      stateReason: "completed",
      assignees: [],
      githubCreatedAt: new Date().toISOString(),
      githubUpdatedAt: new Date().toISOString(),
    };
    const github = makeGithub({ getIssue: vi.fn().mockResolvedValue(closedIssue) });
    const checker = new CrossOrgClosureChecker(github, new PinoLoggerService({ level: "silent" }), ["acme-eng"]);

    const evidence = await checker.check(issue);

    expect(evidence).toEqual({ url: "https://github.com/acme-eng/web/issues/321", type: "issue" });
    expect(github.getIssue).toHaveBeenCalledWith("acme-eng", "web", 321);
  });

  it("finds evidence from a merged PR linked in a comment, when the linked owner is trusted", async () => {
    const issue = makeIssueRecord({ body: "No link in the body." });
    const comment = makeComment("Fixed here: https://github.com/acme-eng/web/pull/999");
    const mergedPr: GithubPullRequestDto = {
      number: 999,
      state: "closed",
      merged: true,
      mergedAt: "2026-01-01T00:00:00.000Z",
      url: "https://github.com/acme-eng/web/pull/999",
    };
    const github = makeGithub({
      listComments: vi.fn().mockResolvedValue([comment]),
      getPullRequest: vi.fn().mockResolvedValue(mergedPr),
    });
    const checker = new CrossOrgClosureChecker(github, new PinoLoggerService({ level: "silent" }), ["acme-eng"]);

    const evidence = await checker.check(issue);

    expect(evidence).toEqual({ url: "https://github.com/acme-eng/web/pull/999", type: "pull" });
    expect(github.getPullRequest).toHaveBeenCalledWith("acme-eng", "web", 999);
  });

  it("returns null when the linked issue is still open", async () => {
    const issue = makeIssueRecord({
      body: "See https://github.com/acme-eng/web/issues/50",
    });
    const openIssue: GithubIssueDto = {
      githubIssueId: 50,
      githubNumber: 50,
      repoOwner: "acme-eng",
      repoName: "web",
      title: "Still open",
      body: null,
      url: "https://github.com/acme-eng/web/issues/50",
      authorLogin: "dev",
      labels: [],
      state: "open",
      stateReason: null,
      assignees: [],
      githubCreatedAt: new Date().toISOString(),
      githubUpdatedAt: new Date().toISOString(),
    };
    const github = makeGithub({ getIssue: vi.fn().mockResolvedValue(openIssue) });
    const checker = new CrossOrgClosureChecker(github, new PinoLoggerService({ level: "silent" }), ["acme-eng"]);

    const evidence = await checker.check(issue);

    expect(evidence).toBeNull();
  });

  it("returns null and makes no GitHub calls when there are no links at all", async () => {
    const issue = makeIssueRecord({ body: "Nothing linked here." });
    const github = makeGithub();
    const checker = new CrossOrgClosureChecker(github, new PinoLoggerService({ level: "silent" }), ["acme-eng"]);

    const evidence = await checker.check(issue);

    expect(evidence).toBeNull();
    expect(github.getIssue).not.toHaveBeenCalled();
    expect(github.getPullRequest).not.toHaveBeenCalled();
  });

  it("does not throw when a linked ref errors, and continues checking remaining refs", async () => {
    const issue = makeIssueRecord({
      body: [
        "Maybe related to https://github.com/acme-eng/private-repo/issues/1",
        "and also https://github.com/acme-eng/web/issues/2",
      ].join(" "),
    });
    const openIssue: GithubIssueDto = {
      githubIssueId: 2,
      githubNumber: 2,
      repoOwner: "acme-eng",
      repoName: "web",
      title: "Still open",
      body: null,
      url: "https://github.com/acme-eng/web/issues/2",
      authorLogin: "dev",
      labels: [],
      state: "open",
      stateReason: null,
      assignees: [],
      githubCreatedAt: new Date().toISOString(),
      githubUpdatedAt: new Date().toISOString(),
    };
    const github = makeGithub({
      getIssue: vi
        .fn()
        .mockRejectedValueOnce({ status: 404, message: "Not Found" })
        .mockResolvedValueOnce(openIssue),
    });
    const checker = new CrossOrgClosureChecker(github, new PinoLoggerService({ level: "silent" }), ["acme-eng"]);

    await expect(checker.check(issue)).resolves.toBeNull();
    expect(github.getIssue).toHaveBeenCalledTimes(2);
  });

  describe("trusted-owner security boundary", () => {
    it("ignores a link to a closed issue in an untrusted owner's repo -- never even calls GitHub about it", async () => {
      const issue = makeIssueRecord({
        body: "Duplicate of https://github.com/some-random-attacker-repo/throwaway/issues/1",
      });
      const github = makeGithub();
      // No trustedOwners configured, and "some-random-attacker-repo" isn't the issue's own owner.
      const checker = new CrossOrgClosureChecker(github, new PinoLoggerService({ level: "silent" }), []);

      const evidence = await checker.check(issue);

      expect(evidence).toBeNull();
      expect(github.getIssue).not.toHaveBeenCalled();
      expect(github.getPullRequest).not.toHaveBeenCalled();
    });

    it("ignores a link to a merged PR in an untrusted owner's repo even though it would otherwise count as evidence", async () => {
      const issue = makeIssueRecord({
        body: "Fixed here: https://github.com/attacker-controlled-org/throwaway/pull/1",
      });
      const github = makeGithub({
        getPullRequest: vi.fn().mockResolvedValue({
          number: 1,
          state: "closed",
          merged: true,
          mergedAt: "2026-01-01T00:00:00.000Z",
          url: "https://github.com/attacker-controlled-org/throwaway/pull/1",
        } satisfies GithubPullRequestDto),
      });
      const checker = new CrossOrgClosureChecker(github, new PinoLoggerService({ level: "silent" }), ["acme-eng"]);

      const evidence = await checker.check(issue);

      expect(evidence).toBeNull();
      expect(github.getPullRequest).not.toHaveBeenCalled();
    });

    it("always trusts a link back to the issue's own owner, with no config needed", async () => {
      const issue = makeIssueRecord({
        body: "Duplicate of https://github.com/acme/issues/issues/700",
      });
      const closedIssue: GithubIssueDto = {
        githubIssueId: 700,
        githubNumber: 700,
        repoOwner: "acme",
        repoName: "issues",
        title: "Same bug, filed earlier",
        body: null,
        url: "https://github.com/acme/issues/issues/700",
        authorLogin: "someone-else",
        labels: [],
        state: "closed",
        stateReason: "completed",
        assignees: [],
        githubCreatedAt: new Date().toISOString(),
        githubUpdatedAt: new Date().toISOString(),
      };
      const github = makeGithub({ getIssue: vi.fn().mockResolvedValue(closedIssue) });
      const checker = new CrossOrgClosureChecker(github, new PinoLoggerService({ level: "silent" }), []);

      const evidence = await checker.check(issue);

      expect(evidence).toEqual({ url: "https://github.com/acme/issues/issues/700", type: "issue" });
    });

    it("trusted-owner matching is case-insensitive", async () => {
      const issue = makeIssueRecord({
        body: "Same as https://github.com/Acme-Eng/web/issues/321",
      });
      const closedIssue: GithubIssueDto = {
        githubIssueId: 321,
        githubNumber: 321,
        repoOwner: "Acme-Eng",
        repoName: "web",
        title: "Deposit bug",
        body: null,
        url: "https://github.com/Acme-Eng/web/issues/321",
        authorLogin: "dev",
        labels: [],
        state: "closed",
        stateReason: "completed",
        assignees: [],
        githubCreatedAt: new Date().toISOString(),
        githubUpdatedAt: new Date().toISOString(),
      };
      const github = makeGithub({ getIssue: vi.fn().mockResolvedValue(closedIssue) });
      const checker = new CrossOrgClosureChecker(github, new PinoLoggerService({ level: "silent" }), ["acme-eng"]);

      const evidence = await checker.check(issue);

      expect(evidence).not.toBeNull();
    });
  });
});
