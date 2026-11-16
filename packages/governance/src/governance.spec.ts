import { describe, expect, it } from "vitest";
import { validateCompleteness } from "../src/intake/completeness-validator";
import { evaluateValidityPolicy } from "../src/intake/validity-policy";
import { lexicalDuplicateSearch } from "../src/duplicate/lexical-search";
import { evaluatePendingClosure } from "../src/pending-closure/pending-closure-policy";
import { RunBudgetTracker } from "../src/budgets/run-budget-tracker";
import { evaluateQuickFixEligibility } from "../src/quick-fix/quick-fix-eligibility";
import { evaluateSeverityPriority } from "../src/severity/severity-priority-policy";

describe("completeness validator", () => {
  it("requires environment and reproduction fields", () => {
    const result = validateCompleteness({
      source: { type: "api" },
      title: "Bug",
      stepsToReproduce: ["Open page"],
      expectedBehaviour: "Works",
      actualBehaviour: "Broken",
      environment: {},
    });
    expect(result.complete).toBe(false);
    expect(result.missingFields).toContain("environment");
  });
});

describe("validity policy", () => {
  it("prefers acceptance on low confidence", () => {
    const decision = evaluateValidityPolicy(
      { verdict: "NOT_A_BUG", confidence: 0.5, reasoning: "unclear" },
      [],
      { rejectConfidenceThreshold: 0.85, securityLabels: ["security"] },
    );
    expect(decision.accept).toBe(true);
    expect(decision.applyReviewLabel).toBe(true);
  });
});

describe("lexical duplicate search", () => {
  it("finds similar titles", () => {
    const matches = lexicalDuplicateSearch(
      "Novu console error after signup",
      ["Sign up", "Open dashboard"],
      "Console shows Novu error",
      [
        {
          number: 856,
          title: "Novu Intercom errors after signup",
          body: "console error novu",
          labels: [],
          state: "open",
          url: "https://github.com/o/r/856",
        },
      ],
      0.2,
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].issueNumber).toBe(856);
  });
});

describe("pending closure", () => {
  it("schedules grace when eligible", () => {
    const result = evaluatePendingClosure(
      {
        classification: "NOT_OBSERVED_WITH_COMPLETE_COVERAGE",
        decisionConfidence: 0.9,
        lifecycleCoverageComplete: true,
        incompleteEvidence: false,
        qualifyingAttemptCount: 2,
        reproduced: false,
        labels: [],
        hasLinkedOpenPr: false,
        hasRecentHumanComment: false,
      },
      {
        enabled: true,
        gracePeriodDays: 7,
        minQualifyingAttempts: 2,
        pendingLabel: "lexi:pending-closure",
        notObservedLabel: "lexi:not-observed",
        holdLabels: ["lexi:hold"],
        protectedLabels: ["security"],
        protectedSeverities: ["s1"],
        protectedPriorities: ["p0"],
        minConfidence: 0.85,
        humanActivityWindowDays: 14,
      },
    );
    expect(result.shouldMarkPending).toBe(true);
  });

  it("blocks incomplete lifecycle", () => {
    const result = evaluatePendingClosure(
      {
        classification: "NOT_OBSERVED_WITH_COMPLETE_COVERAGE",
        decisionConfidence: 0.9,
        lifecycleCoverageComplete: false,
        incompleteEvidence: true,
        qualifyingAttemptCount: 2,
        labels: [],
        hasLinkedOpenPr: false,
        hasRecentHumanComment: false,
      },
      {
        enabled: true,
        gracePeriodDays: 7,
        minQualifyingAttempts: 2,
        pendingLabel: "lexi:pending-closure",
        notObservedLabel: "lexi:not-observed",
        holdLabels: [],
        protectedLabels: [],
        protectedSeverities: [],
        protectedPriorities: [],
        minConfidence: 0.85,
        humanActivityWindowDays: 14,
      },
    );
    expect(result.shouldMarkPending).toBe(false);
  });
});

describe("run budgets", () => {
  it("defers when limit exceeded", () => {
    const tracker = new RunBudgetTracker(
      {
        duplicateClosuresPerRun: 1,
        pendingClosureMarksPerRun: 1,
        actualClosuresPerRun: 1,
        reproductionSubmissionsPerRun: 1,
        quickFixPullRequestsPerRun: 1,
      },
      "run-1",
    );
    tracker.consume("bre_submission");
    const check = tracker.check("bre_submission");
    expect(check.allowed).toBe(false);
  });
});

describe("quick-fix eligibility", () => {
  it("denies high priority", () => {
    const result = evaluateQuickFixEligibility(
      {
        priorityLabel: "priority:p0",
        reproduced: true,
        rootCausePaths: ["src/ui/button.ts"],
        estimatedFilesChanged: 1,
        estimatedLinesChanged: 5,
        canAddRegressionTest: true,
        labels: [],
        openAutofixPrCount: 0,
      },
      {
        maxPriority: "P3",
        maxSeverity: "S3",
        maxFilesChanged: 3,
        maxLinesChanged: 80,
        forbiddenLabels: [],
        forbiddenComponents: [],
        forbiddenPathPatterns: [],
        maxOpenPrsPerReviewer: 3,
        maxOpenPrsPerIssue: 1,
        staleReminderDays: 7,
        staleCloseDays: 14,
        autofixLabel: "lexi:autofix",
      },
    );
    expect(result.eligible).toBe(false);
  });
});

describe("severity priority", () => {
  it("matches trading rule", () => {
    const result = evaluateSeverityPriority(
      { tradingImpact: true, customerFacing: true },
      {
        version: "1.0.0",
        humanPriorityProtection: true,
        priorityOrder: ["P0", "P1", "P2", "P3", "P4"],
        severityOrder: ["S1", "S2", "S3", "S4"],
        rules: [
          {
            id: "trading-critical",
            when: { tradingImpact: true, customerFacing: true },
            severity: "S1",
            priority: "P0",
            explanation: "Trading",
          },
        ],
      },
    );
    expect(result.severity).toBe("S1");
    expect(result.priority).toBe("P0");
  });
});
