/**
 * Certification tests — Advanced Agent Intelligence
 */
import { describe, expect, it, vi } from "vitest";
import { PlanBuilder, AgentPlanExecutionEngine } from "./agent-plan.service";
import { generateHypotheses, selectBestAction, updateProbabilities, isInvestigationConcluded } from "./hypothesis-investigation.service";
import { CrossIssueReasoningService } from "./cross-issue-reasoning.service";
import { FeedbackLearningService } from "./feedback-learning.service";
import { LexiCapabilityRegistry, buildCapabilityRegistry } from "./capability-registry";
import { evaluateCounterfactual, formatCounterfactualForDisplay } from "./counterfactual.service";

describe("Certification — Advanced Agent Intelligence", () => {
  // =========================================================================
  // F1: AgentPlanService
  // =========================================================================
  describe("F1: General Agent Plans", () => {
    it("builds a multi-step plan with dependencies", () => {
      const builder = new PlanBuilder();
      builder.setGoal("Investigate P1 Cashier issues");
      builder.setScope("All open P1 issues in cashier component");
      const s1 = builder.addStep("query", "Find all open P1 Cashier issues", { tool: "query_issues", dependsOn: [] });
      const s2 = builder.addStep("investigate", "Check implementation links", { tool: "get_fix_chain", dependsOn: [s1] });
      const s3 = builder.addStep("verify", "Run reproduction on unverified issues", { tool: "process_issue", dependsOn: [s2], requiresApproval: true });

      const plan = builder.build("U-ACTOR");
      expect(plan.steps).toHaveLength(3);
      expect(plan.steps[0].dependsOn).toEqual([]);
      expect(plan.steps[1].dependsOn).toEqual([s1]);
      expect(plan.steps[2].requiresApproval).toBe(true);
      expect(plan.status).toBe("draft");
      expect(plan.goal).toBe("Investigate P1 Cashier issues");
    });

    it("executes steps respecting dependencies", async () => {
      const builder = new PlanBuilder();
      builder.setGoal("Test");
      builder.setScope("Test");
      builder.addStep("query", "Step 1", { dependsOn: [] });
      builder.addStep("aggregate", "Step 2");
      const plan = builder.build("actor");
      plan.status = "running";

      const persistence = {
        savePlan: vi.fn(),
        getPlan: vi.fn().mockResolvedValue(plan),
        updatePlan: vi.fn(),
        listPlansForActor: vi.fn(),
      };
      const executor = vi.fn().mockResolvedValue({ result: { count: 5 } });
      const engine = new AgentPlanExecutionEngine(persistence, executor, { log: vi.fn(), warn: vi.fn() });

      const result = await engine.executeNext(plan.id);
      expect(result.completedSteps.length).toBeGreaterThan(0);
      expect(executor).toHaveBeenCalled();
    });

    it("pauses at approval-required steps", async () => {
      const builder = new PlanBuilder();
      builder.setGoal("Test");
      builder.setScope("Test");
      builder.addStep("query", "Step 1", { dependsOn: [] });
      builder.addStep("mutate", "Needs approval", { requiresApproval: true });
      const plan = builder.build("actor");
      plan.status = "running";

      const persistence = {
        savePlan: vi.fn(),
        getPlan: vi.fn().mockResolvedValue(plan),
        updatePlan: vi.fn(),
        listPlansForActor: vi.fn(),
      };
      const executor = vi.fn().mockResolvedValue({ result: "ok" });
      const engine = new AgentPlanExecutionEngine(persistence, executor, { log: vi.fn(), warn: vi.fn() });

      const result = await engine.executeNext(plan.id);
      // First step executes, second pauses for approval
      expect(result.awaitingApproval).toBeDefined();
      expect(result.status).toBe("paused");
    });

    it("respects budget limits", async () => {
      const builder = new PlanBuilder();
      builder.setGoal("Test");
      builder.setScope("Test");
      for (let i = 0; i < 5; i++) builder.addStep("query", `Step ${i}`, { dependsOn: [] });
      const plan = builder.build("actor", { maxSteps: 2 });
      plan.status = "running";

      const persistence = {
        savePlan: vi.fn(),
        getPlan: vi.fn().mockResolvedValue(plan),
        updatePlan: vi.fn(),
        listPlansForActor: vi.fn(),
      };
      const executor = vi.fn().mockResolvedValue({ result: "ok" });
      const engine = new AgentPlanExecutionEngine(persistence, executor, { log: vi.fn(), warn: vi.fn() });

      const result = await engine.executeNext(plan.id);
      expect(result.budgetExhausted).toBe(true);
      expect(executor).toHaveBeenCalledTimes(2);
    });
  });


  // =========================================================================
  // F2: Hypothesis Investigation
  // =========================================================================
  describe("F2: Hypothesis-Driven Investigation", () => {
    it("generates hypotheses from issue analysis", () => {
      const hypotheses = generateHypotheses({
        issueNumber: 856, repository: "acme/issues", title: "Login broken after signup",
        body: "After signing up, login fails", labels: ["P1", "auth"],
        hasLinkedPR: true, hasImplementationLink: true, hasDuplicateCandidate: false,
        hasRecentRelease: true, hasFailedReproduction: false, componentMatches: ["auth"],
      });
      expect(hypotheses.length).toBeGreaterThanOrEqual(4);
      // Probabilities should sum to ~1
      const total = hypotheses.reduce((s, h) => s + h.priorProbability, 0);
      expect(total).toBeCloseTo(1.0, 1);
    });

    it("prior adjusts based on linked PR", () => {
      const withPR = generateHypotheses({
        issueNumber: 1, repository: "r", title: "T", body: "", labels: [],
        hasLinkedPR: true, hasImplementationLink: true, hasDuplicateCandidate: false,
        hasRecentRelease: false, hasFailedReproduction: false, componentMatches: [],
      });
      const withoutPR = generateHypotheses({
        issueNumber: 1, repository: "r", title: "T", body: "", labels: [],
        hasLinkedPR: false, hasImplementationLink: false, hasDuplicateCandidate: false,
        hasRecentRelease: false, hasFailedReproduction: false, componentMatches: [],
      });
      const fixedWithPR = withPR.find((h) => h.id === "h-already-fixed")!;
      const fixedWithout = withoutPR.find((h) => h.id === "h-already-fixed")!;
      expect(fixedWithPR.priorProbability).toBeGreaterThan(fixedWithout.priorProbability);
    });

    it("updates probabilities after evidence", () => {
      const hypotheses = generateHypotheses({
        issueNumber: 1, repository: "r", title: "T", body: "", labels: [],
        hasLinkedPR: false, hasImplementationLink: false, hasDuplicateCandidate: false,
        hasRecentRelease: false, hasFailedReproduction: false, componentMatches: [],
      });
      const initialBug = hypotheses.find((h) => h.id === "h-unfixed-bug")!.posteriorProbability;

      updateProbabilities(hypotheses, {
        supports: ["h-unfixed-bug"],
        contradicts: ["h-already-fixed", "h-duplicate"],
        neutral: ["h-regression", "h-unsupported"],
      });

      const updatedBug = hypotheses.find((h) => h.id === "h-unfixed-bug")!.posteriorProbability;
      expect(updatedBug).toBeGreaterThan(initialBug);
    });

    it("concludes when one hypothesis dominates", () => {
      const hypotheses = generateHypotheses({
        issueNumber: 1, repository: "r", title: "T", body: "", labels: [],
        hasLinkedPR: false, hasImplementationLink: false, hasDuplicateCandidate: false,
        hasRecentRelease: false, hasFailedReproduction: false, componentMatches: [],
      });

      // Repeatedly support one hypothesis to make it dominate
      for (let i = 0; i < 5; i++) {
        updateProbabilities(hypotheses, {
          supports: ["h-unfixed-bug"],
          contradicts: ["h-already-fixed", "h-duplicate", "h-regression"],
          neutral: ["h-unsupported"],
        });
      }

      const conclusion = isInvestigationConcluded(hypotheses);
      expect(conclusion).not.toBeNull();
      expect(conclusion!.dominantHypothesis).toBe("Genuine Unfixed Bug");
    });
  });


  // =========================================================================
  // F3: Cross-Issue Reasoning
  // =========================================================================
  describe("F3: Cross-Issue Reasoning", () => {
    it("generates insights from corpus data", async () => {
      const queries = {
        getComponentHotspots: vi.fn().mockResolvedValue([
          { component: "cashier", team: "payments", openCount: 15, recentCount: 8, regressionCount: 3, manualReviewCount: 5, avgAge: 12, trend: "increasing" },
        ]),
        getDuplicateClusterGrowth: vi.fn().mockResolvedValue([]),
        getManualReviewDebt: vi.fn().mockResolvedValue([]),
        getStaleHighPriorityIssues: vi.fn().mockResolvedValue([{ issueNumber: 100, title: "P1 stale", priority: "P1", ageDays: 20, team: "web" }]),
        getCapabilityGapCost: vi.fn().mockResolvedValue([]),
        getCorpusSize: vi.fn().mockResolvedValue(1077),
      };
      const service = new CrossIssueReasoningService(queries);
      const report = await service.generateReport();

      expect(report.corpusSize).toBe(1077);
      expect(report.insights.length).toBeGreaterThan(0);
      expect(report.insights.some((i) => i.type === "component_hotspot")).toBe(true);
    });

    it("identifies regressing components", async () => {
      const queries = {
        getComponentHotspots: vi.fn().mockResolvedValue([
          { component: "auth", team: "security", openCount: 5, recentCount: 3, regressionCount: 2, manualReviewCount: 0, avgAge: 5, trend: "increasing" },
          { component: "ui", team: "web", openCount: 10, recentCount: 1, regressionCount: 0, manualReviewCount: 0, avgAge: 30, trend: "stable" },
        ]),
        
        getDuplicateClusterGrowth: vi.fn(), getManualReviewDebt: vi.fn().mockResolvedValue([]),
        getStaleHighPriorityIssues: vi.fn().mockResolvedValue([]),
        getCapabilityGapCost: vi.fn().mockResolvedValue([]), getCorpusSize: vi.fn().mockResolvedValue(100),
      };
      const service = new CrossIssueReasoningService(queries);
      const regressions = await service.identifyRegressions();
      expect(regressions).toHaveLength(1);
      expect(regressions[0].component).toBe("auth");
    });
  });

  // =========================================================================
  // F4: Feedback Learning
  // =========================================================================
  describe("F4: Feedback & Learning", () => {
    it("records human corrections", async () => {
      const persistence = {
        recordFeedback: vi.fn(),
        getFeedbackForIssue: vi.fn().mockResolvedValue([]),
        getFeedbackByCategory: vi.fn().mockResolvedValue([]),
        getAggregation: vi.fn().mockResolvedValue([]),
        getRecentFeedback: vi.fn().mockResolvedValue([]),
      };
      const service = new FeedbackLearningService(persistence);
      const id = await service.recordCorrection({
        issueNumber: 856, repository: "acme/issues", category: "ownership_wrong",
        originalDecision: "Assigned to Web team", correction: "Should be Cashier team",
        correctedBy: "U-LEAD",
      });
      expect(id).toBeDefined();
      expect(persistence.recordFeedback).toHaveBeenCalled();
    });

    it("returns this-issue corrections first as lessons for the next act", async () => {
      const persistence = {
        recordFeedback: vi.fn(),
        getFeedbackForIssue: vi.fn().mockResolvedValue([
          {
            id: "a",
            issueNumber: 856,
            repository: "acme/issues",
            category: "ownership_wrong",
            originalDecision: "Web",
            correction: "Cashier",
            correctedBy: "U1",
            createdAt: "2026-08-22T00:00:00.000Z",
          },
        ]),
        getFeedbackByCategory: vi.fn().mockResolvedValue([]),
        getAggregation: vi.fn().mockResolvedValue([]),
        getRecentFeedback: vi.fn().mockResolvedValue([
          {
            id: "b",
            issueNumber: 900,
            repository: "acme/issues",
            category: "duplicate_wrong",
            originalDecision: "dup of 1",
            correction: "not a duplicate",
            correctedBy: "U2",
            createdAt: "2026-08-22T00:00:00.000Z",
          },
        ]),
      };
      const service = new FeedbackLearningService(persistence);
      const lessons = await service.getLessonsForContext({
        issueNumber: 856,
        repository: "acme/issues",
        limit: 6,
      });
      expect(lessons[0].issueNumber).toBe(856);
      expect(lessons).toHaveLength(2);
    });

    it("generates recommendations from aggregated feedback", async () => {
      const persistence = {
        recordFeedback: vi.fn(),
        getFeedbackForIssue: vi.fn(),
        getFeedbackByCategory: vi.fn().mockResolvedValue([
          { issueNumber: 1, originalDecision: "Web", correction: "Cashier", category: "ownership_wrong" },
          { issueNumber: 2, originalDecision: "Web", correction: "Cashier", category: "ownership_wrong" },
          { issueNumber: 3, originalDecision: "Web", correction: "Cashier", category: "ownership_wrong" },
        ]),
        getAggregation: vi.fn().mockResolvedValue([
          { category: "ownership_wrong", count: 5 },
          { category: "duplicate_wrong", count: 3 },
        ]),
        getRecentFeedback: vi.fn().mockResolvedValue([]),
      };
      const service = new FeedbackLearningService(persistence);
      const report = await service.generateRecommendations(30);

      expect(report.totalCorrections).toBe(8);
      expect(report.recommendations.length).toBe(2);
      expect(report.recommendations[0].category).toBe("ownership_wrong");
      expect(report.recommendations[0].recommendation).toContain("ownership");
    });
  });


  // =========================================================================
  // F5: Capability Registry
  // =========================================================================
  describe("F5: Self-Knowledge (Capability Registry)", () => {
    it("builds registry from runtime config", () => {
      const registry = buildCapabilityRegistry({
        writesEnabled: true, semanticDuplicateEnabled: false, llmAdjudicationEnabled: false,
        humanAdjudicationEnabled: false, closedIssueSemanticsEnabled: false,
        projectsEnabled: false, projectsWritesEnabled: false,
        evidencePipelineEnabled: true, slackAgentEnabled: true, batchEnabled: true,
      });
      const all = registry.getAll();
      expect(all.length).toBeGreaterThanOrEqual(10);
      expect(registry.get("github_writes")?.status).toBe("available");
      expect(registry.get("semantic_duplicate_search")?.status).toBe("external_pending");
      expect(registry.get("release_tracking")).toBeUndefined();
    });

    it("answers 'Can you do X?' questions", () => {
      const registry = buildCapabilityRegistry({
        writesEnabled: true, semanticDuplicateEnabled: true, llmAdjudicationEnabled: true,
        humanAdjudicationEnabled: true, closedIssueSemanticsEnabled: true,
        projectsEnabled: true, projectsWritesEnabled: true,
        evidencePipelineEnabled: true, slackAgentEnabled: true, batchEnabled: true,
      });
      const result = registry.queryCapability("Can you update Projects?");
      expect(result.matched.length).toBeGreaterThan(0);
      expect(result.answer).toContain("Projects");
    });

    it("reports degraded capabilities", () => {
      const registry = buildCapabilityRegistry({
        writesEnabled: true, semanticDuplicateEnabled: true, llmAdjudicationEnabled: true,
        humanAdjudicationEnabled: true, closedIssueSemanticsEnabled: true,
        projectsEnabled: true, projectsWritesEnabled: false,
        evidencePipelineEnabled: true, slackAgentEnabled: true, batchEnabled: true,
      });
      const degraded = registry.getByStatus("degraded");
      expect(degraded.length).toBeGreaterThan(0);
      expect(degraded[0].id).toBe("github_projects");
    });

    it("health summary includes all status categories", () => {
      const registry = buildCapabilityRegistry({
        writesEnabled: true, semanticDuplicateEnabled: false, llmAdjudicationEnabled: false,
        humanAdjudicationEnabled: false, closedIssueSemanticsEnabled: false,
        projectsEnabled: false, projectsWritesEnabled: false,
        evidencePipelineEnabled: false, slackAgentEnabled: false, batchEnabled: false,
      });
      const summary = registry.getHealthSummary();
      expect(summary).toContain("Available");
      expect(summary).toContain("Disabled");
    });
  });

  // =========================================================================
  // F6: Counterfactual Reasoning
  // =========================================================================
  describe("F6: Counterfactual Reasoning", () => {
    it("evaluates a hypothetical close action", () => {
      const outcome = evaluateCounterfactual(
        { action: "close_issue", target: { issueNumber: 856 }, actorId: "U-QA" },
        {
          checkAuthorization: () => ({ allowed: true, reason: "QA role has close permission" }),
          checkPolicy: () => ({ allowed: true, reason: "NOT_OBSERVED with complete coverage" }),
          checkWriteGate: () => ({ open: true, reason: "GOVERNED_WRITES_ENABLED=true" }),
          checkBudget: () => ({ available: true, reason: "3/10 closures used" }),
          checkMutationGuard: () => ({ passed: true, reason: "No hold labels, no human activity" }),
        },
      );
      expect(outcome.wouldExecute).toBe(true);
      expect(outcome.sideEffects.length).toBeGreaterThan(0);
    });

    it("reports blocked when write gate is closed", () => {
      const outcome = evaluateCounterfactual(
        { action: "close_issue", target: { issueNumber: 856 }, actorId: "U-QA" },
        {
          checkAuthorization: () => ({ allowed: true, reason: "OK" }),
          checkPolicy: () => ({ allowed: true, reason: "OK" }),
          checkWriteGate: () => ({ open: false, reason: "GOVERNED_WRITES_ENABLED=false" }),
          checkBudget: () => ({ available: true, reason: "OK" }),
          checkMutationGuard: () => ({ passed: true, reason: "OK" }),
        },
      );
      expect(outcome.wouldExecute).toBe(false);
      expect(outcome.explanation).toContain("BLOCKED");
      expect(outcome.writeGateOpen).toBe(false);
    });

    it("formats output for Slack display", () => {
      const outcome = evaluateCounterfactual(
        { action: "batch_process", target: { query: { priority: "P1" } }, actorId: "U" },
        {
          checkAuthorization: () => ({ allowed: false, reason: "Viewer role cannot batch" }),
          checkPolicy: () => ({ allowed: true, reason: "OK" }),
          checkWriteGate: () => ({ open: true, reason: "OK" }),
          checkBudget: () => ({ available: true, reason: "OK" }),
          checkMutationGuard: () => ({ passed: true, reason: "OK" }),
        },
      );
      const display = formatCounterfactualForDisplay(outcome);
      expect(display).toContain("Authorization");
      expect(display).toContain("❌");
    });
  });
});
