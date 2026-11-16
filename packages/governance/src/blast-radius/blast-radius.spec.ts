import { describe, it, expect } from "vitest";
import { evaluateNeverTouch, isHumanSetDemotion } from "./never-touch-policy";
import { classifyAction, canExecuteAutomatically, isProhibited, getActionsByClass } from "./action-classification";
import { RunBudgetEnforcer, DEFAULT_BUDGET_LIMITS } from "./run-budget";
import { evaluateManualQueue, type ManualQueueItem } from "./manual-queue-sla";

describe("Never-Touch Policy", () => {
  it("protects security-labelled issues", () => {
    const result = evaluateNeverTouch({
      labels: ["bug", "security"], priority: "P2", severity: undefined,
      hasRecentHumanActivity: false, hasOpenLinkedPR: false,
      isExplicitlyAssigned: false, hasActiveEngineeringWork: false, state: "open",
    });
    expect(result.protected).toBe(true);
    expect(result.requiredOverride).toBe("prohibited");
    expect(result.reasons.some((r) => r.includes("security"))).toBe(true);
  });

  it("protects P0/P1 issues", () => {
    const result = evaluateNeverTouch({
      labels: ["bug"], priority: "P1", severity: undefined,
      hasRecentHumanActivity: false, hasOpenLinkedPR: false,
      isExplicitlyAssigned: false, hasActiveEngineeringWork: false, state: "open",
    });
    expect(result.protected).toBe(true);
    expect(result.reasons.some((r) => r.includes("P1"))).toBe(true);
  });

  it("protects issues with recent human activity", () => {
    const result = evaluateNeverTouch({
      labels: [], priority: "P3", severity: undefined,
      hasRecentHumanActivity: true, hasOpenLinkedPR: false,
      isExplicitlyAssigned: false, hasActiveEngineeringWork: false, state: "open",
    });
    expect(result.protected).toBe(true);
  });

  it("protects issues with open linked PR", () => {
    const result = evaluateNeverTouch({
      labels: [], priority: "P3", severity: undefined,
      hasRecentHumanActivity: false, hasOpenLinkedPR: true,
      isExplicitlyAssigned: false, hasActiveEngineeringWork: false, state: "open",
    });
    expect(result.protected).toBe(true);
  });

  it("allows action on unprotected issues", () => {
    const result = evaluateNeverTouch({
      labels: ["bug"], priority: "P3", severity: "S3",
      hasRecentHumanActivity: false, hasOpenLinkedPR: false,
      isExplicitlyAssigned: false, hasActiveEngineeringWork: false, state: "open",
    });
    expect(result.protected).toBe(false);
    expect(result.reasons).toHaveLength(0);
  });

  it("detects human-set priority demotion", () => {
    expect(isHumanSetDemotion("priority", "P1", "P3", true)).toBe(true);
    expect(isHumanSetDemotion("priority", "P1", "P3", false)).toBe(false); // Not human-set
    expect(isHumanSetDemotion("priority", "P3", "P1", true)).toBe(false); // Promotion, not demotion
  });
});

