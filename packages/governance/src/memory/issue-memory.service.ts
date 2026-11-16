import { randomUUID } from "node:crypto";
import type { IssueMemoryEntry, IssueFact, InvestigationSummary, RegressionChainEntry } from "./memory.types";

/**
 * Minimal Prisma port for issue memory.
 */
export interface IssueMemoryStore {
  issueMemory: {
    upsert(args: {
      where: { issueNumber_repo: { issueNumber: number; repo: string } };
      create: { id: string; issueNumber: number; repo: string; summary: string; facts: object; investigations: object; regressionChain?: object; processCount: number; lastUpdatedAt: Date };
      update: Partial<{ summary: string; facts: object; investigations: object; regressionChain: object; processCount: number; lastUpdatedAt: Date }>;
    }): Promise<any>;
    findUnique(args: { where: { issueNumber_repo: { issueNumber: number; repo: string } } }): Promise<any | null>;
    findMany(args?: { where?: { repo?: string }; orderBy?: { lastUpdatedAt: "desc" }; take?: number }): Promise<any[]>;
  };
}

const MAX_INVESTIGATIONS = 20; // Keep last 20 investigations per issue
const MAX_FACTS = 50;          // Keep most important 50 facts per issue

/**
 * Issue Memory service.
 *
 * Maintains rolling compressed summaries of issue history:
 * - Past investigations and their outcomes
 * - Key facts extracted from each processing pass
 * - Regression chains
 * - Process count
 *
 * This is NOT the raw event log — it's a compressed, queryable memory
 * that lets Lexi say "we've investigated this 3 times, the last attempt
 * found it was fixed in v2.5.1 but the regression returned in v2.6.0."
 */
export class IssueMemoryService {
  constructor(private readonly store: IssueMemoryStore) {}

  /**
   * Get memory for an issue. Returns null if no memory exists.
   */
  async getMemory(issueNumber: number, repo: string): Promise<IssueMemoryEntry | null> {
    const record = await this.store.issueMemory.findUnique({
      where: { issueNumber_repo: { issueNumber, repo } },
    });
    if (!record) return null;
    return this.toEntry(record);
  }

  /**
   * Record an investigation outcome. Appends to the investigation history
   * and updates the summary/facts.
   */
  async recordInvestigation(
    issueNumber: number,
    repo: string,
    investigation: InvestigationSummary,
    newFacts: IssueFact[] = [],
    summaryUpdate?: string,
  ): Promise<IssueMemoryEntry> {
    const existing = await this.getMemory(issueNumber, repo);

    // Merge facts (deduplicate by key, keep highest confidence)
    const allFacts = [...(existing?.facts ?? []), ...newFacts];
    const factMap = new Map<string, IssueFact>();
    for (const fact of allFacts) {
      const existing = factMap.get(fact.key);
      if (!existing || fact.confidence > existing.confidence) {
        factMap.set(fact.key, fact);
      }
    }
    const mergedFacts = [...factMap.values()]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_FACTS);

    // Append investigation (keep most recent MAX_INVESTIGATIONS)
    const investigations = [...(existing?.investigations ?? []), investigation].slice(-MAX_INVESTIGATIONS);

    // Update process count
    const processCount = (existing?.processCount ?? 0) + 1;

    // Build or update summary
    const summary = summaryUpdate ?? this.buildSummary(issueNumber, investigations, mergedFacts);

    const result = await this.store.issueMemory.upsert({
      where: { issueNumber_repo: { issueNumber, repo } },
      create: {
        id: randomUUID(),
        issueNumber,
        repo,
        summary,
        facts: mergedFacts as unknown as object,
        investigations: investigations as unknown as object,
        regressionChain: existing?.regressionChain as unknown as object | undefined,
        processCount,
        lastUpdatedAt: new Date(),
      },
      update: {
        summary,
        facts: mergedFacts as unknown as object,
        investigations: investigations as unknown as object,
        processCount,
        lastUpdatedAt: new Date(),
      },
    });

    return this.toEntry(result);
  }

  /**
   * Record a regression chain for an issue.
   */
  async recordRegressionChain(
    issueNumber: number,
    repo: string,
    chain: RegressionChainEntry[],
  ): Promise<void> {
    const existing = await this.getMemory(issueNumber, repo);
    await this.store.issueMemory.upsert({
      where: { issueNumber_repo: { issueNumber, repo } },
      create: {
        id: randomUUID(),
        issueNumber,
        repo,
        summary: existing?.summary ?? "",
        facts: (existing?.facts ?? []) as unknown as object,
        investigations: (existing?.investigations ?? []) as unknown as object,
        regressionChain: chain as unknown as object,
        processCount: existing?.processCount ?? 0,
        lastUpdatedAt: new Date(),
      },
      update: {
        regressionChain: chain as unknown as object,
        lastUpdatedAt: new Date(),
      },
    });
  }

  /**
   * Get recent memories across all issues (for dashboard/overview).
   */
  async getRecentMemories(repo: string, limit = 10): Promise<IssueMemoryEntry[]> {
    const records = await this.store.issueMemory.findMany({
      where: { repo },
      orderBy: { lastUpdatedAt: "desc" },
      take: limit,
    });
    return records.map((r: any) => this.toEntry(r));
  }

  /**
   * Build a natural-language summary from investigations and facts.
   */
  private buildSummary(issueNumber: number, investigations: InvestigationSummary[], facts: IssueFact[]): string {
    const parts: string[] = [];

    parts.push(`Issue #${issueNumber}: processed ${investigations.length} time(s).`);

    // Latest investigation
    if (investigations.length > 0) {
      const latest = investigations[investigations.length - 1];
      parts.push(`Last investigation (${latest.trigger}): ${latest.outcome}.`);
      if (latest.insight) parts.push(latest.insight);
    }

    // Key high-confidence facts
    const keyFacts = facts.filter((f) => f.confidence >= 0.7).slice(0, 5);
    if (keyFacts.length > 0) {
      parts.push(`Key facts: ${keyFacts.map((f) => `${f.key}=${f.value}`).join(", ")}.`);
    }

    return parts.join(" ");
  }

  private toEntry(record: any): IssueMemoryEntry {
    return {
      id: record.id,
      issueNumber: record.issueNumber,
      repo: record.repo,
      summary: record.summary ?? "",
      facts: (record.facts as IssueFact[]) ?? [],
      regressionChain: (record.regressionChain as RegressionChainEntry[]) ?? undefined,
      investigations: (record.investigations as InvestigationSummary[]) ?? [],
      processCount: record.processCount ?? 0,
      lastUpdatedAt: record.lastUpdatedAt ?? new Date(),
      expiresAt: record.expiresAt ?? undefined,
    };
  }
}
