/**
 * Certification tests — Evaluation Infrastructure
 */
import { describe, expect, it, vi } from "vitest";
import { scoreDataset, runGoldenDataset, type GoldenCase, type CaseResult } from "./golden-dataset";
import { compareRuns } from "./policy-regression";
import { ShadowModeService } from "./shadow-mode";
import { computeCalibration } from "./calibration";
import { buildExitDashboard, formatExitDashboard } from "./exit-dashboard";

describe("Certification — Evaluation Infrastructure", () => {
  // =========================================================================
  // H1: Golden Dataset Scoring
  // =========================================================================
  describe("H1: Golden Dataset", () => {
    it("scores a fully agreeing dataset as passed", () => {
      const results: CaseResult[] = [
        { goldenId: "g1", actual: { classification: "VERIFIED", policyAction: "assign_and_notify" }, agreed: true, executedAt: "", durationMs: 10 },
        { goldenId: "g2", actual: { classification: "CANNOT_REPRODUCE", policyAction: "auto_close" }, agreed: true, executedAt: "", durationMs: 10 },
      ];
      const score = scoreDataset(results, "v1");
      expect(score.passed).toBe(true);
      expect(score.agreementRate).toBe(1.0);
      expect(score.byCategory.correct).toBe(2);
    });

    it("fails when agreement rate is below threshold", () => {
      const results: CaseResult[] = Array.from({ length: 10 }, (_, i) => ({
        goldenId: `g${i}`,
        actual: {},
        agreed: i < 7, // 70% agreement
        disagreementCategory: i >= 7 ? "classification_error" as const : "correct" as const,
        executedAt: "",
        durationMs: 10,
      }));
      const score = scoreDataset(results, "v1");
      expect(score.passed).toBe(false);
      expect(score.agreementRate).toBe(0.7);
      expect(score.failReasons.length).toBeGreaterThan(0);
    });

    it("blocks on ANY false closure", () => {
      const results: CaseResult[] = [
        { goldenId: "g1", actual: {}, agreed: true, executedAt: "", durationMs: 10 },
        { goldenId: "g2", actual: {}, agreed: false, disagreementCategory: "false_closure", executedAt: "", durationMs: 10 },
      ];
      // Even with 50% agreement (above threshold for 2 cases), false closure blocks
      const score = scoreDataset(results, "v1", { minAgreementRate: 0.5, maxFalseClosures: 0, maxFalseRejections: 5, maxFalseDuplicates: 5 });
      expect(score.passed).toBe(false);
      expect(score.failReasons.some((r) => r.includes("false closure"))).toBe(true);
    });

    it("runner executes cases and produces scored results", async () => {
      const cases: GoldenCase[] = [{
        goldenId: "g1",
        issue: { number: 100, repository: "acme/issues", revision: "abc", title: "Bug", body: "Broken", labels: ["bug"], state: "open", authorLogin: "user" },
        expected: { classification: "VERIFIED", policyAction: "assign_and_notify" },
        rationale: "Clearly verified bug",
        approvals: [{ reviewer: "qa-lead", role: "qa", approvedAt: "2026-08-09" }],
        frozenAt: "2026-08-09",
        datasetVersion: "v1",
      }];
      const executor = vi.fn().mockResolvedValue({ classification: "VERIFIED", policyAction: "assign_and_notify" });

      const { results, score } = await runGoldenDataset(cases, executor, "v1");
      expect(results).toHaveLength(1);
      expect(results[0].agreed).toBe(true);
      expect(score.passed).toBe(true);
    });
  });

  // =========================================================================
  // H3: Policy Regression
  // =========================================================================
  describe("H3: Policy Regression", () => {
    it("detects regressions between policy versions", () => {
      const previous: CaseResult[] = [
        { goldenId: "g1", actual: {}, agreed: true, executedAt: "", durationMs: 10 },
        { goldenId: "g2", actual: {}, agreed: true, executedAt: "", durationMs: 10 },
      ];
      const current: CaseResult[] = [
        { goldenId: "g1", actual: {}, agreed: true, executedAt: "", durationMs: 10 },
        { goldenId: "g2", actual: {}, agreed: false, disagreementCategory: "false_closure", executedAt: "", durationMs: 10 },
      ];
      const report = compareRuns(
        previous, current,
        { id: "v1", name: "old", appliedAt: "2026-08-01" },
        { id: "v2", name: "new", appliedAt: "2026-08-09" },
        "v1",
      );
      expect(report.regressions).toHaveLength(1);
      expect(report.safeToRollout).toBe(false);
      expect(report.blockReasons.some((r) => r.includes("false closure"))).toBe(true);
    });

    it("allows rollout when improvements outweigh (no new false closures)", () => {
      const previous: CaseResult[] = [
        { goldenId: "g1", actual: {}, agreed: false, disagreementCategory: "ownership_error", executedAt: "", durationMs: 10 },
        { goldenId: "g2", actual: {}, agreed: true, executedAt: "", durationMs: 10 },
      ];
      const current: CaseResult[] = [
        { goldenId: "g1", actual: {}, agreed: true, executedAt: "", durationMs: 10 },
        { goldenId: "g2", actual: {}, agreed: true, executedAt: "", durationMs: 10 },
      ];
      const report = compareRuns(previous, current, { id: "v1", name: "old", appliedAt: "" }, { id: "v2", name: "new", appliedAt: "" }, "v1");
      expect(report.improvements).toHaveLength(1);
      expect(report.regressions).toHaveLength(0);
      expect(report.safeToRollout).toBe(true);
    });
  });

  // =========================================================================
  // H4: Shadow Mode
  // =========================================================================
  describe("H4: Shadow Mode", () => {
    it("captures shadow decisions when enabled", async () => {
      const persistence = {
        captureShadowDecision: vi.fn(),
        getUncomparedDecisions: vi.fn().mockResolvedValue([]),
        updateComparison: vi.fn(),
        getDisagreementSummary: vi.fn().mockResolvedValue({ total: 0, agreed: 0, disagreed: 0, byCategory: {} }),
      };
      const service = new ShadowModeService(persistence, { enabled: true, sampleRate: 1, comparisonWindowHours: 24 });

      await service.capture(856, "acme/issues", { classification: "VERIFIED", policyAction: "assign_and_notify", confidence: 0.9, reasoning: "Bug confirmed" });
      expect(persistence.captureShadowDecision).toHaveBeenCalled();
    });

    it("does not capture when disabled", async () => {
      const persistence = { captureShadowDecision: vi.fn(), getUncomparedDecisions: vi.fn(), updateComparison: vi.fn(), getDisagreementSummary: vi.fn() };
      const service = new ShadowModeService(persistence, { enabled: false, sampleRate: 1, comparisonWindowHours: 24 });

      await service.capture(856, "acme/issues", { classification: "VERIFIED", policyAction: "assign_and_notify", confidence: 0.9, reasoning: "" });
      expect(persistence.captureShadowDecision).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // H5: Calibration
  // =========================================================================
  describe("H5: Calibration", () => {
    it("reports well-calibrated system", () => {
      // Perfectly calibrated: confidence matches accuracy
      const samples = Array.from({ length: 100 }, (_, i) => ({
        confidence: (i % 10) / 10 + 0.05,
        correct: Math.random() < (i % 10) / 10 + 0.05,
      }));
      const report = computeCalibration(samples);
      expect(report.totalDecisions).toBe(100);
      expect(report.buckets.length).toBe(10);
      // ECE should be relatively low for a roughly calibrated system
      expect(report.ece).toBeLessThan(0.5);
    });

    it("detects overconfident system", () => {
      // Always says 0.95 confidence but only correct 50% of the time
      const samples = Array.from({ length: 100 }, () => ({
        confidence: 0.95,
        correct: Math.random() < 0.5,
      }));
      const report = computeCalibration(samples);
      expect(report.overconfident).toBe(true);
      expect(report.interpretation).toContain("OVERCONFIDENT");
    });

    it("handles empty samples", () => {
      const report = computeCalibration([]);
      expect(report.totalDecisions).toBe(0);
      expect(report.ece).toBe(0);
    });
  });

  // =========================================================================
  // H6: Exit Dashboard
  // =========================================================================
  describe("H6: Exit Dashboard", () => {
    it("certifies when all metrics pass", () => {
      const dashboard = buildExitDashboard(
        [
          { name: "goldenAgreementRate", value: 0.94 },
          { name: "falseClosureRate", value: 0.0 },
          { name: "duplicatePrecision", value: 0.92 },
          { name: "calibrationEce", value: 0.05 },
        ],
        { repositories: ["acme/issues"], organizations: ["acme"], actionClasses: ["close", "label"], policyVersion: "v1.0", configVersion: "2026-08-09", featureFlags: { GOVERNED_WRITES_ENABLED: true } },
      );
      expect(dashboard.recommendation).toBe("CERTIFY");
      expect(dashboard.allPassed).toBe(true);
    });

    it("blocks on false closure rate", () => {
      const dashboard = buildExitDashboard(
        [
          { name: "goldenAgreementRate", value: 0.94 },
          { name: "falseClosureRate", value: 0.02 },
        ],
        { repositories: ["acme/issues"], organizations: ["acme"], actionClasses: [], policyVersion: "v1", configVersion: "v1", featureFlags: {} },
      );
      expect(dashboard.recommendation).toBe("BLOCK");
      expect(dashboard.failedMetrics.some((m) => m.name === "falseClosureRate")).toBe(true);
    });

    it("formats dashboard for display", () => {
      const dashboard = buildExitDashboard(
        [{ name: "goldenAgreementRate", value: 0.85 }],
        { repositories: ["acme/issues"], organizations: ["acme"], actionClasses: [], policyVersion: "v1", configVersion: "v1", featureFlags: {} },
      );
      const display = formatExitDashboard(dashboard);
      expect(display).toContain("Production Exit Dashboard");
      expect(display).toContain("goldenAgreementRate");
    });
  });
});