describe("Action Classification", () => {
  it("classifies constructive actions correctly", () => {
    const cls = classifyAction("label.add");
    expect(cls.actionClass).toBe("constructive");
    expect(cls.requiresConfirmation).toBe(false);
    expect(canExecuteAutomatically("label.add")).toBe(true);
  });

  it("classifies delayed reversible with grace period", () => {
    const cls = classifyAction("close.not_observed");
    expect(cls.actionClass).toBe("delayed_reversible");
    expect(cls.gracePeriodMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(canExecuteAutomatically("close.not_observed")).toBe(true);
  });

  it("classifies human-gated actions", () => {
    const cls = classifyAction("bulk_close");
    expect(cls.actionClass).toBe("human_gated");
    expect(cls.requiresConfirmation).toBe(true);
    expect(canExecuteAutomatically("bulk_close")).toBe(false);
  });

  it("classifies prohibited actions", () => {
    expect(isProhibited("close.direct_ai")).toBe(true);
    expect(isProhibited("security.mutate")).toBe(true);
    expect(isProhibited("merge")).toBe(true);
    expect(isProhibited("label.add")).toBe(false);
  });

  it("unknown actions default to human-gated (conservative)", () => {
    const cls = classifyAction("unknown.action.xyz");
    expect(cls.actionClass).toBe("human_gated");
    expect(cls.requiresConfirmation).toBe(true);
  });

  it("getActionsByClass returns all actions of a class", () => {
    const prohibited = getActionsByClass("prohibited");
    expect(prohibited.length).toBeGreaterThanOrEqual(3);
    expect(prohibited.every((a) => a.actionClass === "prohibited")).toBe(true);
  });
});

describe("Run Budget Enforcer", () => {
  it("allows actions within budget", () => {
    const enforcer = new RunBudgetEnforcer({ ...DEFAULT_BUDGET_LIMITS });
    const result = enforcer.consume("issuesScanned");
    expect(result.allowed).toBe(true);
    expect(enforcer.getUsage().issuesScanned).toBe(1);
  });

  it("blocks actions that exceed budget", () => {
    const enforcer = new RunBudgetEnforcer({ ...DEFAULT_BUDGET_LIMITS, issuesModified: 2 });
    enforcer.consume("issuesModified");
    enforcer.consume("issuesModified");
    const result = enforcer.consume("issuesModified");
    expect(result.allowed).toBe(false);
    expect(enforcer.getUsage().issuesModified).toBe(2); // NOT incremented on rejection
  });

  it("reports warnings at 80% capacity", () => {
    const enforcer = new RunBudgetEnforcer({ ...DEFAULT_BUDGET_LIMITS, closuresScheduled: 5 });
    for (let i = 0; i < 4; i++) enforcer.consume("closuresScheduled");
    const warnings = enforcer.getWarnings();
    expect(warnings.length).toBe(1);
    expect(warnings[0].resource).toBe("closuresScheduled");
    expect(warnings[0].percentage).toBe(80);
  });

  it("isExhausted returns true when any budget hits limit", () => {
    const enforcer = new RunBudgetEnforcer({ ...DEFAULT_BUDGET_LIMITS, reproductionRunsPerDay: 1 });
    enforcer.consume("reproductionRuns");
    expect(enforcer.isExhausted()).toBe(true);
  });

  it("generates a digest with exhausted and warning resources", () => {
    const enforcer = new RunBudgetEnforcer({ ...DEFAULT_BUDGET_LIMITS, issuesModified: 3, closuresScheduled: 5 });
    for (let i = 0; i < 3; i++) enforcer.consume("issuesModified");
    for (let i = 0; i < 4; i++) enforcer.consume("closuresScheduled");
    const digest = enforcer.generateDigest();
    expect(digest.exhausted).toContain("issuesModified");
    expect(digest.warnings).toContain("closuresScheduled");
  });
});

describe("Manual Queue SLA", () => {
  it("calculates queue metrics correctly", () => {
    const items: ManualQueueItem[] = [
      { issueId: "1", issueNumber: 100, priority: "P2", enteredAt: new Date(Date.now() - 2 * 60 * 60 * 1000), status: "unowned" },
      { issueId: "2", issueNumber: 200, priority: "P1", enteredAt: new Date(Date.now() - 48 * 60 * 60 * 1000), status: "owned", assignedTo: "bob", firstResponseAt: new Date(Date.now() - 44 * 60 * 60 * 1000) },
      { issueId: "3", issueNumber: 300, enteredAt: new Date(Date.now() - 1 * 60 * 60 * 1000), status: "resolved", firstResponseAt: new Date(Date.now() - 0.5 * 60 * 60 * 1000), resolvedAt: new Date() },
    ];
    const { metrics } = evaluateManualQueue(items);
    expect(metrics.totalItems).toBe(2); // Only active items
    expect(metrics.unownedItems).toBe(1);
    expect(metrics.oldestItemAge).toBeGreaterThanOrEqual(47); // ~48 hours
  });

  it("triggers escalation for unowned items exceeding threshold", () => {
    const items: ManualQueueItem[] = [
      { issueId: "1", issueNumber: 100, enteredAt: new Date(Date.now() - 5 * 60 * 60 * 1000), status: "unowned" },
    ];
    const { escalations } = evaluateManualQueue(items);
    expect(escalations.length).toBeGreaterThanOrEqual(1);
    expect(escalations[0].rule.action).toBe("notify_lead");
    expect(escalations[0].message).toContain("#100");
  });

  it("triggers governance incident for 7-day untouched items", () => {
    const items: ManualQueueItem[] = [
      { issueId: "1", issueNumber: 100, enteredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), status: "unowned" },
    ];
    const { escalations } = evaluateManualQueue(items);
    const incident = escalations.find((e) => e.rule.action === "governance_incident");
    expect(incident).toBeDefined();
    expect(incident!.message).toContain("governance incident");
  });

  it("P1 untouched for 24h triggers escalation", () => {
    const items: ManualQueueItem[] = [
      { issueId: "1", issueNumber: 100, priority: "P1", enteredAt: new Date(Date.now() - 25 * 60 * 60 * 1000), status: "owned", assignedTo: "someone" },
    ];
    const { escalations } = evaluateManualQueue(items);
    const p1Esc = escalations.find((e) => e.rule.condition === "p1_untouched_hours");
    expect(p1Esc).toBeDefined();
  });

  it("resolved items are not included in active metrics", () => {
    const items: ManualQueueItem[] = [
      { issueId: "1", issueNumber: 100, enteredAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), status: "resolved", firstResponseAt: new Date(), resolvedAt: new Date() },
    ];
    const { metrics, escalations } = evaluateManualQueue(items);
    expect(metrics.totalItems).toBe(0);
    expect(escalations).toHaveLength(0);
  });
});
