import { randomUUID } from "node:crypto";
import type {
  EngineeringKnowledgeNode,
  EngineeringKnowledgeEdge,
  IssueKnowledgeChain,
} from "./memory.types";

/**
 * Minimal Prisma port for the knowledge graph.
 * Keeps the memory package decoupled from full PrismaClient.
 */
export interface KnowledgeGraphStore {
  knowledgeNode: {
    upsert(args: {
      where: { type_externalId_repo: { type: string; externalId: string; repo: string } };
      create: { id: string; type: string; externalId: string; repo: string; title?: string; metadata: object; updatedAt: Date };
      update: { title?: string; metadata: object; updatedAt: Date };
    }): Promise<{ id: string }>;
    findMany(args: { where: { type?: string; repo?: string; externalId?: string } }): Promise<Array<{ id: string; type: string; externalId: string | null; repo: string | null; title: string | null; metadata: unknown; createdAt: Date; updatedAt: Date }>>;
    findFirst(args: { where: { type: string; externalId: string; repo?: string } }): Promise<{ id: string; title: string | null; metadata: unknown } | null>;
    findUnique(args: { where: { id: string } }): Promise<{
      id: string;
      type: string;
      externalId: string | null;
      repo: string | null;
      title: string | null;
      metadata: unknown;
    } | null>;
  };
  knowledgeEdge: {
    create(args: { data: { id: string; fromNodeId: string; toNodeId: string; relationship: string; confidence: number; metadata: object } }): Promise<{ id: string }>;
    findMany(args: { where: { fromNodeId?: string; toNodeId?: string; relationship?: string } }): Promise<Array<{ id: string; fromNodeId: string; toNodeId: string; relationship: string; confidence: number; metadata: unknown; createdAt: Date }>>;
    findFirst(args: {
      where: { fromNodeId: string; toNodeId: string; relationship: string };
    }): Promise<{ id: string } | null>;
    deleteMany(args: { where: { fromNodeId: string; toNodeId: string; relationship: string } }): Promise<{ count: number }>;
  };
}

/**
 * Engineering Knowledge Graph service.
 *
 * Builds and queries a graph of engineering relationships:
 *   issue → PR → commit → release → regression → owner
 *
 * The graph is append-only (edges are added, rarely removed) and supports:
 * - Recording that a PR fixed an issue
 * - Recording that a release included a fix
 * - Recording regressions (new issue caused by a previous fix)
 * - Querying the full knowledge chain for an issue
 * - Finding related issues through transitive relationships
 */
export class EngineeringKnowledgeGraphService {
  constructor(private readonly store: KnowledgeGraphStore) {}

  // ---- Node management ----

  async upsertNode(
    type: string,
    externalId: string,
    repo: string,
    title?: string,
    metadata: Record<string, unknown> = {},
  ): Promise<string> {
    const result = await this.store.knowledgeNode.upsert({
      where: { type_externalId_repo: { type, externalId, repo } },
      create: { id: randomUUID(), type, externalId, repo, title, metadata, updatedAt: new Date() },
      update: { title, metadata, updatedAt: new Date() },
    });
    return result.id;
  }

  async findNode(type: string, externalId: string, repo?: string): Promise<{ id: string; title: string | null; metadata: unknown } | null> {
    return this.store.knowledgeNode.findFirst({ where: { type, externalId, repo } });
  }

  // ---- Edge management ----

  async addEdge(
    fromNodeId: string,
    toNodeId: string,
    relationship: string,
    confidence = 1.0,
    metadata: Record<string, unknown> = {},
  ): Promise<string> {
    const existing = await this.store.knowledgeEdge.findFirst({
      where: { fromNodeId, toNodeId, relationship },
    });
    if (existing) return existing.id;

    const id = randomUUID();
    await this.store.knowledgeEdge.create({
      data: { id, fromNodeId, toNodeId, relationship, confidence, metadata },
    });
    return id;
  }

  async removeEdge(fromNodeId: string, toNodeId: string, relationship: string): Promise<void> {
    await this.store.knowledgeEdge.deleteMany({ where: { fromNodeId, toNodeId, relationship } });
  }

  // ---- High-level recording operations ----

