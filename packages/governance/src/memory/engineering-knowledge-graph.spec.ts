import { describe, it, expect, vi } from "vitest";
import { EngineeringKnowledgeGraphService, type KnowledgeGraphStore } from "./engineering-knowledge-graph.service";

function createInMemoryStore(): KnowledgeGraphStore {
  const nodes = new Map<string, any>();
  const edges = new Map<string, any>();

  return {
    knowledgeNode: {
      upsert: vi.fn(async ({ where, create, update }) => {
        const key = `${where.type_externalId_repo.type}:${where.type_externalId_repo.externalId}:${where.type_externalId_repo.repo}`;
        const existing = [...nodes.values()].find((n) => `${n.type}:${n.externalId}:${n.repo}` === key);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const node = { ...create, createdAt: new Date() };
        nodes.set(node.id, node);
        return node;
      }),
      findMany: vi.fn(async ({ where }) => {
        return [...nodes.values()].filter((n) => {
          if (where.type && n.type !== where.type) return false;
          if (where.repo && n.repo !== where.repo) return false;
          if (where.externalId && n.externalId !== where.externalId) return false;
          return true;
        });
      }),
      findFirst: vi.fn(async ({ where }) => {
        return [...nodes.values()].find((n) => {
          if (n.type !== where.type) return false;
          if (where.externalId && n.externalId !== where.externalId) return false;
          if (where.repo && n.repo !== where.repo) return false;
          return true;
        }) ?? null;
      }),
      findUnique: vi.fn(async ({ where }) => nodes.get(where.id) ?? null),
    },
    knowledgeEdge: {
      create: vi.fn(async ({ data }) => {
        edges.set(data.id, { ...data, createdAt: new Date() });
        return data;
      }),
      findFirst: vi.fn(async ({ where }) => {
        return [...edges.values()].find((e) =>
          e.fromNodeId === where.fromNodeId &&
          e.toNodeId === where.toNodeId &&
          e.relationship === where.relationship,
        ) ?? null;
      }),
      findMany: vi.fn(async ({ where }) => {
        return [...edges.values()].filter((e) => {
          if (where.fromNodeId && e.fromNodeId !== where.fromNodeId) return false;
          if (where.toNodeId && e.toNodeId !== where.toNodeId) return false;
          if (where.relationship && e.relationship !== where.relationship) return false;
          return true;
        });
      }),
      deleteMany: vi.fn(async ({ where }) => {
        let count = 0;
        for (const [id, e] of edges) {
          if (e.fromNodeId === where.fromNodeId && e.toNodeId === where.toNodeId && e.relationship === where.relationship) {
            edges.delete(id);
            count++;
          }
        }
        return { count };
      }),
    },
  };
}

describe("EngineeringKnowledgeGraphService", () => {
  it("records a fix and retrieves it in the knowledge chain", async () => {
    const store = createInMemoryStore();
    const service = new EngineeringKnowledgeGraphService(store);

    await service.recordFix(856, "acme-internal/issues", 42, "acme/web-app", "Fix cashier crash", "bob", "2026-07-20");

    const chain = await service.getIssueKnowledgeChain(856, "acme-internal/issues");
    expect(chain).not.toBeNull();
    expect(chain!.fixes).toHaveLength(1);
    expect(chain!.fixes[0].prNumber).toBe(42);
    expect(chain!.fixes[0].author).toBe("bob");
    expect(chain!.owners).toHaveLength(1);
    expect(chain!.owners[0].login).toBe("bob");
    expect(chain!.owners[0].role).toBe("fixer");
  });

  it("records a release and links it to the fix", async () => {
    const store = createInMemoryStore();
    const service = new EngineeringKnowledgeGraphService(store);

    await service.recordFix(856, "acme-internal/issues", 42, "acme/web-app", "Fix cashier");
    await service.recordRelease(42, "acme/web-app", "v2.5.1", "2026-07-25");

    const chain = await service.getIssueKnowledgeChain(856, "acme-internal/issues");
    expect(chain!.releases).toHaveLength(1);
    expect(chain!.releases[0].version).toBe("v2.5.1");
    expect(chain!.releases[0].includesFix).toBe(true);
  });

  it("records a regression chain", async () => {
    const store = createInMemoryStore();
    const service = new EngineeringKnowledgeGraphService(store);

    await service.recordRegression(910, "acme-internal/issues", 856, "acme-internal/issues", 42, "v2.5.1");

    const chain = await service.getIssueKnowledgeChain(910, "acme-internal/issues");
    expect(chain!.regressions).toHaveLength(1);
    expect(chain!.regressions[0].fromIssueNumber).toBe(856);
    expect(chain!.regressions[0].originalFixPR).toBe(42);
    expect(chain!.regressions[0].regressionRelease).toBe("v2.5.1");
  });

  it("records related issues", async () => {
    const store = createInMemoryStore();
    const service = new EngineeringKnowledgeGraphService(store);

    await service.recordRelation(856, "acme-internal/issues", 900, "acme-internal/issues", "related_to");
    await service.recordRelation(856, "acme-internal/issues", 850, "acme-internal/issues", "duplicate_of");

    const chain = await service.getIssueKnowledgeChain(856, "acme-internal/issues");
    expect(chain!.relatedIssues).toHaveLength(2);
    expect(chain!.relatedIssues.find((r) => r.number === 900)?.relationship).toBe("related_to");
    expect(chain!.relatedIssues.find((r) => r.number === 850)?.relationship).toBe("duplicate_of");
  });

  it("returns null for unknown issues", async () => {
    const store = createInMemoryStore();
    const service = new EngineeringKnowledgeGraphService(store);

    const chain = await service.getIssueKnowledgeChain(9999, "unknown/repo");
    expect(chain).toBeNull();
  });

  it("builds a natural language history summary", async () => {
    const store = createInMemoryStore();
    const service = new EngineeringKnowledgeGraphService(store);

    await service.recordFix(856, "acme-internal/issues", 42, "acme/web-app", "Fix cashier", "bob", "2026-07-20");
    await service.recordRelease(42, "acme/web-app", "v2.5.1", "2026-07-25");

    const summary = await service.buildHistorySummary(856, "acme-internal/issues");
    expect(summary).toContain("Fixed in");
    expect(summary).toContain("#42");
    expect(summary).toContain("bob");
    expect(summary).toContain("v2.5.1");
  });

  it("findByEngineer returns issues they fixed", async () => {
    const store = createInMemoryStore();
    const service = new EngineeringKnowledgeGraphService(store);

    await service.recordFix(856, "acme-internal/issues", 42, "acme/web-app", "Fix cashier", "bob");
    await service.recordFix(900, "acme-internal/issues", 55, "acme/web-app", "Fix options", "bob");

    const results = await service.findByEngineer("bob");
    expect(results.length).toBe(2);
    expect(results.map((r) => r.issueNumber).sort()).toEqual([856, 900]);
  });

  it("upsert is idempotent — recording the same fix twice doesn't duplicate", async () => {
    const store = createInMemoryStore();
    const service = new EngineeringKnowledgeGraphService(store);

    await service.recordFix(856, "acme-internal/issues", 42, "acme/web-app", "Fix cashier", "bob");
    await service.recordFix(856, "acme-internal/issues", 42, "acme/web-app", "Fix cashier v2", "bob");

    // Nodes are upserted (not duplicated)
    const issueNodes = await store.knowledgeNode.findMany({ where: { type: "issue", externalId: "856" } });
    expect(issueNodes).toHaveLength(1);

    const chain = await service.getIssueKnowledgeChain(856, "acme-internal/issues");
    expect(chain!.fixes).toHaveLength(1);
  });
});
