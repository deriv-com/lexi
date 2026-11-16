/**
 * Feature policy family.
 *
 * The governance *chassis* — action classes, budgets, the mutation guard — is
 * domain-agnostic and needs no feature variant. The *vocabulary* is not: a
 * feature has no priority label to protect, no severity to compare, and
 * nothing to reproduce. These tests pin the vocabulary split, and pin that the
 * chassis was not forked to achieve it.
 */
import { describe, it, expect } from "vitest";
import {
  loadFeaturePolicy,
  featurePolicySchema,
  type FeaturePolicy,
} from "./feature-policy.schema";
import {
  evaluateRequiredFields,
  evaluateWorkItemNeverTouch,
  WORK_ITEM_GUARD_REASONS,
  type WorkItemNeverTouchInput,
} from "./work-item-guard";
import { classifyAction } from "../blast-radius/action-classification";

function policy(): FeaturePolicy {
  return loadFeaturePolicy();
}

function workItem(overrides: Partial<WorkItemNeverTouchInput> = {}): WorkItemNeverTouchInput {
  return {
    kind: "feature",
    status: "IN_PROGRESS",
    hasRecentHumanActivity: false,
    hasOpenLinkedPR: false,
    isExplicitlyAssigned: false,
    hasApprovedSpec: true,
    hasDependentWorkItems: false,
    ...overrides,
  };
}

describe("feature-policy.yaml — the shipped configuration", () => {
  it("parses the committed file", () => {
    expect(policy().version).toBe("1.0.0");
  });

  it("ships disabled (flags default off)", () => {
    expect(policy().enabled).toBe(false);
  });

  it("keeps the four work-item kinds and the frozen status list", () => {
    const loaded = policy();
    expect(loaded.workItems.kinds).toEqual(["bug", "feature", "chore", "spec"]);
    expect(loaded.workItems.statuses).toContain("PROPOSED");
    expect(loaded.workItems.statuses).toContain("VERIFIED");
    expect(loaded.workItems.terminalStatuses).toEqual(["VERIFIED", "CANCELLED"]);
  });

  it("still requires an approved spec before a feature dispatches", () => {
    expect(policy().dispatch.requireApprovedSpecForFeature).toBe(true);
  });
});

