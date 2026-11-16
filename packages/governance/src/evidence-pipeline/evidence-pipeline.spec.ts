import { describe, it, expect } from "vitest";
import { assessEvidence } from "./evidence-assessment.service";
import { assessFixLikelihood } from "./fix-assessment.service";
import { evaluateReproductionNecessity } from "./reproduction-necessity-policy";
import { evaluateEvidenceFreshness, evidenceDecayFactor } from "./evidence-freshness";
import type { IssueAnalysis } from "./issue-analysis.types";
import type { EngineeringInvestigation } from "./engineering-investigation.types";

const baseAnalysis: IssueAnalysis = {
  bugClass: ["UI glitch"],
  likelyComponent: "cashier",
  likelyRepositories: ["acme/web-app"],
  evidenceQuality: "medium",
  likelyFalsePositive: false,
  falsePositiveReasons: [],
  codeSearchTerms: ["withdrawal", "cashier"],
  suspectedFiles: ["src/cashier/withdrawal.ts"],
  lifecycleStates: ["deposit", "withdrawal"],
  reproductionValue: "medium",
  confidence: 0.7,
  expectedBehaviourLikely: false,
  reportCompleteness: "complete",
  errorStrings: ["TypeError: Cannot read property"],
  affectedPlatform: "web",
};

