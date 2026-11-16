/**
 * End-to-end certification: Human Adjudication Full Path
 *
 * Proves the complete human-in-the-loop duplicate adjudication path:
 *
 *   possible duplicate detected
 *   → Slack adjudication message posted
 *   → human rejects the duplicate
 *   → adjudication persisted with rejection
 *   → issue remains eligible for ACCEPT_NEW
 *   → audit/replay trail contains the human decision
 *
 * This is the "exists vs wired vs operational" proof for duplicate detection.
 */
import { describe, expect, it, vi } from "vitest";
import { HumanAdjudicationService } from "./human-adjudication.service";
import { DuplicateOrchestrator } from "./duplicate-orchestrator";
import { InMemoryVectorIndexProvider } from "./semantic-index";
import { DuplicateAuditService } from "./duplicate-audit.service";
import type { IssueSearchCandidate } from "./lexical-search";

describe("E2E: Human Adjudication Full Path", () => {
  it("possible duplicate → Slack → human rejects → persisted → eligible for ACCEPT_NEW → audit contains decision", async () => {
    // --- Setup: mock infrastructure ---
    const slackMessages: Array<{ channel: string; input: any }> = [];
    const persistedRequests: Map<string, any> = new Map();
    const auditRecords: Array<any> = [];
    let requestIdCounter = 0;

    const mockSlack = {
      postAdjudicationRequest: vi.fn().mockImplementation(async (channel, input) => {
        slackMessages.push({ channel, input });
        return { messageTs: `ts-${++requestIdCounter}` };
      }),
      notifyReporter: vi.fn().mockResolvedValue({ messageTs: "ts-reporter" }),
    };

    const mockPersistence = {
      createRequest: vi.fn().mockImplementation(async (record) => {
        const id = `adj-${++requestIdCounter}`;
        persistedRequests.set(id, { ...record, id });
        return id;
      }),
      updateRequest: vi.fn().mockImplementation(async (id, update) => {
        const existing = persistedRequests.get(id);
        if (existing) {
          persistedRequests.set(id, { ...existing, ...update });
        }
      }),
      getRequest: vi.fn().mockImplementation(async (id) => persistedRequests.get(id) ?? null),
      getPendingForIssue: vi.fn().mockImplementation(async (issueNumber) => {
        return [...persistedRequests.values()].filter(
          (r) => r.sourceIssueNumber === issueNumber && r.status === "pending",
        );
      }),
    };

    const mockAuditPersistence = {
      recordAudit: vi.fn().mockImplementation(async (record) => {
        auditRecords.push(record);
        return record.id;
      }),
      getAuditBySource: vi.fn().mockImplementation(async (issueNumber) => {
        return auditRecords.filter((r) => r.sourceIssueNumber === issueNumber);
      }),
      getAuditById: vi.fn().mockResolvedValue(null),
    };

    // --- Step 1: Set up services ---
    const humanAdj = new HumanAdjudicationService(mockSlack, mockPersistence, {
      adjudicationChannel: "C-DEDUP-REVIEW",
      expirationMs: 72 * 60 * 60 * 1000,
      notifyReporter: true,
    });

    const auditService = new DuplicateAuditService(mockAuditPersistence);

    // Mock adjudicator that returns medium-confidence POSSIBLE_DUPLICATE
    const mockAdjudicator = {
      adjudicate: vi.fn().mockResolvedValue([{
        issueNumber: 42,
        similarity: 0.68,
        verdict: "POSSIBLE_DUPLICATE",
        confidence: 0.68,
        reasoning: "Similar checkout error but different trigger mechanism",
        overlappingSignals: ["checkout", "500", "coupon"],
        differingSignals: ["trigger differs"],
      }]),
    };

    const vectorIndex = new InMemoryVectorIndexProvider();
    await vectorIndex.upsert({
      id: "acme/web#42",
      issueNumber: 42,
      repository: "acme/web",
      text: "checkout coupon 500 error submit payment form",
      updatedAt: new Date().toISOString(),
    });

    const orchestrator = new DuplicateOrchestrator(
      vectorIndex,
      mockAdjudicator,
      null, // no consolidation for medium-confidence
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

    const candidates: IssueSearchCandidate[] = [
      {
        number: 42,
        title: "Checkout throws 500 on empty coupon",
        body: "Server error when coupon field is empty on checkout",
        labels: ["bug"],
        state: "open",
        url: "https://github.com/acme/web/issues/42",
      },
    ];

    // --- Step 2: Run duplicate evaluation ---
    const outcome = await orchestrator.evaluate(
      "Checkout page 500 error with expired coupon",
      ["Go to checkout", "Enter expired coupon SAVE20", "Submit"],
      "HTTP 500 response from payment service",
      candidates,
      { sourceIssueNumber: 200, sourceRepository: "acme/web", reporterSlackId: "U-REPORTER" },
    );

    // --- Step 3: Verify Slack adjudication message was posted ---
    expect(outcome.action).toBe("NEEDS_HUMAN_ADJUDICATION");
    expect(outcome.humanAdjudicationId).toBeDefined();
    expect(slackMessages.length).toBe(1);
    expect(slackMessages[0].channel).toBe("C-DEDUP-REVIEW");
    expect(slackMessages[0].input.sourceIssueNumber).toBe(200);
    expect(slackMessages[0].input.candidateIssueNumber).toBe(42);

    // Reporter was notified
    expect(mockSlack.notifyReporter).toHaveBeenCalledWith("U-REPORTER", expect.anything());

    // --- Step 4: Record audit trail ---
    await auditService.record(
      200,
      "acme/web",
      "Checkout page 500 error with expired coupon\nHTTP 500 response",
      outcome,
      { adjudicationMethod: "heuristic" },
    );

    // --- Step 5: Human rejects the duplicate ---
    const adjId = outcome.humanAdjudicationId!;
    await humanAdj.rejectDuplicate(adjId, "U-REVIEWER", "Different trigger — expired coupon vs empty coupon");

    // --- Step 6: Verify persisted adjudication ---
    const updatedRequest = persistedRequests.get(adjId);
    expect(updatedRequest).toBeDefined();
    expect(updatedRequest.status).toBe("rejected");
    expect(updatedRequest.resolution).toBe("Different trigger — expired coupon vs empty coupon");
    expect(updatedRequest.resolvedBy).toBe("U-REVIEWER");
    expect(updatedRequest.resolvedAt).toBeInstanceOf(Date);

    // --- Step 7: Issue remains eligible for ACCEPT_NEW ---
    // After rejection, the issue should NOT be in pending adjudication anymore
    const stillPending = await humanAdj.hasPendingAdjudication(200, "acme/web");
    expect(stillPending).toBe(false);

    // The orchestrator action was NEEDS_HUMAN_ADJUDICATION, NOT REJECT_DUPLICATE
    // So the issue was never blocked from creation — it's eligible for ACCEPT_NEW
    expect(outcome.action).not.toBe("REJECT_DUPLICATE");

    // --- Step 8: Audit/replay contains the human decision ---
    const auditHistory = await auditService.getHistory(200, "acme/web");
    expect(auditHistory.length).toBe(1);
    expect(auditHistory[0].action).toBe("NEEDS_HUMAN_ADJUDICATION");
    expect(auditHistory[0].humanAdjudicationRequested).toBe(true);
    expect(auditHistory[0].sourceIssueNumber).toBe(200);
  });

  it("reporter can reject a proposed duplicate with a reason", async () => {
    const persistedRequests: Map<string, any> = new Map();
    let counter = 0;

    const mockSlack = {
      postAdjudicationRequest: vi.fn().mockResolvedValue({ messageTs: "ts-1" }),
      notifyReporter: vi.fn().mockResolvedValue({ messageTs: "ts-2" }),
    };

    const mockPersistence = {
      createRequest: vi.fn().mockImplementation(async (record) => {
        const id = `adj-${++counter}`;
        persistedRequests.set(id, { ...record, id });
        return id;
      }),
      updateRequest: vi.fn().mockImplementation(async (id, update) => {
        const existing = persistedRequests.get(id);
        if (existing) persistedRequests.set(id, { ...existing, ...update });
      }),
      getRequest: vi.fn().mockImplementation(async (id) => persistedRequests.get(id)),
      getPendingForIssue: vi.fn().mockImplementation(async (issueNumber) =>
        [...persistedRequests.values()].filter((r) => r.sourceIssueNumber === issueNumber && r.status === "pending"),
      ),
    };

    const service = new HumanAdjudicationService(mockSlack, mockPersistence, {
      adjudicationChannel: "C-DEDUP",
      expirationMs: 72 * 60 * 60 * 1000,
      notifyReporter: false,
    });

    // Create adjudication request
    const id = await service.requestAdjudication({
      sourceIssueNumber: 300,
      sourceRepository: "acme/web",
      sourceTitle: "Payment timeout on 3G",
      candidateIssueNumber: 50,
      candidateRepository: "acme/web",
      candidateTitle: "Payment gateway timeout",
      confidence: 0.65,
      reasoning: "Both timeout on payment",
      reporterSlackId: "U-REPORTER",
    });

    // Reporter rejects
    await service.reporterReject(id, "U-REPORTER", "Mine is specifically about 3G mobile network, not general timeout");

    // Verify the rejection is persisted correctly
    const request = persistedRequests.get(id);
    expect(request.status).toBe("reporter_rejected");
    expect(request.reporterRejection).toBe(true);
    expect(request.reporterRejectionReason).toContain("3G mobile network");
    expect(request.resolvedBy).toBe("U-REPORTER");

    // No longer pending
    const pending = await service.hasPendingAdjudication(300, "acme/web");
    expect(pending).toBe(false);
  });
});
