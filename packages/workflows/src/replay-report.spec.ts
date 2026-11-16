import { describe, it, expect } from "vitest";
import type { ReplayAt, ReplayReport } from "./replay-report";
import { formatReplayReport, formatTimeTravelReplay } from "./replay-report";

const stubReport: ReplayReport = {
  issueId: "issue-1",
  githubNumber: 101,
  repoOwner: "acme",
  repoName: "issues",
  title: "Console errors",
  labels: ["domain:web"],
  url: "https://github.com/acme/issues/issues/101",
  githubState: "open",
  workflowStatus: "SLACK_NOTIFIED",
  planner: {
    inferredBugClasses: ["console", "signup"],
    primaryBugClass: "console",
    routingConfidence: 0.95,
    primaryScenarioId: "web.signup_console_check",
    fallbackScenarioIds: ["web.signup_demo"],
    candidateScenarios: [
      { rank: 1, scenarioId: "web.signup_console_check", bugClasses: ["console", "signup"] },
      { rank: 2, scenarioId: "web.ai_guided_flow" },
    ],
    reasoning: "Console keywords detected",
  },
  reproduction: {
    scenarioFit: 0.91,
    incompleteEvidence: false,
    outcomeKind: "bug_not_observed",
    attempts: [
      {
        scenarioId: "web.signup_console_check",
        scenarioFit: 0.91,
        bugObserved: false,
        reasoning: "No errors",
      },
    ],
  },
  decision: {
    classification: "CANNOT_REPRODUCE",
    confidence: 0.91,
    summary: "Not observed",
    reasoning: "Clean run",
    recommendedAction: "Close",
    team: "Web",
    owner: null,
  },
  policy: { allowed: false, reason: "PR not merged in linked repo." },
  generatedAt: "2026-07-31T00:00:00.000Z",
};

describe("formatReplayReport", () => {
  it("formats full flight recorder with arrows", () => {
    const text = formatReplayReport(stubReport);
    expect(text).toContain("Issue #101");
    expect(text).toContain("Planner");
    expect(text).toContain("↓");
    expect(text).toContain("web.signup_console_check");
    expect(text).toContain("Auto-close blocked");
    expect(text).toContain("PR not merged");
  });

  it("formats planner step with ranked candidates", () => {
    const text = formatReplayReport(stubReport, "planner");
    expect(text).toContain("Bug classes");
    expect(text).toContain("1. web.signup_console_check");
    expect(text).toContain("2. web.ai_guided_flow");
  });

  it("formats time-travel planner stage with INPUT/OUTPUT", () => {
    const text = formatTimeTravelReplay(stubReport, "planner");
    expect(text).toContain("Time Travel: planner");
    expect(text).toContain("INPUT");
    expect(text).toContain("OUTPUT");
    expect(text).toContain("web.signup_console_check");
  });

  it("formats time-travel policy stage with INPUT/OUTPUT", () => {
    const text = formatTimeTravelReplay(stubReport, "policy");
    expect(text).toContain("Time Travel: policy");
    expect(text).toContain("INPUT");
    expect(text).toContain("OUTPUT");
    expect(text).toContain("auto-close allowed: no");
    expect(text).toContain("PR not merged");
  });

  it("emits not-yet-available when evidence stage has no data", () => {
    const text = formatTimeTravelReplay(stubReport, "evidence");
    expect(text).toContain("Time Travel: evidence");
    expect(text).toContain("not yet available");
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("Auto-close blocked");
  });

  it("emits not-yet-available when evidence is explicitly unavailable", () => {
    const text = formatTimeTravelReplay(
      {
        ...stubReport,
        evidence: {
          available: false,
          records: [],
          unavailableReason: "Runner evidence ingest is not yet available.",
        },
      },
      "evidence",
    );
    expect(text).toContain("not yet available");
    expect(text).not.toContain("phase=");
  });

  it("lists evidence records by phase and attemptId without dumping JSON", () => {
    const text = formatTimeTravelReplay(
      {
        ...stubReport,
        evidence: {
          available: true,
          records: [
            {
              id: "ev-1",
              phase: "verify",
              attemptId: "attempt-42",
              reportedAt: "2026-08-18T05:00:00.000Z",
              checkCount: 4,
              failingTestCount: 1,
            },
          ],
        },
      },
      "evidence",
    );
    expect(text).toContain("Time Travel: evidence");
    expect(text).toContain("phase=verify");
    expect(text).toContain("attemptId=attempt-42");
    expect(text).toContain("checks=4");
    expect(text).toContain("failing=1");
    expect(text).not.toContain("{");
    expect(text).not.toContain("not yet available");
  });

  it("fails closed for an unknown runtime stage instead of full replay", () => {
    const text = formatTimeTravelReplay(stubReport, "not-a-stage" as ReplayAt);
    expect(text).toContain("not yet available");
    expect(text).not.toContain("Auto-close blocked");
    expect(text).not.toContain("Planner");
  });
});