describe("Evidence-First Pipeline", () => {
  describe("Evidence Assessment", () => {
    it("classifies AI-generated issues as low trust", () => {
      const result = assessEvidence({
        authorLogin: "qa-bot",
        labels: ["ai-generated"],
        body: "Some issue text",
        analysis: { ...baseAnalysis, reportCompleteness: "minimal" },
      });
      expect(result.sourceType).toBe("ai_generated");
      expect(result.reporterTrust).toBeLessThan(0.4);
      expect(result.requiresReproduction).toBe(true);
    });

    it("classifies developer reports as high trust", () => {
      const result = assessEvidence({
        authorLogin: "bob-acme",
        developerLoginPatterns: [/-acme$/i],
        labels: [],
        body: "Steps to reproduce:\n1. Open cashier\n2. Submit withdrawal\n3. Observe error\n\nExpected: success. Actual: crash.",
        analysis: { ...baseAnalysis, reportCompleteness: "complete" },
      });
      expect(result.sourceType).toBe("developer");
      expect(result.reporterTrust).toBeGreaterThanOrEqual(0.8);
      expect(result.evidenceStrength).toBeGreaterThan(0.5);
    });

    it("treats no login as staff unless the deployment configures a convention", () => {
      const input = {
        authorLogin: "bob-acme",
        labels: [],
        body: "Steps to reproduce:\n1. Open cashier\n2. Submit withdrawal",
        analysis: { ...baseAnalysis, reportCompleteness: "complete" as const },
      };
      expect(assessEvidence(input).sourceType).toBe("unknown");
      expect(assessEvidence({ ...input, developerLoginPatterns: [/^acme-/i] }).sourceType).toBe("unknown");
      expect(assessEvidence({ ...input, developerLoginPatterns: [/-acme$/i] }).sourceType).toBe("developer");
    });

    it("strong evidence from trusted source may skip reproduction", () => {
      const result = assessEvidence({
        authorLogin: "carol",
        labels: ["qa-verified"],
        body: "Steps to reproduce:\n1. Login\n2. Navigate to options\n3. Click trade\n\nExpected: order placed. Actual: error shown.\n\nScreenshot attached.\nBrowser: Chrome 125, Windows 11",
        analysis: { ...baseAnalysis, evidenceQuality: "strong", reproductionValue: "low", reportCompleteness: "complete" },
      });
      expect(result.sourceType).toBe("human_qa");
      expect(result.evidenceStrength).toBeGreaterThanOrEqual(0.7);
      expect(result.reporterTrust).toBeGreaterThanOrEqual(0.8);
      // With low reproduction value, reproduction should not be required
      expect(result.reasons.some((r) => r.includes("sufficient evidence"))).toBe(true);
    });

    it("unknown source with weak evidence requires reproduction", () => {
      const result = assessEvidence({
        authorLogin: "random-person",
        labels: [],
        body: "it broke",
        analysis: { ...baseAnalysis, reportCompleteness: "minimal", reproductionValue: "high" },
      });
      expect(result.sourceType).toBe("unknown");
      expect(result.requiresReproduction).toBe(true);
      expect(result.evidenceStrength).toBeLessThan(0.4);
    });
  });

  describe("Fix Assessment", () => {
    it("merged PR without release returns PR_MERGED_NOT_RELEASED", () => {
      const investigation: EngineeringInvestigation = {
        linkedIssues: [],
        linkedPullRequests: [
          { number: 42, repo: "acme/web-app", state: "merged", title: "Fix cashier crash", changedFiles: ["src/cashier.ts"], mergedAt: "2026-07-20", targetBranch: "main" },
        ],
        codeEvidence: { suspectedPatternExists: false, relatedTestsAdded: false, fixCommitOnDefault: true, fixOnFeatureBranchOnly: false },
        releaseEvidence: { fixReleased: false, deployedToProduction: null },
        investigatedAt: new Date(),
        limitations: [],
      };
      const result = assessFixLikelihood(investigation);
      expect(result.status).toBe("PR_MERGED_NOT_RELEASED");
      expect(result.reproductionRequired).toBe(false);
      expect(result.missingEvidence).toContain("Fix merged but no release contains it yet");
    });

    it("full chain returns FIX_CONFIRMED with high confidence", () => {
      const investigation: EngineeringInvestigation = {
        linkedIssues: [{ number: 100, repo: "acme/web-app", state: "closed", labels: ["fix"], relationship: "implementation", title: "Fix cashier" }],
        linkedPullRequests: [
          { number: 42, repo: "acme/web-app", state: "merged", title: "Fix cashier crash", changedFiles: ["src/cashier.ts"], mergedAt: "2026-07-20", targetBranch: "main" },
        ],
        codeEvidence: { suspectedPatternExists: false, relatedTestsAdded: true, fixCommitOnDefault: true, fixOnFeatureBranchOnly: false },
        releaseEvidence: { fixReleased: true, releaseVersion: "v2.5.1", deployedToProduction: true },
        investigatedAt: new Date(),
        limitations: [],
      };
      const result = assessFixLikelihood(investigation);
      expect(result.status).toBe("FIX_CONFIRMED");
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.reproductionRequired).toBe(false);
    });

    it("no evidence returns NO_FIX_EVIDENCE", () => {
      const investigation: EngineeringInvestigation = {
        linkedIssues: [],
        linkedPullRequests: [],
        codeEvidence: { suspectedPatternExists: null, relatedTestsAdded: false, fixCommitOnDefault: false, fixOnFeatureBranchOnly: false },
        releaseEvidence: { fixReleased: null, deployedToProduction: null },
        investigatedAt: new Date(),
        limitations: ["Could not access repository"],
      };
      const result = assessFixLikelihood(investigation);
      expect(result.status).toBe("NO_FIX_EVIDENCE");
      expect(result.reproductionRequired).toBe(true);
    });

    it("merged PR + faulty pattern still present reduces confidence", () => {
      const investigation: EngineeringInvestigation = {
        linkedIssues: [],
        linkedPullRequests: [
          { number: 42, repo: "acme/web-app", state: "merged", title: "Fix attempt", changedFiles: ["src/cashier.ts"], mergedAt: "2026-07-20", targetBranch: "main" },
        ],
        codeEvidence: { suspectedPatternExists: true, relatedTestsAdded: false, fixCommitOnDefault: true, fixOnFeatureBranchOnly: false },
        releaseEvidence: { fixReleased: true, deployedToProduction: true },
        investigatedAt: new Date(),
        limitations: [],
      };
      const result = assessFixLikelihood(investigation);
      // Despite release, pattern still exists — confidence drops
      expect(result.confidence).toBeLessThan(0.75);
      expect(result.missingEvidence).toContain("Suspected faulty pattern still exists despite merged PR");
    });
  });

  describe("Reproduction Necessity Policy", () => {
    it("duplicate issues skip reproduction", () => {
      const result = evaluateReproductionNecessity({
        evidenceStrength: 0.9, reporterTrust: 0.9,
        likelyFalsePositive: false, reproductionValue: "high",
        fixStatus: "NO_FIX_EVIDENCE", fixConfidence: 0,
        hasActivePR: false, hasLinkedImplementation: false,
        teamIsWorkingOnIt: false, isIncompleteReport: false,
        isDuplicate: true, isUnsupported: false,
        issueAgeInDays: 1,
      });
      expect(result.required).toBe(false);
      expect(result.alternativeAction).toBe("GOVERNED_CLOSURE");
    });

    it("active PR routes to monitor mode", () => {
      const result = evaluateReproductionNecessity({
        evidenceStrength: 0.7, reporterTrust: 0.8,
        likelyFalsePositive: false, reproductionValue: "medium",
        fixStatus: "FIX_IN_PROGRESS", fixConfidence: 0.4,
        hasActivePR: true, hasLinkedImplementation: false,
        teamIsWorkingOnIt: false, isIncompleteReport: false,
        isDuplicate: false, isUnsupported: false,
        issueAgeInDays: 3,
      });
      expect(result.required).toBe(false);
      expect(result.alternativeAction).toBe("MONITOR_PR");
    });

    it("released but unverified fix triggers immediate reproduction", () => {
      const result = evaluateReproductionNecessity({
        evidenceStrength: 0.6, reporterTrust: 0.7,
        likelyFalsePositive: false, reproductionValue: "high",
        fixStatus: "RELEASED_NOT_VERIFIED", fixConfidence: 0.6,
        hasActivePR: false, hasLinkedImplementation: false,
        teamIsWorkingOnIt: false, isIncompleteReport: false,
        isDuplicate: false, isUnsupported: false,
        issueAgeInDays: 14,
      });
      expect(result.required).toBe(true);
      expect(result.priority).toBe("immediate");
    });

    it("strong evidence from trusted source skips reproduction for new issues", () => {
      const result = evaluateReproductionNecessity({
        evidenceStrength: 0.8, reporterTrust: 0.9,
        likelyFalsePositive: false, reproductionValue: "low",
        fixStatus: "NO_FIX_EVIDENCE", fixConfidence: 0,
        hasActivePR: false, hasLinkedImplementation: false,
        teamIsWorkingOnIt: false, isIncompleteReport: false,
        isDuplicate: false, isUnsupported: false,
        issueAgeInDays: 2,
      });
      expect(result.required).toBe(false);
      expect(result.alternativeAction).toBe("TRIAGE_AND_ASSIGN");
    });

    it("incomplete report routes to request more info", () => {
      const result = evaluateReproductionNecessity({
        evidenceStrength: 0.2, reporterTrust: 0.5,
        likelyFalsePositive: false, reproductionValue: "medium",
        fixStatus: "NO_FIX_EVIDENCE", fixConfidence: 0,
        hasActivePR: false, hasLinkedImplementation: false,
        teamIsWorkingOnIt: false, isIncompleteReport: true,
        isDuplicate: false, isUnsupported: false,
        issueAgeInDays: 1,
      });
      expect(result.required).toBe(false);
      expect(result.alternativeAction).toBe("REQUEST_MORE_INFO");
    });

    it("PR merged not released routes to await release", () => {
      const result = evaluateReproductionNecessity({
        evidenceStrength: 0.7, reporterTrust: 0.8,
        likelyFalsePositive: false, reproductionValue: "medium",
        fixStatus: "PR_MERGED_NOT_RELEASED", fixConfidence: 0.5,
        hasActivePR: false, hasLinkedImplementation: false,
        teamIsWorkingOnIt: false, isIncompleteReport: false,
        isDuplicate: false, isUnsupported: false,
        issueAgeInDays: 10,
      });
      expect(result.required).toBe(false);
      expect(result.alternativeAction).toBe("AWAIT_RELEASE");
    });
  });

  describe("Evidence Freshness", () => {
    it("recent evidence is fresh", () => {
      const result = evaluateEvidenceFreshness({
        codeCheckedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      });
      expect(result.staleness).toBe("fresh");
    });

    it("week-old evidence is aging", () => {
      const result = evaluateEvidenceFreshness({
        prCheckedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000), // 14 days ago
      });
      expect(result.staleness).toBe("aging");
    });

    it("month-old evidence is stale", () => {
      const result = evaluateEvidenceFreshness({
        lastReproducedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000), // 45 days ago
      });
      expect(result.staleness).toBe("stale");
    });

    it("decay factor is 1.0 for fresh evidence", () => {
      const factor = evidenceDecayFactor(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
      expect(factor).toBe(1.0);
    });

    it("decay factor is 0.3 for stale evidence", () => {
      const factor = evidenceDecayFactor(new Date(Date.now() - 60 * 24 * 60 * 60 * 1000));
      expect(factor).toBe(0.3);
    });

    it("no timestamps means stale", () => {
      const result = evaluateEvidenceFreshness({});
      expect(result.staleness).toBe("stale");
    });
  });
});
