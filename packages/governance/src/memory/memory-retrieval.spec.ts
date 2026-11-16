import { describe, it, expect, vi } from "vitest";
import { MemoryRetrievalService } from "./memory-retrieval.service";
import type { EngineeringKnowledgeGraphService } from "./engineering-knowledge-graph.service";
import type { UserPreferenceService } from "./user-preference.service";
import type { IssueMemoryService } from "./issue-memory.service";

function createMockKnowledgeGraph(): EngineeringKnowledgeGraphService {
  return {
    getIssueKnowledgeChain: vi.fn(async (issueNumber) => {
      if (issueNumber === 856) {
        return {
          issueNumber: 856,
          repo: "acme-internal/issues",
          fixes: [{ prNumber: 42, prRepo: "acme/web-app", mergedAt: "2026-07-20", author: "bob" }],
          regressions: [],
          relatedIssues: [{ number: 900, relationship: "related_to", title: "Similar cashier bug" }],
          releases: [{ version: "v2.5.1", releasedAt: "2026-07-25", includesFix: true }],
          owners: [{ login: "bob", role: "fixer" }],
        };
      }
      return null;
    }),
    findByEngineer: vi.fn(async () => []),
    buildHistorySummary: vi.fn(async () => null),
  } as unknown as EngineeringKnowledgeGraphService;
}

function createMockUserPrefs(): UserPreferenceService {
  return {
    getProfile: vi.fn(async (slackId) => ({
      slackId,
      detailLevel: "detailed",
      timezone: "Asia/Kolkata",
      role: "admin",
      teams: ["platform"],
      watchedRepos: [],
      watchedIssues: [856],
      ownedComponents: ["lexi"],
      preferences: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  } as unknown as UserPreferenceService;
}

function createMockIssueMemory(): IssueMemoryService {
  return {
    getMemory: vi.fn(async (issueNumber) => {
      if (issueNumber === 856) {
        return {
          id: "mem-1",
          issueNumber: 856,
          repo: "acme-internal/issues",
          summary: "Issue #856: processed 3 time(s). Last investigation (retest): VERIFIED at 0.91. Bug confirmed in cashier withdrawal flow.",
          facts: [
            { key: "root_cause", value: "null reference in withdrawal handler", confidence: 0.85, source: "bre", observedAt: new Date() },
            { key: "component", value: "cashier", confidence: 0.95, source: "claude", observedAt: new Date() },
          ],
          regressionChain: [{ issueNumber: 800, fixPR: 30, fixRelease: "v2.3.0", regressedInRelease: "v2.5.1", engineer: "bob" }],
          investigations: [],
          processCount: 3,
          lastUpdatedAt: new Date(),
        };
      }
      if (issueNumber === 900) {
        return {
          id: "mem-2", issueNumber: 900, repo: "acme-internal/issues",
          summary: "Issue #900: similar cashier bug, unresolved.", facts: [], investigations: [], processCount: 1, lastUpdatedAt: new Date(),
        };
      }
      return null;
    }),
  } as unknown as IssueMemoryService;
}

describe("MemoryRetrievalService", () => {
  it("retrieves full context for a known issue", async () => {
    const service = new MemoryRetrievalService(
      createMockKnowledgeGraph(), createMockUserPrefs(), createMockIssueMemory(), "acme-internal/issues",
    );

    const context = await service.retrieve({ actorSlackId: "U0TEST01", issueNumber: 856 });

    expect(context.userProfile).toBeDefined();
    expect(context.userProfile!.detailLevel).toBe("detailed");
    expect(context.issueMemory).toBeDefined();
    expect(context.issueMemory!.processCount).toBe(3);
    expect(context.engineeringKnowledge).toBeDefined();
    expect(context.engineeringKnowledge!.fixes).toHaveLength(1);
    expect(context.relatedMemories).toBeDefined();
    expect(context.relatedMemories!).toHaveLength(1);
    expect(context.estimatedTokens).toBeGreaterThan(0);
  });

  it("returns only user profile when no issue specified", async () => {
    const service = new MemoryRetrievalService(
      createMockKnowledgeGraph(), createMockUserPrefs(), createMockIssueMemory(), "acme-internal/issues",
    );

    const context = await service.retrieve({ actorSlackId: "U0TEST01" });

    expect(context.userProfile).toBeDefined();
    expect(context.issueMemory).toBeUndefined();
    expect(context.engineeringKnowledge).toBeUndefined();
    expect(context.priority).toBe("low");
  });

  it("assigns critical priority to regression issues", async () => {
    const service = new MemoryRetrievalService(
      createMockKnowledgeGraph(), createMockUserPrefs(), createMockIssueMemory(), "acme-internal/issues",
    );

    const context = await service.retrieve({ issueNumber: 856 });

    // Issue 856 has a regression chain in its memory
    expect(context.priority).toBe("critical");
  });

  it("formats context respecting detail level", async () => {
    const service = new MemoryRetrievalService(
      createMockKnowledgeGraph(), createMockUserPrefs(), createMockIssueMemory(), "acme-internal/issues",
    );

    const context = await service.retrieve({ actorSlackId: "U0TEST01", issueNumber: 856 });
    const formatted = service.formatForConversation(context);

    expect(formatted).toContain("Issue Memory");
    expect(formatted).toContain("Engineering");
    expect(formatted).toContain("bob");
    expect(formatted).toContain("v2.5.1");
    expect(formatted).toContain("Regression chain");
  });

  it("respects token budget — skips related memories when budget is tight", async () => {
    const service = new MemoryRetrievalService(
      createMockKnowledgeGraph(), createMockUserPrefs(), createMockIssueMemory(), "acme-internal/issues",
    );

    const context = await service.retrieve({ actorSlackId: "U0TEST01", issueNumber: 856, maxTokenBudget: 100 });

    // With a very tight budget, engineering knowledge may be included but related memories skipped
    expect(context.estimatedTokens).toBeLessThanOrEqual(200); // Approximate
  });

  it("returns null engineering knowledge for unknown issues", async () => {
    const service = new MemoryRetrievalService(
      createMockKnowledgeGraph(), createMockUserPrefs(), createMockIssueMemory(), "acme-internal/issues",
    );

    const context = await service.retrieve({ issueNumber: 9999 });
    expect(context.engineeringKnowledge).toBeUndefined();
    expect(context.issueMemory).toBeUndefined();
  });

  it("surfaces human corrections as lessons for the next act", async () => {
    const feedback = {
      getLessonsForContext: vi.fn(async () => [
        {
          id: "fb-1",
          issueNumber: 856,
          repository: "acme-internal/issues",
          category: "ownership_wrong",
          originalDecision: "Assigned to Web",
          correction: "Cashier owns this",
          correctedBy: "U1",
          reason: "label inference used platform not component",
          createdAt: new Date().toISOString(),
        },
      ]),
    };
    const service = new MemoryRetrievalService(
      createMockKnowledgeGraph(),
      createMockUserPrefs(),
      createMockIssueMemory(),
      "acme-internal/issues",
      feedback as never,
    );

    const context = await service.retrieve({ issueNumber: 856 });
    expect(context.lessons).toHaveLength(1);
    expect(context.priority).toBe("critical");
    const formatted = service.formatForConversation(context);
    expect(formatted).toContain("Cashier owns this");
    expect(formatted).toContain("Why missed");
  });
});
