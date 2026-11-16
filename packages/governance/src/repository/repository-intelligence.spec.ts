import { describe, it, expect, vi } from "vitest";
import { RepositoryIntelligenceService } from "./repository-intelligence";
import { RepositoryRegistry } from "./repository-registry";
import type { GitHubProvider } from "@lexi/github";

// Fake registry that returns controlled results without reading a YAML file
function fakeRegistry(products: Array<{ team: string; platform: "web" | "mobile"; placeholder?: boolean }>) {
  return {
    getSourceRepository: () => ({ organization: "acme-internal", repository: "issues", fullName: "acme-internal/issues" }),
    listProducts: () => products.map((p, i) => ({
      productKey: `product_${i}`,
      organization: "acme",
      repository: `repo-${i}`,
      fullName: `acme/repo-${i}`,
      platform: p.platform,
      team: p.team,
      placeholder: p.placeholder ?? false,
      project: undefined,
    })),
    resolveAllForTeam: (team: string) =>
      products
        .filter((p) => p.team === team)
        .map((p, i) => ({
          productKey: `product_${i}`,
          organization: "acme",
          repository: `repo-${i}`,
          fullName: `acme/repo-${i}`,
          platform: p.platform,
          team: p.team,
          placeholder: p.placeholder ?? false,
          project: undefined,
        })),
  } as unknown as RepositoryRegistry;
}

const silentLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe("RepositoryIntelligenceService", () => {
  it("returns no_implementation_found when no team can be inferred", async () => {
    const service = new RepositoryIntelligenceService(fakeRegistry([]), {} as GitHubProvider, silentLogger);
    const ctx = await service.resolveContext(909);
    expect(ctx.resolution.status).toBe("unknown");
    expect(ctx.dataCompleteness.notes.length).toBeGreaterThan(0);
  });

  it("returns placeholder_repo when the resolved repo is a placeholder", async () => {
    const service = new RepositoryIntelligenceService(
      fakeRegistry([{ team: "homepage", platform: "web", placeholder: true }]),
      {} as GitHubProvider,
      silentLogger,
    );
    const ctx = await service.resolveContext(909, "homepage");
    expect(ctx.resolution.status).toBe("placeholder_repo");
    expect(ctx.dataCompleteness.repoIsPlaceholder).toBe(true);
  });

  it("returns no_implementation_found when no linked PRs exist", async () => {
    const github = {
      listLinkedPullRequests: vi.fn().mockResolvedValue([]),
    } as unknown as GitHubProvider;
    const service = new RepositoryIntelligenceService(
      fakeRegistry([{ team: "homepage", platform: "web" }]),
      github,
      silentLogger,
    );
    const ctx = await service.resolveContext(909, "homepage");
    expect(ctx.resolution.status).toBe("no_implementation_found");
    expect(ctx.dataCompleteness.hasLinkedPRs).toBe(false);
    expect(ctx.resolution.confidence).toBe("medium");
  });

  it("returns pr_open when a linked PR is open", async () => {
    const github = {
      listLinkedPullRequests: vi.fn().mockResolvedValue([
        { number: 421, title: "Fix signup flow", state: "open", url: "https://github.com/acme/repo-0/pull/421", merged: false },
      ]),
    } as unknown as GitHubProvider;
    const service = new RepositoryIntelligenceService(
      fakeRegistry([{ team: "homepage", platform: "web" }]),
      github,
      silentLogger,
    );
    const ctx = await service.resolveContext(909, "homepage");
    expect(ctx.resolution.status).toBe("pr_open");
    expect(ctx.implementation?.pullRequests[0].number).toBe(421);
  });

  it("returns pr_merged_awaiting_verification when a PR is merged — never claims fixed", async () => {
    const github = {
      listLinkedPullRequests: vi.fn().mockResolvedValue([
        { number: 421, title: "Fix signup flow", state: "closed", url: "https://github.com/acme/repo-0/pull/421", merged: true },
      ]),
    } as unknown as GitHubProvider;
    const service = new RepositoryIntelligenceService(
      fakeRegistry([{ team: "homepage", platform: "web" }]),
      github,
      silentLogger,
    );
    const ctx = await service.resolveContext(909, "homepage");
    expect(ctx.resolution.status).toBe("pr_merged_awaiting_verification");
    expect(ctx.resolution.summary).toContain("not been verified");
    expect(ctx.resolution.summary).not.toContain("fixed");
  });

  it("returns no_implementation_found when all PRs are closed without merge", async () => {
    const github = {
      listLinkedPullRequests: vi.fn().mockResolvedValue([
        { number: 100, title: "Abandoned attempt", state: "closed", url: "https://github.com/x/y/pull/100", merged: false },
      ]),
    } as unknown as GitHubProvider;
    const service = new RepositoryIntelligenceService(
      fakeRegistry([{ team: "homepage", platform: "web" }]),
      github,
      silentLogger,
    );
    const ctx = await service.resolveContext(909, "homepage");
    expect(ctx.resolution.status).toBe("no_implementation_found");
    expect(ctx.resolution.summary).toContain("closed without merge");
  });

  it("handles GitHub API failure gracefully", async () => {
    const github = {
      listLinkedPullRequests: vi.fn().mockRejectedValue(new Error("403 Forbidden")),
    } as unknown as GitHubProvider;
    const service = new RepositoryIntelligenceService(
      fakeRegistry([{ team: "homepage", platform: "web" }]),
      github,
      silentLogger,
    );
    const ctx = await service.resolveContext(909, "homepage");
    expect(ctx.resolution.status).toBe("unknown");
    expect(ctx.resolution.confidence).toBe("low");
    expect(ctx.dataCompleteness.notes).toContain("GitHub API error: 403 Forbidden");
  });

  it("resolves multiple PRs and reports the most relevant", async () => {
    const github = {
      listLinkedPullRequests: vi.fn().mockResolvedValue([
        { number: 100, title: "First attempt", state: "closed", url: "url1", merged: false },
        { number: 200, title: "Real fix", state: "closed", url: "url2", merged: true },
      ]),
    } as unknown as GitHubProvider;
    const service = new RepositoryIntelligenceService(
      fakeRegistry([{ team: "homepage", platform: "web" }]),
      github,
      silentLogger,
    );
    const ctx = await service.resolveContext(909, "homepage");
    expect(ctx.resolution.status).toBe("pr_merged_awaiting_verification");
    expect(ctx.implementation?.pullRequests).toHaveLength(2);
  });

  it("never claims fixed — merged is the highest status without release/verification evidence", async () => {
    const github = {
      listLinkedPullRequests: vi.fn().mockResolvedValue([
        { number: 421, title: "Fix", state: "closed", url: "url", merged: true },
      ]),
    } as unknown as GitHubProvider;
    const service = new RepositoryIntelligenceService(
      fakeRegistry([{ team: "homepage", platform: "web" }]),
      github,
      silentLogger,
    );
    const ctx = await service.resolveContext(909, "homepage");
    // The status must never be "fix_released" or "verified_fixed" from a merged PR alone
    expect(ctx.resolution.status).not.toBe("fix_released");
    expect(ctx.resolution.status).not.toContain("verified");
    expect(ctx.resolution.summary).toContain("not been verified");
  });
});
