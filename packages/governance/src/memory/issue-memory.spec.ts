import { describe, it, expect, vi } from "vitest";
import { IssueMemoryService, type IssueMemoryStore } from "./issue-memory.service";
import type { InvestigationSummary, IssueFact } from "./memory.types";

function createInMemoryStore(): IssueMemoryStore {
  const records = new Map<string, any>();
  return {
    issueMemory: {
      upsert: vi.fn(async ({ where, create, update }) => {
        const key = `${where.issueNumber_repo.issueNumber}:${where.issueNumber_repo.repo}`;
        const existing = records.get(key);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        records.set(key, { ...create, createdAt: new Date() });
        return records.get(key);
      }),
      findUnique: vi.fn(async ({ where }) => {
        const key = `${where.issueNumber_repo.issueNumber}:${where.issueNumber_repo.repo}`;
        return records.get(key) ?? null;
      }),
      findMany: vi.fn(async ({ where, take } = {} as any) => {
        let results = [...records.values()];
        if (where?.repo) results = results.filter((r) => r.repo === where.repo);
        results.sort((a, b) => (b.lastUpdatedAt?.getTime() ?? 0) - (a.lastUpdatedAt?.getTime() ?? 0));
        if (take) results = results.slice(0, take);
        return results;
      }),
    },
  };
}

describe("IssueMemoryService", () => {
  it("returns null for unknown issue", async () => {
    const store = createInMemoryStore();
    const service = new IssueMemoryService(store);

    const memory = await service.getMemory(9999, "test/repo");
    expect(memory).toBeNull();
  });

  it("records an investigation and builds summary", async () => {
    const store = createInMemoryStore();
    const service = new IssueMemoryService(store);

    const investigation: InvestigationSummary = {
      timestamp: new Date(),
      trigger: "initial",
      outcome: "VERIFIED at 0.91 confidence",
      evidenceQuality: "strong",
      reproductionAttempted: true,
      reproductionResult: "reproduced",
      fixStatus: "NO_FIX_EVIDENCE",
      insight: "Bug confirmed in cashier withdrawal flow.",
    };

    const facts: IssueFact[] = [
      { key: "root_cause", value: "null reference in withdrawal handler", confidence: 0.85, source: "bre", observedAt: new Date() },
      { key: "component", value: "cashier", confidence: 0.95, source: "claude", observedAt: new Date() },
    ];

    const memory = await service.recordInvestigation(856, "acme-internal/issues", investigation, facts);

    expect(memory.issueNumber).toBe(856);
    expect(memory.processCount).toBe(1);
    expect(memory.investigations).toHaveLength(1);
    expect(memory.facts).toHaveLength(2);
    expect(memory.summary).toContain("#856");
    expect(memory.summary).toContain("VERIFIED");
  });

  it("accumulates investigations across multiple processing passes", async () => {
    const store = createInMemoryStore();
    const service = new IssueMemoryService(store);

    await service.recordInvestigation(856, "acme-internal/issues", {
      timestamp: new Date(Date.now() - 86400000),
      trigger: "initial",
      outcome: "NEEDS_MANUAL_INVESTIGATION",
      reproductionAttempted: true,
      reproductionResult: "could not reproduce",
    });

    await service.recordInvestigation(856, "acme-internal/issues", {
      timestamp: new Date(),
      trigger: "reprocess",
      outcome: "VERIFIED at 0.91",
      reproductionAttempted: true,
      reproductionResult: "reproduced",
      insight: "Fixed environment issue allowed reproduction.",
    });

    const memory = await service.getMemory(856, "acme-internal/issues");
    expect(memory!.processCount).toBe(2);
    expect(memory!.investigations).toHaveLength(2);
    expect(memory!.summary).toContain("2 time(s)");
  });

  it("deduplicates facts by key, keeping highest confidence", async () => {
    const store = createInMemoryStore();
    const service = new IssueMemoryService(store);

    await service.recordInvestigation(856, "acme-internal/issues",
      { timestamp: new Date(), trigger: "initial", outcome: "test", reproductionAttempted: false },
      [{ key: "component", value: "cashier", confidence: 0.6, source: "heuristic", observedAt: new Date() }],
    );

    await service.recordInvestigation(856, "acme-internal/issues",
      { timestamp: new Date(), trigger: "reprocess", outcome: "test2", reproductionAttempted: false },
      [{ key: "component", value: "cashier-v2", confidence: 0.9, source: "claude", observedAt: new Date() }],
    );

    const memory = await service.getMemory(856, "acme-internal/issues");
    const componentFact = memory!.facts.find((f) => f.key === "component");
    expect(componentFact!.value).toBe("cashier-v2"); // Higher confidence wins
    expect(componentFact!.confidence).toBe(0.9);
  });

  it("records regression chain", async () => {
    const store = createInMemoryStore();
    const service = new IssueMemoryService(store);

    await service.recordInvestigation(910, "acme-internal/issues",
      { timestamp: new Date(), trigger: "initial", outcome: "test", reproductionAttempted: false },
    );

    await service.recordRegressionChain(910, "acme-internal/issues", [
      { issueNumber: 856, fixPR: 42, fixRelease: "v2.5.1", regressedInRelease: "v2.6.0", engineer: "bob" },
    ]);

    const memory = await service.getMemory(910, "acme-internal/issues");
    expect(memory!.regressionChain).toHaveLength(1);
    expect(memory!.regressionChain![0].issueNumber).toBe(856);
    expect(memory!.regressionChain![0].regressedInRelease).toBe("v2.6.0");
  });

  it("getRecentMemories returns by most recently updated", async () => {
    const store = createInMemoryStore();
    const service = new IssueMemoryService(store);

    await service.recordInvestigation(100, "acme-internal/issues",
      { timestamp: new Date(Date.now() - 100000), trigger: "initial", outcome: "old", reproductionAttempted: false },
    );

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));

    await service.recordInvestigation(200, "acme-internal/issues",
      { timestamp: new Date(), trigger: "initial", outcome: "new", reproductionAttempted: false },
    );

    const recent = await service.getRecentMemories("acme-internal/issues", 5);
    expect(recent.length).toBe(2);
    // Most recent issue should be first (issue 200 was recorded last)
    expect(recent[0].issueNumber).toBe(200);
  });
});
