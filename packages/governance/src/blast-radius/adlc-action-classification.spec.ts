/**
 * Spec-pipeline action classes.
 *
 * Kept in its own file rather than appended to blast-radius.spec.ts so the
 * pre-existing classification contract and the spec-pipeline additions fail
 * independently — if a later change breaks "unknown defaults to human-gated",
 * the failure names which of the two suites regressed.
 */
import { describe, it, expect } from "vitest";
import {
  classifyAction,
  canExecuteAutomatically,
  isProhibited,
  getActionsByClass,
  ADLC_ACTIONS,
} from "./action-classification";
import { evaluateMutationGuard, type MutationGuardInput } from "./mutation-guard";

/** An issue state with nothing protected — isolates the action class itself. */
const unprotectedState: MutationGuardInput["currentIssueState"] = {
  labels: [],
  priority: "P3",
  severity: "S3",
  hasRecentHumanActivity: false,
  hasOpenLinkedPR: false,
  isExplicitlyAssigned: false,
  hasActiveEngineeringWork: false,
  state: "open",
};

describe("ADLC action classification — spec lifecycle", () => {
  it.each(["spec.create", "spec.revise", "spec.submit_review"])(
    "classifies %s as constructive",
    (action) => {
      const cls = classifyAction(action);
      expect(cls.actionClass).toBe("constructive");
      expect(cls.requiresConfirmation).toBe(false);
      expect(cls.gracePeriodMs).toBe(0);
      expect(canExecuteAutomatically(action)).toBe(true);
    },
  );

  it.each(["spec.approve", "spec.supersede"])("classifies %s as human-gated", (action) => {
    const cls = classifyAction(action);
    expect(cls.actionClass).toBe("human_gated");
    expect(cls.requiresConfirmation).toBe(true);
    expect(canExecuteAutomatically(action)).toBe(false);
  });

  it("classifies work_item.create as constructive", () => {
    const cls = classifyAction("work_item.create");
    expect(cls.actionClass).toBe("constructive");
    expect(canExecuteAutomatically("work_item.create")).toBe(true);
  });

  it("does not make any ADLC action prohibited", () => {
    // Prohibition is reserved for merge/security/direct-AI-close. A spec that
    // can never be approved is a spec pipeline that cannot complete.
    for (const action of ADLC_ACTIONS) {
      expect(isProhibited(action)).toBe(false);
    }
  });

  it("exposes every ADLC action through the classification table", () => {
    for (const action of ADLC_ACTIONS) {
      const cls = classifyAction(action);
      // A table miss returns the synthesised unknown-action fallback, whose
      // description carries this marker. Catching it here is what proves the
      // action is genuinely registered rather than accidentally defaulting.
      expect(cls.description).not.toContain("defaulting to human-gated");
      expect(cls.action).toBe(action);
    }
  });
});

describe("ADLC action classification — preserved invariants", () => {
  it("still defaults unknown actions to human-gated", () => {
    const cls = classifyAction("spec.destroy_everything");
    expect(cls.actionClass).toBe("human_gated");
    expect(cls.requiresConfirmation).toBe(true);
    expect(canExecuteAutomatically("spec.destroy_everything")).toBe(false);
  });

  it("defaults an unknown work_item action to human-gated", () => {
    // work_item.create is registered; its siblings deliberately are not, and
    // must not inherit its constructive class by prefix.
    expect(classifyAction("work_item.delete").actionClass).toBe("human_gated");
    expect(classifyAction("work_item.cancel").actionClass).toBe("human_gated");
  });

  it("keeps every classification's action field equal to its table key", () => {
    const all = (["constructive", "delayed_reversible", "human_gated", "prohibited"] as const).flatMap(
      (cls) => getActionsByClass(cls),
    );
    for (const entry of all) {
      expect(classifyAction(entry.action).actionClass).toBe(entry.actionClass);
    }
  });

  it("keeps the original classifications untouched", () => {
    expect(classifyAction("label.add").actionClass).toBe("constructive");
    expect(classifyAction("close.duplicate").actionClass).toBe("delayed_reversible");
    expect(classifyAction("bulk_close").actionClass).toBe("human_gated");
    expect(classifyAction("merge").actionClass).toBe("prohibited");
  });
});

describe("ADLC action classes through the mutation guard", () => {
  const guardInput = (action: string, actorIsHuman: boolean): MutationGuardInput => ({
    action,
    actorId: actorIsHuman ? "U123" : "system",
    actorIsHuman,
    currentIssueState: unprotectedState,
    writesEnabled: true,
  });

  it("lets automation create a spec", () => {
    const decision = evaluateMutationGuard(guardInput("spec.create", false));
    expect(decision.allowed).toBe(true);
    expect(decision.actionClass).toBe("constructive");
  });

  it("refuses automation approving a spec", () => {
    const decision = evaluateMutationGuard(guardInput("spec.approve", false));
    expect(decision.allowed).toBe(false);
    expect(decision.actionClass).toBe("human_gated");
    expect(decision.requiredApproval).toBe("human_confirmation");
  });

  it("refuses automation superseding a spec", () => {
    const decision = evaluateMutationGuard(guardInput("spec.supersede", false));
    expect(decision.allowed).toBe(false);
    expect(decision.actionClass).toBe("human_gated");
  });

  it("still refuses every ADLC action when the global write gate is off", () => {
    for (const action of ADLC_ACTIONS) {
      const decision = evaluateMutationGuard({ ...guardInput(action, true), writesEnabled: false });
      expect(decision.allowed).toBe(false);
      expect(decision.matchedRules).toContain("write_gate_disabled");
    }
  });
});
