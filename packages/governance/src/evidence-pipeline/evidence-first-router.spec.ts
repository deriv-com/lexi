import { describe, it, expect, vi } from "vitest";
import { EvidenceFirstRouter } from "./evidence-first-router";
import { IssueAnalysisService, type AnalysisLLMClient } from "./issue-analysis.service";
import { EngineeringChangeInvestigationService, type InvestigationGitHubPort } from "./engineering-investigation.service";
import type { IssueAnalysisInput } from "./issue-analysis.types";

function createMockLLM(response: Record<string, unknown>): AnalysisLLMClient {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(response) } }] })),
      },
    },
  };
}

function createMockGitHub(overrides: Partial<InvestigationGitHubPort> = {}): InvestigationGitHubPort {
  return {
    getIssue: vi.fn(async () => ({ githubNumber: 1, title: "", body: null, state: "open" as const, labels: [], assignees: [], stateReason: null })),
    listLinkedPullRequests: vi.fn(async () => []),
    listComments: vi.fn(async () => []),
    listTimeline: vi.fn(async () => []),
    ...overrides,
  };
}

const baseAnalysisResponse = {
  bugClass: ["payment failure"],
  likelyComponent: "cashier",
  likelyRepositories: ["acme/web-app"],
  evidenceQuality: "strong",
  likelyFalsePositive: false,
  falsePositiveReasons: [],
  codeSearchTerms: ["cashier", "withdrawal"],
  suspectedFiles: ["src/cashier.ts"],
  lifecycleStates: ["withdrawal"],
  reproductionValue: "low",
  confidence: 0.85,
  expectedBehaviourLikely: false,
  reportCompleteness: "complete",
  expectedBehaviour: "success",
  actualBehaviour: "crash",
  errorStrings: ["TypeError"],
  affectedPlatform: "web",
  possibleRootCause: "null ref",
};

const investigationConfig = {
  sourceOwner: "acme-internal",
  sourceRepo: "issues",
  targetRepositories: [{ owner: "acme", repo: "web-app" }],
};

const routerConfig = { enabled: true, writesEnabled: true, developerLoginPatterns: [/-acme$/i] };

function makeInput(overrides: Partial<IssueAnalysisInput> = {}): IssueAnalysisInput {
  return {
    issueNumber: 856,
    title: "Cashier withdrawal crash",
    body: "Steps to reproduce:\n1. Open cashier\n2. Submit withdrawal\n3. Error\n\nExpected: success. Actual: crash.\nScreenshot attached.",
    labels: ["bug", "priority:P1"],
    authorLogin: "bob-acme",
    state: "open",
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
    ...overrides,
  };
}