  /**
   * Record that a PR fixed an issue.
   * Creates nodes for both if they don't exist, then adds a fixed_by edge.
   */
  async recordFix(
    issueNumber: number,
    issueRepo: string,
    prNumber: number,
    prRepo: string,
    prTitle?: string,
    author?: string,
    mergedAt?: string,
  ): Promise<void> {
    const issueNodeId = await this.upsertNode("issue", String(issueNumber), issueRepo);
    const prNodeId = await this.upsertNode("pull_request", String(prNumber), prRepo, prTitle, { author, mergedAt });

    await this.addEdge(issueNodeId, prNodeId, "fixed_by", 0.9, { author, mergedAt });

    // Also record engineer as owner of the fix
    if (author) {
      const engineerNodeId = await this.upsertNode("engineer", author, prRepo, author);
      await this.addEdge(prNodeId, engineerNodeId, "owned_by", 1.0, { role: "fixer" });
    }
  }

  /**
   * Record that a PR was included in a release.
   */
  async recordRelease(
    prNumber: number,
    prRepo: string,
    releaseVersion: string,
    releasedAt?: string,
  ): Promise<void> {
    const prNodeId = await this.upsertNode("pull_request", String(prNumber), prRepo);
    const releaseNodeId = await this.upsertNode("release", releaseVersion, prRepo, `Release ${releaseVersion}`, { releasedAt });

    await this.addEdge(prNodeId, releaseNodeId, "released_in", 1.0, { releasedAt });
  }

  /**
   * Record a regression: new issue was caused by a previous fix.
   */
  async recordRegression(
    newIssueNumber: number,
    newIssueRepo: string,
    originalIssueNumber: number,
    originalIssueRepo: string,
    causedByPR?: number,
    causedByRelease?: string,
  ): Promise<void> {
    const newNodeId = await this.upsertNode("issue", String(newIssueNumber), newIssueRepo);
    const originalNodeId = await this.upsertNode("issue", String(originalIssueNumber), originalIssueRepo);

    await this.addEdge(newNodeId, originalNodeId, "regressed_from", 0.8, { causedByPR, causedByRelease });

    if (causedByPR) {
      const prNodeId = await this.upsertNode("pull_request", String(causedByPR), originalIssueRepo);
      await this.addEdge(newNodeId, prNodeId, "introduced_by", 0.7, { causedByRelease });
    }
  }

  /**
   * Record a relationship between two issues.
   */
  async recordRelation(
    issueNumber: number,
    issueRepo: string,
    relatedNumber: number,
    relatedRepo: string,
    relationship: "related_to" | "duplicate_of" | "blocked_by",
    confidence = 0.8,
  ): Promise<void> {
    const nodeA = await this.upsertNode("issue", String(issueNumber), issueRepo);
    const nodeB = await this.upsertNode("issue", String(relatedNumber), relatedRepo);
    await this.addEdge(nodeA, nodeB, relationship, confidence);
  }

  // ---- Query operations ----

  /**
   * Get the full knowledge chain for an issue:
   * fixes, regressions, related issues, releases, owners.
   */
  async getIssueKnowledgeChain(issueNumber: number, repo: string): Promise<IssueKnowledgeChain | null> {
    const issueNode = await this.findNode("issue", String(issueNumber), repo);
    if (!issueNode) return null;

    const outEdges = await this.store.knowledgeEdge.findMany({ where: { fromNodeId: issueNode.id } });
    const inEdges = await this.store.knowledgeEdge.findMany({ where: { toNodeId: issueNode.id } });

    const fixes: IssueKnowledgeChain["fixes"] = [];
    const regressions: IssueKnowledgeChain["regressions"] = [];
    const relatedIssues: IssueKnowledgeChain["relatedIssues"] = [];
    const releases: IssueKnowledgeChain["releases"] = [];
    const owners: IssueKnowledgeChain["owners"] = [];

    // Process outgoing edges (issue → X)
    for (const edge of outEdges) {
      const meta = edge.metadata as Record<string, unknown>;

      if (edge.relationship === "fixed_by") {
        const prTarget = await this.loadNode(edge.toNodeId);
        if (prTarget) {
          fixes.push({
            prNumber: Number(prTarget.externalId),
            prRepo: prTarget.repo ?? repo,
            mergedAt: meta.mergedAt as string | undefined,
            author: meta.author as string | undefined,
          });

          const prReleaseEdges = await this.store.knowledgeEdge.findMany({ where: { fromNodeId: prTarget.id, relationship: "released_in" } });
          for (const relEdge of prReleaseEdges) {
            const releaseNode = await this.loadNode(relEdge.toNodeId);
            if (releaseNode) {
              const relMeta = relEdge.metadata as Record<string, unknown>;
              releases.push({
                version: releaseNode.externalId ?? "unknown",
                releasedAt: relMeta.releasedAt as string | undefined,
                includesFix: true,
              });
            }
          }

          const ownerEdges = await this.store.knowledgeEdge.findMany({ where: { fromNodeId: prTarget.id, relationship: "owned_by" } });
          for (const ownerEdge of ownerEdges) {
            const eng = await this.loadNode(ownerEdge.toNodeId);
            if (eng) {
              const ownerMeta = ownerEdge.metadata as Record<string, unknown>;
              owners.push({ login: eng.externalId ?? "", role: (ownerMeta.role as string) ?? "fixer" });
            }
          }
        }
      }

      if (edge.relationship === "regressed_from") {
        const origIssue = await this.loadNode(edge.toNodeId);
        if (origIssue) {
          regressions.push({
            fromIssueNumber: Number(origIssue.externalId),
            originalFixPR: meta.causedByPR as number | undefined,
            regressionRelease: meta.causedByRelease as string | undefined,
          });
        }
      }

      if (edge.relationship === "related_to" || edge.relationship === "duplicate_of" || edge.relationship === "blocked_by") {
        const relIssue = await this.loadNode(edge.toNodeId);
        if (relIssue) {
          relatedIssues.push({
            number: Number(relIssue.externalId),
            relationship: edge.relationship,
            title: relIssue.title ?? undefined,
          });
        }
      }
    }

    for (const edge of inEdges) {
      if (edge.relationship === "regressed_from") {
        const regIssue = await this.loadNode(edge.fromNodeId);
        if (regIssue) {
          relatedIssues.push({
            number: Number(regIssue.externalId),
            relationship: "regression_of_this",
            title: regIssue.title ?? undefined,
          });
        }
      }
    }

    return {
      issueNumber,
      repo,
      fixes,
      regressions,
      relatedIssues,
      releases,
      owners,
    };
  }