describe("required fields — the bug-coupled vocabulary, per kind", () => {
  it("requires reproduction of a bug and of nothing else", () => {
    const loaded = policy();
    expect(loaded.vocabulary.requiredFields.bug).toContain("reproduction");
    expect(loaded.vocabulary.requiredFields.feature).not.toContain("reproduction");
    expect(loaded.vocabulary.requiredFields.chore).not.toContain("reproduction");
  });

  it("requires a spec reference and acceptance criteria of a feature", () => {
    const fields = policy().vocabulary.requiredFields.feature;
    expect(fields).toContain("specId");
    expect(fields).toContain("acceptanceCriteria");
  });

  it("requires a concrete target and a definition of done of a chore", () => {
    // What replaces reproduction evidence for work with nothing broken: the
    // thing that keeps scope honest is naming the target and saying what done
    // looks like.
    const fields = policy().vocabulary.requiredFields.chore;
    expect(fields).toContain("target");
    expect(fields).toContain("definitionOfDone");
    expect(fields).not.toContain("specId");
  });

  it("reports the missing fields for a feature with no spec", () => {
    const result = evaluateRequiredFields(
      "feature",
      { acceptanceCriteria: "Cart total updates within 200ms" },
      policy(),
    );
    expect(result.satisfied).toBe(false);
    expect(result.missing).toContain("specId");
    expect(result.missing).not.toContain("acceptanceCriteria");
  });

  it("passes a fully specified feature", () => {
    const result = evaluateRequiredFields(
      "feature",
      { specId: "spec-42", acceptanceCriteria: "Cart total updates within 200ms" },
      policy(),
    );
    expect(result.satisfied).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("treats blank and whitespace-only values as missing", () => {
    const result = evaluateRequiredFields("chore", { target: "   ", definitionOfDone: "" }, policy());
    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining(["target", "definitionOfDone"]));
  });

  it("fails closed on an unknown kind rather than requiring nothing", () => {
    // An unrecognised kind must not be the cheapest way past the gate.
    const result = evaluateRequiredFields("wildly-unknown" as never, {}, policy());
    expect(result.satisfied).toBe(false);
    expect(result.reasons).toContain(WORK_ITEM_GUARD_REASONS.UNKNOWN_KIND);
  });
});

describe("never-touch — the feature variant", () => {
  it("protects a work item in a terminal status", () => {
    const result = evaluateWorkItemNeverTouch(workItem({ status: "VERIFIED" }), policy());
    expect(result.protected).toBe(true);
    expect(result.reasons.some((r) => r.includes("terminal"))).toBe(true);
  });

  it("protects a work item with dependents", () => {
    // A feature other items are broken down from is not something automation
    // rewrites underneath them.
    const result = evaluateWorkItemNeverTouch(workItem({ hasDependentWorkItems: true }), policy());
    expect(result.protected).toBe(true);
  });

  it("protects a work item with recent human activity or an open PR", () => {
    expect(evaluateWorkItemNeverTouch(workItem({ hasRecentHumanActivity: true }), policy()).protected).toBe(true);
    expect(evaluateWorkItemNeverTouch(workItem({ hasOpenLinkedPR: true }), policy()).protected).toBe(true);
  });

  it("leaves an ordinary in-progress feature unprotected", () => {
    const result = evaluateWorkItemNeverTouch(workItem(), policy());
    expect(result.protected).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("does not consult priority or severity for a feature", () => {
    // The bug vocabulary must not leak: a feature carries no P0/S1, and
    // inventing one would protect or expose items arbitrarily.
    const withBugVocabulary = {
      ...workItem(),
      // deliberately supplying bug-shaped fields the feature variant ignores
      priority: "P0",
      severity: "S1",
    } as WorkItemNeverTouchInput & { priority: string; severity: string };
    expect(evaluateWorkItemNeverTouch(withBugVocabulary, policy()).protected).toBe(false);
  });

  it("fails closed on an unknown status", () => {
    const result = evaluateWorkItemNeverTouch(workItem({ status: "SOMETHING_ELSE" }), policy());
    expect(result.protected).toBe(true);
    expect(result.reasons.some((r) => r.includes("Unknown status"))).toBe(true);
  });

  it("fails closed on an unknown kind", () => {
    const result = evaluateWorkItemNeverTouch(workItem({ kind: "gadget" as never }), policy());
    expect(result.protected).toBe(true);
  });
});

describe("the chassis was generalised, not forked", () => {
  it("classifies work-item actions through the one action-classification table", () => {
    // No parallel classification table exists for work items — the same
    // function answers for label.add and work_item.create.
    expect(classifyAction("work_item.create").actionClass).toBe("constructive");
    expect(classifyAction("label.add").actionClass).toBe("constructive");
  });

  it("keeps the bug never-touch policy reachable and unchanged", async () => {
    const { evaluateNeverTouch } = await import("../blast-radius/never-touch-policy");
    const bugResult = evaluateNeverTouch({
      labels: [],
      priority: "P0",
      severity: undefined,
      hasRecentHumanActivity: false,
      hasOpenLinkedPR: false,
      isExplicitlyAssigned: false,
      hasActiveEngineeringWork: false,
      state: "open",
    });
    // P0 still protects a BUG — the feature variant did not replace it.
    expect(bugResult.protected).toBe(true);
  });

  it("uses config, not literals, for the terminal statuses it protects", () => {
    const custom = featurePolicySchema.parse({
      ...policy(),
      workItems: { ...policy().workItems, terminalStatuses: ["CANCELLED"] },
    });
    // VERIFIED is no longer terminal under this config, so it is no longer
    // protected on that ground.
    expect(evaluateWorkItemNeverTouch(workItem({ status: "VERIFIED" }), custom).protected).toBe(false);
    expect(evaluateWorkItemNeverTouch(workItem({ status: "CANCELLED" }), custom).protected).toBe(true);
  });
});
