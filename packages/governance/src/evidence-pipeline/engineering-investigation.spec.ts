import { describe, it, expect, vi } from "vitest";
import {
  EngineeringChangeInvestigationService,
  type InvestigationGitHubPort,
} from "./engineering-investigation.service";

function createMockGitHub(overrides: Partial<InvestigationGitHubPort> = {}): InvestigationGitHubPort {
  return {
    getIssue: vi.fn(async () => ({
      githubNumber: 856,
      title: "Cashier withdrawal crash",
      body: "Steps to reproduce...",
      state: "open" as const,
      labels: ["bug", "priority:P1"],
      assignees: [],
      stateReason: null,
    })),
    listLinkedPullRequests: vi.fn(async () => []),
    listComments: vi.fn(async () => []),
    listTimeline: vi.fn(async () => []),
    ...overrides,
  };
}

const baseConfig = {
  sourceOwner: "acme-internal",
  sourceRepo: "issues",
  targetRepositories: [{ owner: "acme", repo: "web-app" }],
};

describe("EngineeringChangeInvestigationService", () => {
  it("reports 'checked and found nothing' when APIs succeed but return empty", async () => {
    const github = createMockGitHub();
    const service = new EngineeringChangeInvestigationService(github, baseConfig);

    const result = await service.investigate(856);

    expect(result.errors).toHaveLength(0);
    expect(result.repositoriesChecked).toContain("acme-internal/issues");
    expect(result.linkedPullRequests).toHaveLength(0);
    expect(result.linkedIssues).toHaveLength(0);
    expect(result.activeEngineeringWork).toBe(false);
    // No errors means we checked and found nothing
    expect(result.codeEvidence.fixCommitOnDefault).toBe(false);
  });

  it("reports errors when GitHub API fails (does not conflate with 'no fix found')", async () => {
    const github = createMockGitHub({
      listLinkedPullRequests: vi.fn(async () => { throw new Error("API rate limit exceeded"); }),
      listTimeline: vi.fn(async () => { throw new Error("Not Found"); }),
      listComments: vi.fn(async () => []),
    });
    const service = new EngineeringChangeInvestigationService(github, baseConfig);

    const result = await service.investigate(856);

    // Errors are captured, not swallowed
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].stage).toBe("linked_pull_requests");
    expect(result.errors[0].message).toContain("rate limit");
    // Limitations explain what couldn't be checked
    expect(result.limitations.some((l) => l.includes("API call(s) failed"))).toBe(true);
  });

  it("identifies active engineering work from open PRs", async () => {
    const github = createMockGitHub({
      listLinkedPullRequests: vi.fn(async () => [
        { number: 42, url: "https://github.com/...", state: "open" as const, merged: false, title: "Fix cashier crash" },
      ]),
    });
    const service = new EngineeringChangeInvestigationService(github, baseConfig);

    const result = await service.investigate(856);

    expect(result.activeEngineeringWork).toBe(true);
    expect(result.linkedPullRequests).toHaveLength(1);
    expect(result.linkedPullRequests[0].state).toBe("open");
    expect(result.codeEvidence.fixOnFeatureBranchOnly).toBe(true);
    expect(result.codeEvidence.fixCommitOnDefault).toBe(false);
  });

  it("detects merged PRs and derives code evidence", async () => {
    const github = createMockGitHub({
      listLinkedPullRequests: vi.fn(async () => [
        { number: 99, url: "https://github.com/...", state: "closed" as const, merged: true, title: "Fix withdrawal validation" },
      ]),
    });
    const service = new EngineeringChangeInvestigationService(github, baseConfig);

    const result = await service.investigate(856);

    expect(result.linkedPullRequests).toHaveLength(1);
    expect(result.linkedPullRequests[0].state).toBe("merged");
    expect(result.codeEvidence.fixCommitOnDefault).toBe(true);
    expect(result.codeEvidence.fixOnFeatureBranchOnly).toBe(false);
  });

  it("detects fix indicators in comments", async () => {
    const github = createMockGitHub({
      listComments: vi.fn(async () => [
        { id: 1, authorLogin: "dev-person", body: "This was fixed in #42, deployed to production.", createdAt: "2026-08-01" },
      ]),
    });
    const service = new EngineeringChangeInvestigationService(github, baseConfig);

    const result = await service.investigate(856);

    // Comments indicating fix should upgrade release evidence
    expect(result.releaseEvidence.fixReleased).toBeNull(); // No merged PR, so still null
  });

  it("comments + merged PR together elevate release evidence", async () => {
    const github = createMockGitHub({
      listLinkedPullRequests: vi.fn(async () => [
        { number: 99, url: "https://github.com/...", state: "closed" as const, merged: true, title: "Fix withdrawal" },
      ]),
      listComments: vi.fn(async () => [
        { id: 1, authorLogin: "dev", body: "Fixed in #99, deployed to staging.", createdAt: "2026-08-01" },
      ]),
    });
    const service = new EngineeringChangeInvestigationService(github, baseConfig);

    const result = await service.investigate(856);

    expect(result.codeEvidence.fixCommitOnDefault).toBe(true);
    expect(result.releaseEvidence.fixReleased).toBe(true);
    // But production deployment is still unconfirmed
    expect(result.releaseEvidence.deployedToProduction).toBeNull();
  });

  it("cross-references from timeline are captured as linked issues/PRs", async () => {
    const github = createMockGitHub({
      listTimeline: vi.fn(async () => [
        {
          event: "cross-referenced",
          actorLogin: "dev",
          createdAt: "2026-08-01",
          raw: {
            source: {
              issue: {
                number: 200,
                title: "Implement deposit fix",
                state: "closed",
                repository: { full_name: "acme/web-app" },
                pull_request: { merged_at: "2026-07-25" },
              },
            },
          },
        },
        {
          event: "cross-referenced",
          actorLogin: "user",
          createdAt: "2026-08-02",
          raw: {
            source: {
              issue: {
                number: 300,
                title: "Related cashier issue",
                state: "open",
                repository: { full_name: "acme-internal/issues" },
              },
            },
          },
        },
      ]),
    });
    const service = new EngineeringChangeInvestigationService(github, baseConfig);

    const result = await service.investigate(856);

    // PR cross-reference
    expect(result.linkedPullRequests).toHaveLength(1);
    expect(result.linkedPullRequests[0].number).toBe(200);
    expect(result.linkedPullRequests[0].state).toBe("merged");
    expect(result.linkedPullRequests[0].repo).toBe("acme/web-app");

    // Issue cross-reference
    expect(result.linkedIssues).toHaveLength(1);
    expect(result.linkedIssues[0].number).toBe(300);
    expect(result.linkedIssues[0].state).toBe("open");
  });

  it("search is used when available and terms provided", async () => {
    const searchFn = vi.fn(async () => [
      { number: 500, state: "merged" as const, merged: true, title: "Fix withdrawal timeout", mergedAt: "2026-07-20" },
    ]);
    const github = createMockGitHub({ searchPullRequests: searchFn });
    const service = new EngineeringChangeInvestigationService(github, baseConfig);

    const result = await service.investigate(856, ["withdrawal", "timeout"]);

    expect(searchFn).toHaveBeenCalledWith("acme", "web-app", "withdrawal timeout");
    expect(result.repositoriesChecked).toContain("acme/web-app");
    expect(result.linkedPullRequests.some((pr) => pr.number === 500)).toBe(true);
  });

  it("limitations include code analysis unavailability", async () => {
    const github = createMockGitHub();
    const service = new EngineeringChangeInvestigationService(github, baseConfig);

    const result = await service.investigate(856);

    expect(result.codeEvidence.suspectedPatternExists).toBeNull();
    expect(result.limitations.some((l) => l.includes("Code analysis not performed"))).toBe(true);
  });
});
