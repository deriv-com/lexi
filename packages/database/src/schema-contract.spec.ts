import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Contract cover for the shared schema models.
 *
 * Several packages compile against these models, so a field that goes missing
 * or is renamed breaks code far from the change. This asserts the shared
 * surface directly against
 * `schema.prisma` rather than the generated client, so it fails on the source
 * of truth even before `prisma generate` has run.
 */

const SCHEMA = readFileSync(join(__dirname, "..", "prisma", "schema.prisma"), "utf8");

function modelBlock(name: string): string {
  const match = SCHEMA.match(new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, "m"));
  return match?.[1] ?? "";
}

function hasField(model: string, field: string, type: string): boolean {
  const block = modelBlock(model);
  return new RegExp(`^\\s*${field}\\s+${type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m").test(
    block,
  );
}

describe("frozen schema — models exist and are mapped", () => {
  const expectedMaps: Array<[string, string]> = [
    ["MemoryEpisode", "memory_episodes"],
    ["ThreadStateRecord", "thread_states"],
    ["KnowledgeChunk", "knowledge_chunks"],
    ["CostLedger", "cost_ledger"],
    ["WorkItem", "work_items"],
    ["SpecSession", "spec_sessions"],
    ["SpecDocument", "spec_documents"],
    ["SpecApproval", "spec_approvals"],
    ["EscalationLadderState", "escalation_ladder_state"],
    ["PersonDirectory", "person_directory"],
  ];

  it.each(expectedMaps)("declares model %s mapped to %s", (model, table) => {
    const block = modelBlock(model);
    expect(block, `model ${model} is missing from schema.prisma`).not.toBe("");
    expect(block).toContain(`@@map("${table}")`);
  });

  it.each(expectedMaps)("gives %s a uuid primary key", (model) => {
    expect(hasField(model, "id", "String   @id @default(uuid())")).toBe(true);
  });
});

describe("frozen schema — memory models", () => {
  it("MemoryEpisode carries scope, visibility subject and provenance", () => {
    expect(hasField("MemoryEpisode", "scope", "String")).toBe(true);
    expect(hasField("MemoryEpisode", "subjectUserId", "String?")).toBe(true);
    expect(hasField("MemoryEpisode", "kind", "String")).toBe(true);
    expect(hasField("MemoryEpisode", "threadKey", "String?")).toBe(true);
    expect(hasField("MemoryEpisode", "entityType", "String?")).toBe(true);
    expect(hasField("MemoryEpisode", "entityId", "String?")).toBe(true);
    expect(hasField("MemoryEpisode", "content", "String")).toBe(true);
    expect(hasField("MemoryEpisode", "importance", "Float")).toBe(true);
    expect(hasField("MemoryEpisode", "confidence", "Float")).toBe(true);
    expect(hasField("MemoryEpisode", "provenance", "Json")).toBe(true);
    expect(hasField("MemoryEpisode", "expiresAt", "DateTime?")).toBe(true);
  });

  it("MemoryEpisode indexes the visibility and recall access paths", () => {
    const block = modelBlock("MemoryEpisode");
    expect(block).toContain("@@index([scope, subjectUserId])");
    expect(block).toContain("@@index([threadKey])");
    expect(block).toContain("@@index([entityType, entityId])");
  });

  it("ThreadStateRecord is keyed uniquely by threadKey", () => {
    expect(hasField("ThreadStateRecord", "threadKey", "String   @unique")).toBe(true);
    expect(hasField("ThreadStateRecord", "state", "Json")).toBe(true);
    expect(hasField("ThreadStateRecord", "tokenCost", "Int")).toBe(true);
  });

  it("KnowledgeChunk dedupes by content hash for L6 caching", () => {
    const block = modelBlock("KnowledgeChunk");
    expect(hasField("KnowledgeChunk", "sourceType", "String")).toBe(true);
    expect(hasField("KnowledgeChunk", "sourceRef", "String")).toBe(true);
    expect(hasField("KnowledgeChunk", "repo", "String?")).toBe(true);
    expect(hasField("KnowledgeChunk", "contentHash", "String")).toBe(true);
    expect(block).toContain("@@unique([sourceType, sourceRef, contentHash])");
    expect(block).toContain("@@index([repo])");
  });
});

describe("frozen schema — cost ledger", () => {
  it("records the per-turn spend fields the ledger reports on", () => {
    expect(hasField("CostLedger", "threadKey", "String?")).toBe(true);
    expect(hasField("CostLedger", "userId", "String?")).toBe(true);
    expect(hasField("CostLedger", "model", "String")).toBe(true);
    expect(hasField("CostLedger", "intentClass", "String?")).toBe(true);
    expect(hasField("CostLedger", "inputTokens", "Int")).toBe(true);
    expect(hasField("CostLedger", "cachedInputTokens", "Int")).toBe(true);
    expect(hasField("CostLedger", "outputTokens", "Int")).toBe(true);
    expect(hasField("CostLedger", "toolCount", "Int")).toBe(true);
    expect(hasField("CostLedger", "estimatedCostUsd", "Float")).toBe(true);
  });

  it("indexes the three ledger query paths", () => {
    const block = modelBlock("CostLedger");
    expect(block).toContain("@@index([createdAt])");
    expect(block).toContain("@@index([threadKey])");
    expect(block).toContain("@@index([userId, createdAt])");
  });
});

describe("frozen schema — work items carry two repo keys", () => {
  it("separates the repo the code lands in from the repo the issue lives in", () => {
    expect(hasField("WorkItem", "codeRepoKey", "String?")).toBe(true);
    expect(hasField("WorkItem", "trackingRepoKey", "String?")).toBe(true);
  });

  it("models epic -> task as a self-relation", () => {
    const block = modelBlock("WorkItem");
    expect(hasField("WorkItem", "parentId", "String?")).toBe(true);
    expect(block).toContain(
      'parent         WorkItem?  @relation("work_item_parent", fields: [parentId], references: [id])',
    );
    expect(block).toContain('children       WorkItem[] @relation("work_item_parent")');
  });

  it("carries lifecycle, assignment and board linkage", () => {
    expect(hasField("WorkItem", "kind", "String")).toBe(true);
    expect(hasField("WorkItem", "status", "String")).toBe(true);
    expect(hasField("WorkItem", "issueNumber", "Int?")).toBe(true);
    expect(hasField("WorkItem", "specId", "String?")).toBe(true);
    expect(hasField("WorkItem", "boardItemId", "String?")).toBe(true);
    expect(hasField("WorkItem", "assigneeGithub", "String?")).toBe(true);
    expect(hasField("WorkItem", "assigneeSlack", "String?")).toBe(true);
  });
});

describe("frozen schema — spec pipeline", () => {
  it("SpecSession is indexed by thread and holds machine-readable coverage", () => {
    // Indexed, NOT unique. Superseding an approved spec keeps the successor in
    // the same Slack thread, so a thread accumulates one row per generation and
    // the service selects the newest non-superseded one. Prisma cannot express
    // the partial unique index that would pin "one ACTIVE session per thread",
    // so that invariant lives in the service layer, not here.
    // Migration: 20260826120000_spec_successor_same_thread.
    const specSession = modelBlock("SpecSession");
    expect(hasField("SpecSession", "threadKey", "String")).toBe(true);
    expect(specSession).not.toContain("threadKey     String   @unique");
    expect(specSession).toContain("@@index([threadKey])");
    expect(hasField("SpecSession", "requestedBy", "String")).toBe(true);
    expect(hasField("SpecSession", "targetRepoKey", "String?")).toBe(true);
    expect(hasField("SpecSession", "coverage", "Json")).toBe(true);
    expect(hasField("SpecSession", "questionTurns", "Int")).toBe(true);
  });

  it("SpecDocument records tracking vs code repo and a hash per revision", () => {
    expect(hasField("SpecDocument", "trackingRepoKey", "String")).toBe(true);
    expect(hasField("SpecDocument", "codeRepoKey", "String?")).toBe(true);
    expect(hasField("SpecDocument", "revision", "Int")).toBe(true);
    expect(hasField("SpecDocument", "contentHash", "String")).toBe(true);
    expect(hasField("SpecDocument", "supersededById", "String?")).toBe(true);
    expect(modelBlock("SpecDocument")).toContain("@@index([sessionId])");
  });

  it("SpecApproval records who acted and how", () => {
    expect(hasField("SpecApproval", "specId", "String")).toBe(true);
    expect(hasField("SpecApproval", "actorSlackId", "String")).toBe(true);
    expect(hasField("SpecApproval", "action", "String")).toBe(true);
    expect(modelBlock("SpecApproval")).toContain("@@index([specId])");
  });
});

describe("frozen schema — escalation", () => {
  it("EscalationLadderState is unique per subject and tracks acks", () => {
    expect(hasField("EscalationLadderState", "subjectType", "String")).toBe(true);
    expect(hasField("EscalationLadderState", "rung", "String")).toBe(true);
    expect(hasField("EscalationLadderState", "lastNotifiedAt", "DateTime")).toBe(true);
    expect(hasField("EscalationLadderState", "ackedAt", "DateTime?")).toBe(true);
    expect(hasField("EscalationLadderState", "ackedBy", "String?")).toBe(true);
    expect(hasField("EscalationLadderState", "notifyCount", "Int")).toBe(true);
    expect(modelBlock("EscalationLadderState")).toContain(
      "@@unique([subjectType, subjectId])",
    );
  });

  it("PersonDirectory retains managerGithub even though the rung is deferred", () => {
    expect(hasField("PersonDirectory", "githubLogin", "String   @unique")).toBe(true);
    expect(hasField("PersonDirectory", "slackId", "String?")).toBe(true);
    expect(hasField("PersonDirectory", "managerGithub", "String?")).toBe(true);
    expect(hasField("PersonDirectory", "teams", "String[]")).toBe(true);
    expect(hasField("PersonDirectory", "source", "String")).toBe(true);
  });
});

describe("frozen schema — additions to existing models", () => {
  it("QuickFixAttempt links back to spec and work item", () => {
    expect(hasField("QuickFixAttempt", "specId", "String?")).toBe(true);
    expect(hasField("QuickFixAttempt", "workItemId", "String?")).toBe(true);
  });

  it("AuditLog gains an indexed threadKey column", () => {
    expect(hasField("AuditLog", "threadKey", "String?")).toBe(true);
    expect(modelBlock("AuditLog")).toContain("@@index([threadKey])");
  });
});
