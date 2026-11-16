import { describe, expect, it, vi } from "vitest";
import { PrismaFeedbackPersistence, type FeedbackCorrectionPrisma } from "../agent-intelligence/prisma-feedback-persistence";
import type { FeedbackRecord } from "../agent-intelligence/feedback-learning.service";
import { createEngineeringMemoryBundle, type EngineeringMemoryPrisma } from "./prisma-memory-bundle";

/**
 * The engineering memory bundle and its feedback persistence against fake
 * Prisma delegates. No database: each delegate is a stub that records what it
 * was asked for.
 */

function correctionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "fb-1",
    issueNumber: 12,
    repository: "acme/web",
    category: "classification_wrong",
    originalDecision: "closed as duplicate",
    correction: "not a duplicate: different platform",
    correctedBy: "U0TEST01",
    reason: null,
    decisionId: null,
    team: null,
    component: null,
    createdAt: new Date("2026-02-03T04:05:06.000Z"),
    ...overrides,
  };
}

function feedbackPrisma() {
  const delegate = {
    create: vi.fn(async () => ({})),
    findMany: vi.fn(async () => [correctionRow()]),
    groupBy: vi.fn(async () => [{ category: "classification_wrong", _count: { _all: 3 } }]),
  };
  return { prisma: { feedbackCorrection: delegate } as unknown as FeedbackCorrectionPrisma, delegate };
}

describe("PrismaFeedbackPersistence", () => {
  it("truncates long values and stores absent optionals as null", async () => {
    const { prisma, delegate } = feedbackPrisma();
    const record: FeedbackRecord = {
      id: "fb-1",
      issueNumber: 12,
      repository: "acme/web",
      category: "classification_wrong",
      originalDecision: "x".repeat(5000),
      correction: "y",
      correctedBy: "U0TEST01",
      createdAt: "2026-02-03T04:05:06.000Z",
    };

    await new PrismaFeedbackPersistence(prisma).recordFeedback(record);

    const { data } = (delegate.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0];
    expect((data.originalDecision as string).length).toBe(2000);
    expect(data).toMatchObject({ reason: null, decisionId: null, team: null, component: null });
    expect(data.createdAt).toEqual(new Date("2026-02-03T04:05:06.000Z"));
  });

  it("maps rows back to records without inventing empty optionals", async () => {
    const { prisma } = feedbackPrisma();
    const [record] = await new PrismaFeedbackPersistence(prisma).getFeedbackForIssue(12, "acme/web");

    expect(record).toEqual({
      id: "fb-1",
      issueNumber: 12,
      repository: "acme/web",
      category: "classification_wrong",
      originalDecision: "closed as duplicate",
      correction: "not a duplicate: different platform",
      correctedBy: "U0TEST01",
      createdAt: "2026-02-03T04:05:06.000Z",
    });
  });

  it("scopes and bounds every read", async () => {
    const { prisma, delegate } = feedbackPrisma();
    const persistence = new PrismaFeedbackPersistence(prisma);
    const since = new Date("2026-01-01T00:00:00.000Z");

    await persistence.getFeedbackForIssue(12, "acme/web");
    await persistence.getFeedbackByCategory("classification_wrong", since);
    await persistence.getRecentFeedback(500);
    await persistence.getRecentFeedback(-3);

    expect(delegate.findMany.mock.calls.map((call) => (call as unknown as [unknown])[0])).toEqual([
      { where: { issueNumber: 12, repository: "acme/web" }, orderBy: { createdAt: "desc" }, take: 20 },
      { where: { category: "classification_wrong", createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 50 },
      { orderBy: { createdAt: "desc" }, take: 20 },
      { orderBy: { createdAt: "desc" }, take: 1 },
    ]);
  });

  it("aggregates counts by category", async () => {
    const { prisma } = feedbackPrisma();
    await expect(new PrismaFeedbackPersistence(prisma).getAggregation(new Date())).resolves.toEqual([
      { category: "classification_wrong", count: 3 },
    ]);
  });
});

describe("createEngineeringMemoryBundle", () => {
  function bundlePrisma() {
    const empty = { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) };
    const userPreference = {
      ...empty,
      findUnique: vi.fn(async () => ({
        slackId: "U0TEST01",
        detailLevel: "standard",
        timezone: "Europe/Lisbon",
        role: "lead",
        teams: [],
        watchedRepos: [],
        watchedIssues: [],
        ownedComponents: [],
        preferences: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    };
    return {
      prisma: {
        knowledgeNode: { ...empty },
        knowledgeEdge: { ...empty },
        issueMemory: { ...empty },
        userPreference,
        feedbackCorrection: { findMany: vi.fn(async () => []), groupBy: vi.fn(async () => []), create: vi.fn() },
      } as unknown as EngineeringMemoryPrisma,
      userPreference,
    };
  }

  it("wires retrieval to the stores, reading the asking person's profile", async () => {
    const { prisma, userPreference } = bundlePrisma();
    const { retrieval } = createEngineeringMemoryBundle(prisma, "acme/web");

    const context = await retrieval.retrieve({ actorSlackId: "U0TEST01" });

    expect(userPreference.findUnique).toHaveBeenCalledWith({ where: { slackId: "U0TEST01" } });
    expect(retrieval.formatForConversation(context)).toContain("timezone: Europe/Lisbon");
  });

  it("falls back to the default repository for an issue named without one", async () => {
    const { prisma } = bundlePrisma();
    const bundle = createEngineeringMemoryBundle(prisma, "acme/web");

    await bundle.retrieval.retrieve({ issueNumber: 12 });

    const issueMemory = (prisma as unknown as { issueMemory: { findUnique: ReturnType<typeof vi.fn> } }).issueMemory;
    expect(issueMemory.findUnique).toHaveBeenCalledWith({ where: { issueNumber_repo: { issueNumber: 12, repo: "acme/web" } } });
  });
});
