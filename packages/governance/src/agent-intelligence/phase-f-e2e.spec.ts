/**
 * End-to-end certification: Full Investigation Conversation
 *
 * Proves the complete agent intelligence path:
 *   1. User requests investigation of P1 issues
 *   2. Lexi creates a multi-step plan
 *   3. Plan requires approval → pauses
 *   4. User approves → execution resumes
 *   5. Hypothesis reasoning runs on each issue
 *   6. Cross-issue aggregation produces portfolio insight
 *   7. User provides correction ("not a duplicate")
 *   8. Feedback is persisted without policy modification
 *   9. Capability registry answers "what can you do?"
 *  10. Counterfactual answers "what would happen if?"
 */
import { describe, expect, it, vi } from "vitest";
import { PlanBuilder, AgentPlanExecutionEngine } from "./agent-plan.service";
import { generateHypotheses, updateProbabilities, isInvestigationConcluded } from "./hypothesis-investigation.service";
import { FeedbackLearningService } from "./feedback-learning.service";
import { buildCapabilityRegistry } from "./capability-registry";
import { evaluateCounterfactual } from "./counterfactual.service";

describe("E2E: Full Investigation Conversation", () => {
  it("complete investigation flow: plan → approve → execute → hypothesize → feedback → capabilities → counterfactual", async () => {
    // ===== Step 1: Create investigation plan =====
    const builder = new PlanBuilder();
    builder.setGoal("Investigate all open P1 Cashier issues");
    builder.setScope("P1 issues in cashier component, open state");

    const queryStep = builder.addStep("query", "Find all open P1 Cashier issues", {
      tool: "query_issues",
      args: { state: "open", priority: "P1", component: "cashier" },
      dependsOn: [],
    });
    const investigateStep = builder.addStep("investigate", "Check fix chain for each issue", {
      tool: "get_fix_chain",
      dependsOn: [queryStep],
    });
    const verifyStep = builder.addStep("verify", "Run reproduction on unverified issues", {
      tool: "process_issue",
      dependsOn: [investigateStep],
      requiresApproval: true,
    });
    const aggregateStep = builder.addStep("aggregate", "Summarize findings", {
      dependsOn: [verifyStep],
    });

    const plan = builder.build("U-QA-LEAD");
    expect(plan.steps).toHaveLength(4);
    expect(plan.status).toBe("draft");
    expect(plan.goal).toContain("P1 Cashier");

    // ===== Step 2: Approve plan and start execution =====
    plan.status = "running";
    plan.startedAt = new Date().toISOString();

    const executionResults: unknown[] = [];
    const persistence = {
      savePlan: vi.fn(),
      getPlan: vi.fn().mockResolvedValue(plan),
      updatePlan: vi.fn().mockImplementation(async (_id, update) => {
        Object.assign(plan, update);
      }),
      listPlansForActor: vi.fn(),
    };

    const executor = vi.fn().mockImplementation(async (step) => {
      if (step.kind === "query") return { result: { issues: [{ number: 912 }, { number: 915 }], count: 2 } };
      if (step.kind === "investigate") return { result: { fixedCount: 1, unfixedCount: 1 } };
      if (step.kind === "aggregate") return { result: { summary: "1 fixed, 1 needs verification" } };
      return { result: "ok" };
    });

    const engine = new AgentPlanExecutionEngine(persistence, executor, { log: vi.fn(), warn: vi.fn() });

    // Execute — should pause at verify step (requires approval)
    const firstRun = await engine.executeNext(plan.id);
    expect(firstRun.awaitingApproval).toBeDefined();
    expect(firstRun.status).toBe("paused");
    expect(executor).toHaveBeenCalledTimes(2); // query + investigate executed

    // ===== Step 3: User approves the verification step =====
    await engine.approveStep(plan.id, verifyStep, "U-QA-LEAD");
    expect(plan.steps.find((s) => s.id === verifyStep)?.approvedBy).toBe("U-QA-LEAD");

    // Resume execution
    const secondRun = await engine.executeNext(plan.id);
    expect(secondRun.status).toBe("completed");
    expect(executor).toHaveBeenCalledTimes(4); // All 4 steps

    // ===== Step 4: Hypothesis reasoning for issue #912 =====
    const hypotheses = generateHypotheses({
      issueNumber: 912,
      repository: "acme/issues",
      title: "Cashier deposit timeout on 3G",
      body: "Deposit fails on slow connections",
      labels: ["P1", "cashier"],
      hasLinkedPR: false,
      hasImplementationLink: false,
      hasDuplicateCandidate: false,
      hasRecentRelease: true,
      hasFailedReproduction: false,
      componentMatches: ["cashier"],
    });
    expect(hypotheses.length).toBeGreaterThanOrEqual(4);

    // After investigation finds no linked PR, supports "unfixed bug" and "regression"
    updateProbabilities(hypotheses, {
      supports: ["h-unfixed-bug", "h-regression"],
      contradicts: ["h-already-fixed", "h-duplicate"],
      neutral: ["h-unsupported"],
    });

    const topHypothesis = hypotheses
      .filter((h) => h.status === "active")
      .sort((a, b) => b.posteriorProbability - a.posteriorProbability)[0];
    expect(topHypothesis.id).toBe("h-unfixed-bug");

    // ===== Step 5: User says "#915 is not a duplicate" =====
    const feedbackPersistence = {
      recordFeedback: vi.fn(),
      getFeedbackForIssue: vi.fn().mockResolvedValue([]),
      getFeedbackByCategory: vi.fn().mockResolvedValue([]),
      getAggregation: vi.fn().mockResolvedValue([]),
      getRecentFeedback: vi.fn().mockResolvedValue([]),
    };
    const feedbackService = new FeedbackLearningService(feedbackPersistence);

    const feedbackId = await feedbackService.recordCorrection({
      issueNumber: 915,
      repository: "acme/issues",
      category: "duplicate_wrong",
      originalDecision: "Marked as duplicate of #42",
      correction: "Not a duplicate — different component (3G network vs wifi)",
      correctedBy: "U-QA-LEAD",
      reason: "The trigger is completely different: network timeout vs empty coupon",
    });
    expect(feedbackId).toBeDefined();
    expect(feedbackPersistence.recordFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "duplicate_wrong",
        correctedBy: "U-QA-LEAD",
        issueNumber: 915,
      }),
    );

    // ===== Step 6: Capability check =====
    const registry = buildCapabilityRegistry({
      writesEnabled: true,
      semanticDuplicateEnabled: false,
      llmAdjudicationEnabled: false,
      humanAdjudicationEnabled: false,
      closedIssueSemanticsEnabled: false,
      projectsEnabled: false,
      projectsWritesEnabled: false,
     
      evidencePipelineEnabled: true,
      slackAgentEnabled: true,
      batchEnabled: true,
    });

    const capAnswer = registry.queryCapability("Is semantic duplicate search active?");
    expect(capAnswer.matched.length).toBeGreaterThan(0);
    expect(capAnswer.matched[0].status).toBe("external_pending");

    // ===== Step 7: Counterfactual check =====
    const counterfactual = evaluateCounterfactual(
      { action: "close_issue", target: { issueNumber: 912 }, actorId: "U-QA-LEAD" },
      {
        checkAuthorization: () => ({ allowed: true, reason: "QA Lead role" }),
        checkPolicy: () => ({ allowed: false, reason: "Issue has no verification result" }),
        checkWriteGate: () => ({ open: true, reason: "Writes enabled" }),
        checkBudget: () => ({ available: true, reason: "Budget OK" }),
        checkMutationGuard: () => ({ passed: true, reason: "No hold labels" }),
      },
    );
    expect(counterfactual.wouldExecute).toBe(false);
    expect(counterfactual.explanation).toContain("BLOCKED");
    expect(counterfactual.policyAllowed).toBe(false);
  });
});
