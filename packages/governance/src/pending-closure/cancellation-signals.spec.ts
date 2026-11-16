import { describe, expect, it } from "vitest";
import { CANCELLATION_REASON_CODES } from "./cancellation-reason-codes";
import { evaluateCancellationSignals } from "./cancellation-signals";

const baseContext = {
  pendingClosureId: "pc-1",
  pendingClosureCreatedAt: new Date("2026-08-01T00:00:00Z"),
  scheduledCloseAt: new Date("2026-08-08T00:00:00Z"),
  labelsSnapshot: ["bug", "priority:p2"],
  assigneesSnapshot: [],
  currentLabels: ["bug", "priority:p2"],
  currentAssignees: [],
  holdLabels: ["lexi:hold"],
  comments: [],
  timeline: [],
  linkedPullRequests: [],
  matchingIntakeAfterScheduling: false,
  newEvidenceRecords: [],
};

describe("evaluateCancellationSignals", () => {
  it("cancels on human comment after scheduling", () => {
    const result = evaluateCancellationSignals({
      ...baseContext,
      comments: [
        {
          id: 1,
          authorLogin: "qa-human",
          body: "Still reproducing for me",
          createdAt: "2026-08-02T12:00:00Z",
        },
      ],
    });
    expect(result.shouldCancel).toBe(true);
    expect(result.reasonCode).toBe(CANCELLATION_REASON_CODES.HUMAN_COMMENT);
    expect(result.sourceActor).toBe("qa-human");
  });

  it("cancels on human reaction", () => {
    const result = evaluateCancellationSignals({
      ...baseContext,
      timeline: [
        {
          id: 1,
          event: "reaction",
          actorLogin: "reporter",
          createdAt: "2026-08-02T12:00:00Z",
          raw: { content: "+1" },
        },
      ],
    });
    expect(result.shouldCancel).toBe(true);
    expect(result.reasonCode).toBe(CANCELLATION_REASON_CODES.HUMAN_REACTION);
  });

  it("cancels on new evidence comment", () => {
    const result = evaluateCancellationSignals({
      ...baseContext,
      comments: [
        {
          id: 2,
          authorLogin: "lexi-bot",
          body: "See screenshot https://example.com/evidence.png",
          createdAt: "2026-08-02T12:00:00Z",
        },
      ],
    });
    expect(result.shouldCancel).toBe(true);
    expect(result.reasonCode).toBe(CANCELLATION_REASON_CODES.NEW_EVIDENCE);
  });

  it("cancels on priority escalation", () => {
    const result = evaluateCancellationSignals({
      ...baseContext,
      currentLabels: ["bug", "priority:p0"],
    });
    expect(result.shouldCancel).toBe(true);
    expect(result.reasonCode).toBe(CANCELLATION_REASON_CODES.PRIORITY_ESCALATED);
  });

  it("cancels on severity escalation", () => {
    const result = evaluateCancellationSignals({
      ...baseContext,
      labelsSnapshot: ["bug", "severity:s3"],
      currentLabels: ["bug", "severity:s1"],
    });
    expect(result.shouldCancel).toBe(true);
    expect(result.reasonCode).toBe(CANCELLATION_REASON_CODES.SEVERITY_ESCALATED);
  });

  it("cancels on matching intake after scheduling", () => {
    const result = evaluateCancellationSignals({
      ...baseContext,
      matchingIntakeAfterScheduling: true,
    });
    expect(result.shouldCancel).toBe(true);
    expect(result.reasonCode).toBe(CANCELLATION_REASON_CODES.MATCHING_INTAKE);
  });

  it("cancels on open linked PR", () => {
    const result = evaluateCancellationSignals({
      ...baseContext,
      linkedPullRequests: [
        {
          number: 42,
          url: "https://github.com/org/repo/pull/42",
          state: "open",
          merged: false,
          title: "Fix attempt",
        },
      ],
    });
    expect(result.shouldCancel).toBe(true);
    expect(result.reasonCode).toBe(CANCELLATION_REASON_CODES.LINKED_PR_OPENED);
  });

  it("cancels on hold label applied after scheduling", () => {
    const result = evaluateCancellationSignals({
      ...baseContext,
      currentLabels: ["bug", "lexi:hold"],
    });
    expect(result.shouldCancel).toBe(true);
    expect(result.reasonCode).toBe(CANCELLATION_REASON_CODES.HOLD_APPLIED);
  });

  it("does not cancel when no signals", () => {
    expect(evaluateCancellationSignals(baseContext).shouldCancel).toBe(false);
  });
});