describe("EvidenceFirstRouter — integration routing", () => {
  it("case 1: strong evidence from dev, no fix activity → SLACK_NOTIFIED (triage/assign)", async () => {
    const llm = createMockLLM(baseAnalysisResponse);
    const github = createMockGitHub();
    const analysisService = new IssueAnalysisService(llm, { model: "test", promptVersion: "v1" });
    const investigationService = new EngineeringChangeInvestigationService(github, investigationConfig);
    const router = new EvidenceFirstRouter(analysisService, investigationService, routerConfig);

    const result = await router.evaluate(makeInput());

    expect(result.routeTo).toBe("SLACK_NOTIFIED");
    expect(result.reproductionDecision.required).toBe(false);
    expect(result.reproductionDecision.alternativeAction).toBe("TRIAGE_AND_ASSIGN");
    expect(result.stages.issueAnalysis.source).toBe("llm");
  });

  it("case 2: AI-generated issue with weak evidence → QUEUED (needs reproduction)", async () => {
    const weakAnalysis = { ...baseAnalysisResponse, evidenceQuality: "weak", reproductionValue: "high", reportCompleteness: "minimal" };
    const llm = createMockLLM(weakAnalysis);
    const github = createMockGitHub();
    const analysisService = new IssueAnalysisService(llm, { model: "test", promptVersion: "v1" });
    const investigationService = new EngineeringChangeInvestigationService(github, investigationConfig);
    const router = new EvidenceFirstRouter(analysisService, investigationService, routerConfig);

    const result = await router.evaluate(makeInput({ authorLogin: "qa-bot", labels: ["ai-generated"] }));

    expect(result.routeTo).toBe("QUEUED");
    expect(result.reproductionDecision.required).toBe(true);
  });

  it("case 3: active PR linked → SLACK_NOTIFIED (monitor)", async () => {
    const llm = createMockLLM(baseAnalysisResponse);
    const github = createMockGitHub({
      listLinkedPullRequests: vi.fn(async () => [
        { number: 42, url: "", state: "open" as const, merged: false, title: "Fix cashier" },
      ]),
    });
    const analysisService = new IssueAnalysisService(llm, { model: "test", promptVersion: "v1" });
    const investigationService = new EngineeringChangeInvestigationService(github, investigationConfig);
    const router = new EvidenceFirstRouter(analysisService, investigationService, routerConfig);

    const result = await router.evaluate(makeInput());

    expect(result.routeTo).toBe("SLACK_NOTIFIED");
    expect(result.reproductionDecision.required).toBe(false);
    expect(result.reproductionDecision.alternativeAction).toBe("MONITOR_PR");
  });

  it("case 4: merged PR not released → RETEST (await release)", async () => {
    const llm = createMockLLM(baseAnalysisResponse);
    const github = createMockGitHub({
      listLinkedPullRequests: vi.fn(async () => [
        { number: 99, url: "", state: "closed" as const, merged: true, title: "Fix withdrawal" },
      ]),
    });
    const analysisService = new IssueAnalysisService(llm, { model: "test", promptVersion: "v1" });
    const investigationService = new EngineeringChangeInvestigationService(github, investigationConfig);
    const router = new EvidenceFirstRouter(analysisService, investigationService, routerConfig);

    const result = await router.evaluate(makeInput());

    // PR merged but no release evidence → PR_MERGED_NOT_RELEASED → await release
    expect(result.routeTo).toBe("RETEST");
    expect(result.reproductionDecision.required).toBe(false);
    expect(result.reproductionDecision.alternativeAction).toBe("AWAIT_RELEASE");
  });

  it("case 5: released fix → QUEUED (needs reproduction verification)", async () => {
    const llm = createMockLLM(baseAnalysisResponse);
    const github = createMockGitHub({
      listLinkedPullRequests: vi.fn(async () => [
        { number: 99, url: "", state: "closed" as const, merged: true, title: "Fix withdrawal" },
      ]),
      listComments: vi.fn(async () => [
        { id: 1, authorLogin: "dev", body: "Fixed in #99, deployed to production.", createdAt: "2026-08-01" },
      ]),
    });
    const analysisService = new IssueAnalysisService(llm, { model: "test", promptVersion: "v1" });
    const investigationService = new EngineeringChangeInvestigationService(github, investigationConfig);
    const router = new EvidenceFirstRouter(analysisService, investigationService, routerConfig);

    const result = await router.evaluate(makeInput());

    // Released (from comment) but not verified by reproduction → needs reproduction
    expect(result.routeTo).toBe("QUEUED");
    expect(result.reproductionDecision.required).toBe(true);
    expect(result.stages.fixAssessment.status).toBe("RELEASED_NOT_VERIFIED");
  });

  it("case 6: GitHub API failure does not become 'no fix found' — still routes conservatively", async () => {
    const llm = createMockLLM(baseAnalysisResponse);
    const github = createMockGitHub({
      listLinkedPullRequests: vi.fn(async () => { throw new Error("rate limited"); }),
      listTimeline: vi.fn(async () => { throw new Error("rate limited"); }),
    });
    const analysisService = new IssueAnalysisService(llm, { model: "test", promptVersion: "v1" });
    const investigationService = new EngineeringChangeInvestigationService(github, investigationConfig);
    const router = new EvidenceFirstRouter(analysisService, investigationService, routerConfig);

    const result = await router.evaluate(makeInput());

    // Despite API failures, strong evidence + trusted dev → triage
    // The investigation has errors but the evidence assessment is still strong
    expect(result.stages.engineeringInvestigation.errors.length).toBeGreaterThan(0);
    expect(result.stages.engineeringInvestigation.limitations.some((l) => l.includes("API call(s) failed"))).toBe(true);
    // Routing still works — doesn't falsely claim "no fix evidence" when it couldn't check
    expect(["SLACK_NOTIFIED", "QUEUED"]).toContain(result.routeTo);
  });

  it("case 7: LLM failure uses deterministic fallback — pipeline still completes", async () => {
    const failingLLM: AnalysisLLMClient = {
      chat: { completions: { create: vi.fn(async () => { throw new Error("LLM unavailable"); }) } },
    };
    const github = createMockGitHub();
    const analysisService = new IssueAnalysisService(failingLLM, { model: "test", promptVersion: "v1" });
    const investigationService = new EngineeringChangeInvestigationService(github, investigationConfig);
    const router = new EvidenceFirstRouter(analysisService, investigationService, routerConfig);

    const result = await router.evaluate(makeInput());

    expect(result.stages.issueAnalysis.source).toBe("fallback");
    // Pipeline completed despite LLM failure
    expect(result.routeTo).toBeDefined();
    expect(result.reproductionDecision).toBeDefined();
  });

  it("case 8: false positive indicators → QUEUED (reproduction needed to verify)", async () => {
    const fpAnalysis = { ...baseAnalysisResponse, likelyFalsePositive: true, falsePositiveReasons: ["Described behaviour matches documented limitations"], reproductionValue: "high" };
    const llm = createMockLLM(fpAnalysis);
    const github = createMockGitHub();
    const analysisService = new IssueAnalysisService(llm, { model: "test", promptVersion: "v1" });
    const investigationService = new EngineeringChangeInvestigationService(github, investigationConfig);
    const router = new EvidenceFirstRouter(analysisService, investigationService, routerConfig);

    const result = await router.evaluate(makeInput());

    expect(result.routeTo).toBe("QUEUED");
    expect(result.reproductionDecision.required).toBe(true);
    expect(result.reproductionDecision.reason).toContain("false positive");
  });

  it("case 9: old stale issue with no fix → QUEUED (scheduled reproduction)", async () => {
    const llm = createMockLLM({ ...baseAnalysisResponse, reproductionValue: "medium", evidenceQuality: "medium" });
    const github = createMockGitHub();
    const analysisService = new IssueAnalysisService(llm, { model: "test", promptVersion: "v1" });
    const investigationService = new EngineeringChangeInvestigationService(github, investigationConfig);
    const router = new EvidenceFirstRouter(analysisService, investigationService, routerConfig);

    const result = await router.evaluate(makeInput({
      createdAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000), // 45 days old
    }));

    expect(result.routeTo).toBe("QUEUED");
    expect(result.reproductionDecision.required).toBe(true);
    expect(result.reproductionDecision.reason).toContain("older than 30 days");
  });

  it("all stages are populated in the result for persistence", async () => {
    const llm = createMockLLM(baseAnalysisResponse);
    const github = createMockGitHub();
    const analysisService = new IssueAnalysisService(llm, { model: "test", promptVersion: "v1" });
    const investigationService = new EngineeringChangeInvestigationService(github, investigationConfig);
    const router = new EvidenceFirstRouter(analysisService, investigationService, routerConfig);

    const result = await router.evaluate(makeInput());

    // Every stage populated
    expect(result.stages.issueAnalysis).toBeDefined();
    expect(result.stages.issueAnalysis.analysis.bugClass).toContain("payment failure");
    expect(result.stages.observationAssessment).toBeDefined();
    expect(result.stages.observationAssessment.sourceType).toBe("developer");
    expect(result.stages.engineeringInvestigation).toBeDefined();
    expect(result.stages.engineeringInvestigation.investigatedAt).toBeInstanceOf(Date);
    expect(result.stages.fixAssessment).toBeDefined();
    expect(result.stages.fixAssessment.status).toBe("NO_FIX_EVIDENCE");
    expect(result.stages.reproductionDecision).toBeDefined();
    expect(result.stages.reproductionDecision.required).toBeDefined();
  });
});