  /**
   * Find all issues related to a component or engineer.
   */
  async findByEngineer(login: string): Promise<Array<{ issueNumber: number; repo: string; relationship: string }>> {
    const engineerNode = await this.findNode("engineer", login);
    if (!engineerNode) return [];

    // Find all PRs owned by this engineer
    const ownerEdges = await this.store.knowledgeEdge.findMany({ where: { toNodeId: engineerNode.id, relationship: "owned_by" } });
    const results: Array<{ issueNumber: number; repo: string; relationship: string }> = [];

    for (const edge of ownerEdges) {
      // Find issues fixed by this PR
      const fixEdges = await this.store.knowledgeEdge.findMany({ where: { toNodeId: edge.fromNodeId, relationship: "fixed_by" } });
      for (const fixEdge of fixEdges) {
        const issueNode = await this.loadNode(fixEdge.fromNodeId);
        if (issueNode) {
          results.push({ issueNumber: Number(issueNode.externalId), repo: issueNode.repo ?? "", relationship: "fixed" });
        }
      }
    }

    return results;
  }

  /**
   * Build a natural-language history summary for an issue.
   */
  async buildHistorySummary(issueNumber: number, repo: string): Promise<string | null> {
    const chain = await this.getIssueKnowledgeChain(issueNumber, repo);
    if (!chain) return null;

    const parts: string[] = [];

    if (chain.fixes.length > 0) {
      for (const fix of chain.fixes) {
        const who = fix.author ? ` by ${fix.author}` : "";
        const when = fix.mergedAt ? ` (merged ${fix.mergedAt})` : "";
        parts.push(`Fixed in ${fix.prRepo}#${fix.prNumber}${who}${when}.`);
      }
    }

    if (chain.releases.length > 0) {
      for (const rel of chain.releases) {
        parts.push(`Included in release ${rel.version}${rel.releasedAt ? ` (${rel.releasedAt})` : ""}.`);
      }
    }

    if (chain.regressions.length > 0) {
      for (const reg of chain.regressions) {
        parts.push(`This is a regression of #${reg.fromIssueNumber}${reg.regressionRelease ? ` introduced in ${reg.regressionRelease}` : ""}.`);
      }
    }

    if (chain.relatedIssues.length > 0) {
      const related = chain.relatedIssues.map((r) => `#${r.number} (${r.relationship})`).join(", ");
      parts.push(`Related: ${related}.`);
    }

    return parts.length > 0 ? parts.join(" ") : null;
  }

  private async loadNode(id: string): Promise<{
    id: string;
    type: string;
    externalId: string | null;
    repo: string | null;
    title: string | null;
    metadata: unknown;
  } | null> {
    return this.store.knowledgeNode.findUnique({ where: { id } });
  }
}
