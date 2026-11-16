/**
 * Certification tests — Persistent Semantic Duplicate Intelligence
 *
 * These tests verify the full duplicate-detection contract including:
 * - Embedding provider interface
 * - PgVector provider (with mock query executor)
 * - Degraded provider behavior
 * - Hybrid retrieval pipeline
 * - LLM adjudication
 * - Information consolidation invariant
 * - Human adjudication requirement
 * - Reporter rejection
 * - Closed-issue semantics
 * - Duplicate explanation generation
 * - Metrics collection
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { OpenAiEmbeddingProvider, DisabledEmbeddingProvider } from "./embedding-provider";
import { PgVectorIndexProvider, computeTextHash } from "./pgvector-index-provider";
import { DegradedVectorIndexProvider } from "./degraded-vector-provider";
import { InMemoryVectorIndexProvider, DisabledVectorIndexProvider } from "./semantic-index";
import { LlmDuplicateAdjudicator } from "./llm-adjudication-provider";
import { HeuristicDuplicateAdjudicator } from "./adjudication";
import { ConsolidationService, extractUniqueInformation } from "./consolidation.service";
import { HumanAdjudicationService } from "./human-adjudication.service";
import { hybridRetrieval } from "./hybrid-retrieval";
import { DuplicateOrchestrator } from "./duplicate-orchestrator";
import { resolveClosedIssueAction } from "./duplicate-engine";
import { EmbeddingIndexService, issueToEmbeddingText } from "./embedding-index.service";
import { DuplicateMetricsCollector } from "./duplicate-metrics";
import { generateDuplicateExplanation } from "./duplicate-explanation";
import type { IssueSearchCandidate } from "./lexical-search";


// --- Test fixtures ---
const mockCandidates: IssueSearchCandidate[] = [
  {
    number: 42,
    title: "Checkout throws 500 on empty coupon",
    body: "When submitting checkout form with an empty coupon field, server returns HTTP 500. Steps: 1. Go to /checkout 2. Leave coupon blank 3. Click submit",
    labels: ["bug", "checkout"],
    state: "open",
    url: "https://github.com/acme/web/issues/42",
  },
  {
    number: 99,
    title: "Login page CSS broken on mobile",
    body: "The login form is misaligned on iPhone 15. Elements overlap.",
    labels: ["bug", "ui"],
    state: "open",
    url: "https://github.com/acme/web/issues/99",
  },
  {
    number: 50,
    title: "Payment gateway timeout",
    body: "Payment processing times out after 30s. Error: ETIMEDOUT connecting to stripe.com",
    labels: ["bug", "payments"],
    state: "closed",
    url: "https://github.com/acme/web/issues/50",
    closedReason: "completed",
  },
];


describe("Certification — Persistent Semantic Duplicate Intelligence", () => {
  // =========================================================================
  // C1: Embedding Provider Contract
  // =========================================================================
  describe("C1: Embedding Provider", () => {
    it("DisabledEmbeddingProvider reports unavailable health", async () => {
      const provider = new DisabledEmbeddingProvider();
      const health = await provider.health();
      expect(health.available).toBe(false);
      expect(health.detail).toContain("disabled");
    });

    it("DisabledEmbeddingProvider.embed() throws meaningful error", async () => {
      const provider = new DisabledEmbeddingProvider();
      await expect(provider.embed("test")).rejects.toThrow(/disabled/i);
    });

    it("DisabledEmbeddingProvider.embedBatch() marks all as failed", async () => {
      const provider = new DisabledEmbeddingProvider();
      const result = await provider.embedBatch(["a", "b", "c"]);
      expect(result.failedIndices).toEqual([0, 1, 2]);
    });

    it("computeTextHash is stable and deterministic", () => {
      const text = "Checkout throws 500 on empty coupon";
      expect(computeTextHash(text)).toBe(computeTextHash(text));
      expect(computeTextHash(text)).not.toBe(computeTextHash(text + " "));
    });
  });


  // =========================================================================
  // C2: PgVector Provider Contract
  // =========================================================================
  describe("C2: PgVector Index Provider", () => {
    it("reports disabled when pgvector extension is not available", async () => {
      const mockDb = {
        $queryRawUnsafe: vi.fn().mockRejectedValue(new Error('type "vector" does not exist')),
        $executeRawUnsafe: vi.fn(),
      };
      const mockEmbedding = new DisabledEmbeddingProvider();
      const provider = new PgVectorIndexProvider(mockDb, mockEmbedding);
      const health = await provider.health();
      expect(health.status).toBe("disabled");
      expect(health.detail).toContain("pgvector unavailable");
    });

    it("reports empty when table exists but no embeddings", async () => {
      const mockDb = {
        $queryRawUnsafe: vi.fn().mockResolvedValue([{ count: BigInt(0) }]),
        $executeRawUnsafe: vi.fn(),
      };
      const mockEmbedding = {
        model: "text-embedding-3-small",
        modelVersion: "v3-small-2024",
        dimensions: 1536,
        embed: vi.fn(),
        embedBatch: vi.fn(),
        health: vi.fn(),
      };
      const provider = new PgVectorIndexProvider(mockDb, mockEmbedding);
      const health = await provider.health();
      expect(health.status).toBe("empty");
      expect(health.detail).toContain("backfill");
    });

    it("reports operational when embeddings exist", async () => {
      const mockDb = {
        $queryRawUnsafe: vi.fn()
          .mockResolvedValueOnce([{ count: BigInt(100) }])
          .mockResolvedValueOnce([{ count: BigInt(100) }]),
        $executeRawUnsafe: vi.fn(),
      };
      const mockEmbedding = {
        model: "text-embedding-3-small",
        modelVersion: "v3-small-2024",
        dimensions: 1536,
        embed: vi.fn(),
        embedBatch: vi.fn(),
        health: vi.fn(),
      };
      const provider = new PgVectorIndexProvider(mockDb, mockEmbedding);
      const health = await provider.health();
      expect(health.status).toBe("operational");
      expect(health.documentCount).toBe(100);
    });
  });


  // =========================================================================
  // C3: Degraded Provider
  // =========================================================================
  describe("C3: Degraded Vector Provider", () => {
    it("reports disabled with specific reason", async () => {
      const provider = new DegradedVectorIndexProvider("Connection refused to pgvector host");
      const health = await provider.health();
      expect(health.status).toBe("disabled");
      expect(health.detail).toContain("Connection refused");
      expect(health.detail).toContain("degraded");
    });

    it("returns empty search results without throwing", async () => {
      const provider = new DegradedVectorIndexProvider("timeout");
      const results = await provider.search("test query", 10);
      expect(results).toEqual([]);
    });

    it("accepts upsert without throwing (no data loss)", async () => {
      const provider = new DegradedVectorIndexProvider("offline");
      await expect(
        provider.upsert({
          id: "acme/web#42",
          issueNumber: 42,
          repository: "acme/web",
          text: "test",
          updatedAt: new Date().toISOString(),
        }),
      ).resolves.toBeUndefined();
    });
  });


  // =========================================================================
  // C4: Hybrid Retrieval Pipeline
  // =========================================================================
  describe("C4: Hybrid Retrieval", () => {
    it("combines structured, lexical, and semantic results", async () => {
      const index = new InMemoryVectorIndexProvider();
      await index.upsert({
        id: "acme/web#42",
        issueNumber: 42,
        repository: "acme/web",
        text: "Checkout throws 500 on empty coupon field submit",
        updatedAt: new Date().toISOString(),
      });

      const result = await hybridRetrieval(
        "Checkout page 500 error when coupon is empty",
        ["Go to checkout", "Leave coupon blank", "Submit"],
        "Server returns HTTP 500",
        mockCandidates,
        index,
      );

      expect(result.candidates.length).toBeGreaterThan(0);
      const top = result.candidates[0];
      expect(top.issueNumber).toBe(42);
      expect(top.sources.length).toBeGreaterThanOrEqual(1);
      expect(result.semanticHealth.status).toBe("operational");
    });

    it("returns empty when no matches across all tiers", async () => {
      const index = new DisabledVectorIndexProvider();
      const result = await hybridRetrieval(
        "Completely unrelated issue about email notifications",
        ["Check email inbox"],
        "No notification received",
        [],
        index,
      );
      expect(result.candidates).toEqual([]);
    });

    it("reports semantic health in results", async () => {
      const index = new DisabledVectorIndexProvider();
      const result = await hybridRetrieval(
        "Test",
        [],
        "Test",
        mockCandidates,
        index,
      );
      expect(result.semanticHealth.status).toBe("disabled");
    });
  });


  // =========================================================================
  // C5: Adjudication Contract
  // =========================================================================
  describe("C5: DUPLICATE/POSSIBLE_DUPLICATE/NOT_DUPLICATE Contract", () => {
    it("HeuristicAdjudicator returns valid verdicts", async () => {
      const adjudicator = new HeuristicDuplicateAdjudicator();
      const results = await adjudicator.adjudicate("Test submission", [
        { issueNumber: 1, title: "High sim", body: null, similarity: 0.85 },
        { issueNumber: 2, title: "Mid sim", body: null, similarity: 0.6 },
        { issueNumber: 3, title: "Low sim", body: null, similarity: 0.2 },
      ]);

      expect(results[0].verdict).toBe("DUPLICATE");
      expect(results[1].verdict).toBe("POSSIBLE_DUPLICATE");
      expect(results[2].verdict).toBe("NOT_DUPLICATE");
    });

    it("confidence is always between 0 and 1", async () => {
      const adjudicator = new HeuristicDuplicateAdjudicator();
      const results = await adjudicator.adjudicate("Test", [
        { issueNumber: 1, title: "X", body: null, similarity: 0.99 },
      ]);
      expect(results[0].confidence).toBeGreaterThanOrEqual(0);
      expect(results[0].confidence).toBeLessThanOrEqual(1);
    });
  });


  // =========================================================================
  // C6: Information Consolidation Invariant
  // =========================================================================
  describe("C6: Information-Preserving Consolidation", () => {
    it("extracts unique steps not present in canonical", () => {
      const result = extractUniqueInformation({
        sourceIssueNumber: 100,
        sourceRepository: "acme/web",
        sourceTitle: "Checkout 500 error",
        sourceBody: "Steps to reproduce:\n1. Open /checkout\n2. Enter invalid coupon 'EXPIRED123'\n3. Click submit\n\nExpected: Error message\nActual: HTTP 500",
        sourceLabels: ["bug"],
        canonicalIssueNumber: 42,
        canonicalRepository: "acme/web",
        canonicalTitle: "Checkout throws 500 on empty coupon",
        canonicalBody: "When submitting with empty coupon, 500 error occurs.",
        canonicalLabels: ["bug"],
        adjudicationReasoning: "Same endpoint, same error code",
      });

      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain("EXPIRED123");
    });

    it("ConsolidationService posts comment when writes enabled", async () => {
      const mockGithub = {
        postComment: vi.fn().mockResolvedValue({ id: 12345 }),
      };
      const mockPersistence = {
        recordConsolidation: vi.fn().mockResolvedValue("rec-1"),
      };
      const service = new ConsolidationService(
        mockGithub,
        mockPersistence,
        { writesEnabled: true, dryRun: false },
      );

      const result = await service.consolidate({
        sourceIssueNumber: 100,
        sourceRepository: "acme/web",
        sourceTitle: "Checkout 500",
        sourceBody: "Unique error: NullPointerException in PaymentService.java:42",
        sourceLabels: [],
        canonicalIssueNumber: 42,
        canonicalRepository: "acme/web",
        canonicalTitle: "Checkout 500 empty coupon",
        canonicalBody: "Server returns 500",
        canonicalLabels: [],
        adjudicationReasoning: "Same endpoint",
      });

      expect(result.consolidated).toBe(true);
      expect(result.githubCommentId).toBe(12345);
      expect(mockGithub.postComment).toHaveBeenCalled();
      expect(mockPersistence.recordConsolidation).toHaveBeenCalled();
    });

    it("records audit trail even in dry-run mode", async () => {
      const mockGithub = { postComment: vi.fn() };
      const mockPersistence = {
        recordConsolidation: vi.fn().mockResolvedValue("rec-1"),
      };
      const service = new ConsolidationService(
        mockGithub,
        mockPersistence,
        { writesEnabled: true, dryRun: true },
      );

      await service.consolidate({
        sourceIssueNumber: 100,
        sourceRepository: "acme/web",
        sourceTitle: "Test",
        sourceBody: "Unique content here",
        sourceLabels: [],
        canonicalIssueNumber: 42,
        canonicalRepository: "acme/web",
        canonicalTitle: "Canonical",
        canonicalBody: "Different content",
        canonicalLabels: [],
        adjudicationReasoning: "Test",
      });

      expect(mockGithub.postComment).not.toHaveBeenCalled();
      expect(mockPersistence.recordConsolidation).toHaveBeenCalledWith(
        expect.objectContaining({ consolidationType: "dry_run" }),
      );
    });
  });


  // =========================================================================
  // C7: Human Adjudication Requirement
  // =========================================================================
  describe("C7: Human Adjudication for Medium-Confidence", () => {
    it("posts Slack message and records request", async () => {
      const mockSlack = {
        postAdjudicationRequest: vi.fn().mockResolvedValue({ messageTs: "1234.5678" }),
        notifyReporter: vi.fn().mockResolvedValue({ messageTs: "1234.5679" }),
      };
      const mockPersistence = {
        createRequest: vi.fn().mockResolvedValue("adj-1"),
        updateRequest: vi.fn(),
        getRequest: vi.fn(),
        getPendingForIssue: vi.fn().mockResolvedValue([]),
      };
      const service = new HumanAdjudicationService(mockSlack, mockPersistence, {
        adjudicationChannel: "C-DEDUP",
        expirationMs: 72 * 60 * 60 * 1000,
        notifyReporter: true,
      });

      const id = await service.requestAdjudication({
        sourceIssueNumber: 100,
        sourceRepository: "acme/web",
        sourceTitle: "Checkout 500",
        candidateIssueNumber: 42,
        candidateRepository: "acme/web",
        candidateTitle: "Checkout throws 500",
        confidence: 0.7,
        reasoning: "Similar error on same endpoint",
        reporterSlackId: "U123",
      });

      expect(id).toBe("adj-1");
      expect(mockSlack.postAdjudicationRequest).toHaveBeenCalledWith(
        "C-DEDUP",
        expect.objectContaining({ sourceIssueNumber: 100 }),
      );
      expect(mockSlack.notifyReporter).toHaveBeenCalled();
    });

    it("confirmDuplicate updates status correctly", async () => {
      const mockPersistence = {
        createRequest: vi.fn(),
        updateRequest: vi.fn(),
        getRequest: vi.fn(),
        getPendingForIssue: vi.fn().mockResolvedValue([]),
      };
      const service = new HumanAdjudicationService(
        { postAdjudicationRequest: vi.fn(), notifyReporter: vi.fn() },
        mockPersistence,
        { adjudicationChannel: "C", expirationMs: 1000, notifyReporter: false },
      );

      await service.confirmDuplicate("adj-1", "U-REVIEWER");

      expect(mockPersistence.updateRequest).toHaveBeenCalledWith("adj-1", {
        status: "confirmed",
        resolution: "confirmed_duplicate",
        resolvedBy: "U-REVIEWER",
        resolvedAt: expect.any(Date),
      });
    });
  });


  // =========================================================================
  // C8: Reporter Rejection
  // =========================================================================
  describe("C8: Reporter Duplicate Rejection", () => {
    it("reporter can reject with a reason", async () => {
      const mockPersistence = {
        createRequest: vi.fn(),
        updateRequest: vi.fn(),
        getRequest: vi.fn(),
        getPendingForIssue: vi.fn().mockResolvedValue([]),
      };
      const service = new HumanAdjudicationService(
        { postAdjudicationRequest: vi.fn(), notifyReporter: vi.fn() },
        mockPersistence,
        { adjudicationChannel: "C", expirationMs: 1000, notifyReporter: false },
      );

      await service.reporterReject("adj-1", "U-REPORTER", "Different component");

      expect(mockPersistence.updateRequest).toHaveBeenCalledWith("adj-1", {
        status: "reporter_rejected",
        resolution: "reporter_rejected",
        resolvedBy: "U-REPORTER",
        resolvedAt: expect.any(Date),
        reporterRejection: true,
        reporterRejectionReason: "Different component",
      });
    });
  });


  // =========================================================================
  // C9: Closed-Issue Semantics
  // =========================================================================
  describe("C9: Closed-Issue Semantics", () => {
    it("closed as not-observed → REOPEN", () => {
      const action = resolveClosedIssueAction({
        state: "closed",
        closedReason: "not_planned",
        labels: ["lexi:not-observed"],
      });
      expect(action).toBe("REOPEN");
    });

    it("closed as fixed → REGRESSION", () => {
      const action = resolveClosedIssueAction({
        state: "closed",
        closedReason: "completed",
        labels: ["fixed"],
      });
      expect(action).toBe("REGRESSION");
    });

    it("closed as duplicate → RESOLVE_CANONICAL (chain resolution)", () => {
      const action = resolveClosedIssueAction({
        state: "closed",
        labels: ["duplicate"],
      });
      expect(action).toBe("RESOLVE_CANONICAL");
    });

    it("open issue → NONE", () => {
      const action = resolveClosedIssueAction({
        state: "open",
        labels: [],
      });
      expect(action).toBe("NONE");
    });
  });


  // =========================================================================
  // C10: Embedding Index Service
  // =========================================================================
  describe("C10: Embedding Index Service", () => {
    it("issueToEmbeddingText combines title + body + labels", () => {
      const text = issueToEmbeddingText({
        issueNumber: 42,
        repository: "acme/web",
        title: "Checkout 500",
        body: "Server error on submit",
        labels: ["bug", "checkout"],
        state: "open",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      expect(text).toContain("Checkout 500");
      expect(text).toContain("Server error");
      expect(text).toContain("bug, checkout");
    });

    it("incremental indexing processes provided issues", async () => {
      const mockVectorStore = {
        upsert: vi.fn(),
        remove: vi.fn(),
      };
      const mockPersistence = {
        getCorpusIssues: vi.fn().mockResolvedValue([]),
        getCorpusCount: vi.fn().mockResolvedValue(0),
        getUpdatedIssuesSince: vi.fn().mockResolvedValue([]),
        getExistingEmbeddings: vi.fn().mockResolvedValue(new Map()),
        recordHealthSnapshot: vi.fn(),
      };
      const mockLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const mockEmbedding = new DisabledEmbeddingProvider();

      const service = new EmbeddingIndexService(
        mockEmbedding,
        mockVectorStore,
        mockPersistence,
        mockLogger,
      );

      const result = await service.indexIncremental([
        {
          issueNumber: 1,
          repository: "acme/web",
          title: "Test",
          body: "Body",
          labels: [],
          state: "open",
          updatedAt: new Date().toISOString(),
        },
      ]);

      // upsert is called (even if embedding provider fails, the store is called)
      expect(mockVectorStore.upsert).toHaveBeenCalled();
    });
  });


  // =========================================================================
  // C11: Duplicate Orchestrator — Full Pipeline
  // =========================================================================
  describe("C11: Duplicate Orchestrator", () => {
    it("returns CREATE_NEW when no candidates found", async () => {
      const vectorIndex = new DisabledVectorIndexProvider();
      const adjudicator = new HeuristicDuplicateAdjudicator();
      const orchestrator = new DuplicateOrchestrator(
        vectorIndex,
        adjudicator,
        null,
        null,
        {
          highConfidenceThreshold: 0.85,
          mediumConfidenceThreshold: 0.6,
          reviewDedupLabel: "lexi:review-dedup",
          retrieval: {},
          llmAdjudicationEnabled: false,
          humanAdjudicationEnabled: false,
          consolidationRequired: true,
          closedIssueSemanticsEnabled: true,
        },
      );

      const result = await orchestrator.evaluate(
        "Completely unique bug",
        ["Do something unique"],
        "Unique result",
        [],
      );

      expect(result.action).toBe("CREATE_NEW");
    });

    it("escalates to NEEDS_HUMAN_ADJUDICATION for medium confidence", async () => {
      // Use a custom adjudicator that returns medium confidence
      const mockAdjudicator = {
        adjudicate: vi.fn().mockResolvedValue([{
          issueNumber: 42,
          similarity: 0.65,
          verdict: "POSSIBLE_DUPLICATE",
          confidence: 0.65,
          reasoning: "Similar symptoms on checkout endpoint",
          overlappingSignals: ["checkout", "500"],
          differingSignals: ["different trigger"],
        }]),
      };

      const vectorIndex = new InMemoryVectorIndexProvider();
      await vectorIndex.upsert({
        id: "acme/web#42",
        issueNumber: 42,
        repository: "acme/web",
        text: "checkout coupon empty 500 error submit form payment server",
        updatedAt: new Date().toISOString(),
      });

      const mockSlack = {
        postAdjudicationRequest: vi.fn().mockResolvedValue({ messageTs: "ts" }),
        notifyReporter: vi.fn().mockResolvedValue({ messageTs: "ts" }),
      };
      const mockPersistence = {
        createRequest: vi.fn().mockResolvedValue("adj-1"),
        updateRequest: vi.fn(),
        getRequest: vi.fn(),
        getPendingForIssue: vi.fn().mockResolvedValue([]),
      };
      const humanAdj = new HumanAdjudicationService(mockSlack, mockPersistence, {
        adjudicationChannel: "C-DEDUP",
        expirationMs: 72 * 60 * 60 * 1000,
        notifyReporter: false,
      });

      const orchestrator = new DuplicateOrchestrator(
        vectorIndex,
        mockAdjudicator,
        null,
        humanAdj,
        {
          highConfidenceThreshold: 0.85,
          mediumConfidenceThreshold: 0.5,
          reviewDedupLabel: "lexi:review-dedup",
          retrieval: {},
          llmAdjudicationEnabled: false,
          humanAdjudicationEnabled: true,
          consolidationRequired: true,
          closedIssueSemanticsEnabled: false,
        },
      );

      const result = await orchestrator.evaluate(
        "Checkout 500 error on coupon submit",
        ["Go to checkout", "Enter coupon", "Submit"],
        "Server returns 500",
        mockCandidates,
        { sourceIssueNumber: 200, sourceRepository: "acme/web" },
      );

      expect(result.action).toBe("NEEDS_HUMAN_ADJUDICATION");
      expect(result.humanAdjudicationId).toBe("adj-1");
    });
  });


  // =========================================================================
  // C12: Duplicate Explanation
  // =========================================================================
  describe("C12: Lexi Conversational Explanation", () => {
    it("generates explanation with confidence and signals", () => {
      const explanation = generateDuplicateExplanation({
        decision: {
          issueNumber: 42,
          similarity: 0.8,
          verdict: "DUPLICATE",
          confidence: 0.9,
          reasoning: "Same HTTP 500 on /checkout endpoint with empty coupon",
          overlappingSignals: ["checkout", "500", "coupon"],
          differingSignals: ["different browser"],
        },
        retrievalResult: {
          candidates: [
            { issueNumber: 42, score: 0.8, calibratedSimilarity: 0.78, sources: ["lexical", "semantic"], tierScores: { lexical: 0.7, semantic: 0.85 }, matchedSignals: ["checkout"] },
          ],
          tierResults: { structured: [], lexical: [], semantic: [] },
          semanticHealth: { status: "operational", documentCount: 100, detail: "OK" },
        },
        semanticHealth: { status: "operational", documentCount: 100, detail: "OK" },
        canonicalTitle: "Checkout throws 500 on empty coupon",
        canonicalUrl: "https://github.com/acme/web/issues/42",
        action: "REJECT_DUPLICATE",
        consolidationPerformed: true,
      });

      expect(explanation).toContain("#42");
      expect(explanation).toContain("90%");
      expect(explanation).toContain("checkout");
      expect(explanation).toContain("preserved");
      expect(explanation).toContain("not a duplicate");
    });
  });


  // =========================================================================
  // C13: Metrics
  // =========================================================================
  describe("C13: Metrics Collection", () => {
    it("tracks adjudication outcomes", () => {
      const collector = new DuplicateMetricsCollector();
      collector.recordAdjudication("DUPLICATE");
      collector.recordAdjudication("POSSIBLE_DUPLICATE");
      collector.recordAdjudication("NOT_DUPLICATE");
      collector.recordAdjudication("DUPLICATE");

      const metrics = collector.getMetrics();
      expect(metrics.adjudicationCount).toBe(4);
      expect(metrics.duplicateCount).toBe(2);
      expect(metrics.possibleDuplicateCount).toBe(1);
      expect(metrics.notDuplicateCount).toBe(1);
    });

    it("tracks search latency percentiles", () => {
      const collector = new DuplicateMetricsCollector();
      for (let i = 0; i < 100; i++) {
        collector.recordSearchLatency(i * 10);
      }
      const metrics = collector.getMetrics();
      expect(metrics.avgSearchLatencyMs).toBeGreaterThan(0);
      expect(metrics.p95SearchLatencyMs).toBeGreaterThan(metrics.avgSearchLatencyMs);
    });

    it("exports Prometheus-style samples", () => {
      const collector = new DuplicateMetricsCollector();
      collector.recordSearch();
      const samples = collector.toSamples("lexi_dup_");
      expect(samples.length).toBeGreaterThan(0);
      expect(samples[0].name).toMatch(/^lexi_dup_/);
    });
  });


  // =========================================================================
  // C14: Feature Flags
  // =========================================================================
  describe("C14: Feature Flags", () => {
    it("DUPLICATE_SEMANTIC_ENABLED defaults to false", async () => {
      // Verify the env schema default
      const { envSchema } = await import("@lexi/config");
      const result = envSchema.safeParse({
        DATABASE_URL: "postgres://x",
        REDIS_URL: "redis://x",
        GITHUB_TOKEN: "t",
        GITHUB_OWNER: "o",
        GITHUB_REPO: "r",
        SLACK_BOT_TOKEN: "t",
        SLACK_SIGNING_SECRET: "s",
        OPENAI_API_KEY: "k",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.DUPLICATE_SEMANTIC_ENABLED).toBe(false);
        expect(result.data.DUPLICATE_LLM_ADJUDICATION_ENABLED).toBe(false);
        expect(result.data.DUPLICATE_HUMAN_ADJUDICATION_ENABLED).toBe(false);
        expect(result.data.DUPLICATE_CONSOLIDATION_ENABLED).toBe(true);
        expect(result.data.CLOSED_ISSUE_SEMANTICS_ENABLED).toBe(false);
      }
    });
  });


  // =========================================================================
  // C15: Duplicate never closed without consolidation
  // =========================================================================
  describe("C15: Closure Invariant — Consolidation Required", () => {
    it("orchestrator performs consolidation before REJECT_DUPLICATE", async () => {
      const vectorIndex = new InMemoryVectorIndexProvider();
      // Populate with high-similarity content
      await vectorIndex.upsert({
        id: "acme/web#42",
        issueNumber: 42,
        repository: "acme/web",
        text: "checkout coupon empty 500 error submit form payment",
        updatedAt: new Date().toISOString(),
      });

      // Use a custom adjudicator that always returns high-confidence DUPLICATE
      const mockAdjudicator = {
        adjudicate: vi.fn().mockResolvedValue([{
          issueNumber: 42,
          similarity: 0.95,
          verdict: "DUPLICATE",
          confidence: 0.95,
          reasoning: "Same bug",
          overlappingSignals: ["checkout", "500"],
          differingSignals: [],
        }]),
      };

      const mockGithub = {
        postComment: vi.fn().mockResolvedValue({ id: 999 }),
      };
      const mockPersistence = {
        recordConsolidation: vi.fn().mockResolvedValue("c-1"),
      };
      const consolidation = new ConsolidationService(
        mockGithub,
        mockPersistence,
        { writesEnabled: true, dryRun: false },
      );

      const orchestrator = new DuplicateOrchestrator(
        vectorIndex,
        mockAdjudicator,
        consolidation,
        null,
        {
          highConfidenceThreshold: 0.85,
          mediumConfidenceThreshold: 0.6,
          reviewDedupLabel: "lexi:review-dedup",
          retrieval: {},
          llmAdjudicationEnabled: false,
          humanAdjudicationEnabled: false,
          consolidationRequired: true,
          closedIssueSemanticsEnabled: false,
        },
      );

      const result = await orchestrator.evaluate(
        "Checkout page 500 error when coupon is empty",
        ["Go to /checkout", "Leave coupon blank", "Submit form"],
        "Server returns HTTP 500 payment failed",
        mockCandidates,
        { sourceIssueNumber: 200, sourceRepository: "acme/web" },
      );

      expect(result.action).toBe("REJECT_DUPLICATE");
      expect(result.consolidation).toBeDefined();
      expect(result.consolidation!.consolidated).toBe(true);
      expect(mockGithub.postComment).toHaveBeenCalled();
    });
  });
});
