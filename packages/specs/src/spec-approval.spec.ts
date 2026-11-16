import { describe, it, expect } from "vitest";
import { loadSpecPolicy } from "./load-spec-policy";
import {
  parseSpecApprovalAction,
  specApprovalBlocks,
  specLabelTransition,
  SPEC_APPROVAL_ACTION_PREFIX,
  SPEC_APPROVAL_ACTIONS,
} from "./spec-approval";

/**
 * The human approval surface.
 *
 * `approve_spec` is withheld from the model payload entirely, so these buttons
 * are the *only* way a spec can ever be approved. That makes the parsing here
 * load-bearing in an unusual way: the action payload is the sole carrier of
 * which revision the human actually looked at, and the service refuses when it
 * no longer matches. A parser that silently dropped the revision would turn the
 * stale-approval refusal into an approval of whatever exists now.
 */

const POLICY = loadSpecPolicy();

describe("approval blocks", () => {
  const blocks = specApprovalBlocks({
    specId: "spec-abc",
    revision: 2,
    title: "Retry failed deposits",
  });

  it("offers approval, revision, supersede, and discard controls", () => {
    const actions = blocks.find((b) => b.type === "actions") as {
      elements: Array<{ text: { text: string }; action_id: string }>;
    };
    expect(actions.elements.map((e) => e.text.text)).toEqual([
      "Approve",
      "Request changes",
      "Supersede",
      "Revise after approval",
      "Discard & restart",
    ]);
  });

  it("prefixes every action id so one route can claim them", () => {
    const actions = blocks.find((b) => b.type === "actions") as {
      elements: Array<{ action_id: string }>;
    };
    for (const element of actions.elements) {
      expect(element.action_id.startsWith(SPEC_APPROVAL_ACTION_PREFIX)).toBe(true);
    }
  });

  it("carries the spec id and the revision the human is looking at", () => {
    const actions = blocks.find((b) => b.type === "actions") as {
      elements: Array<{ value: string }>;
    };
    for (const element of actions.elements) {
      expect(JSON.parse(element.value)).toEqual({ specId: "spec-abc", revision: 2 });
    }
  });

  it("shows the revision in the message, so the button is not an unlabelled lever", () => {
    const section = blocks.find((b) => b.type === "section") as { text: { text: string } };
    expect(section.text.text).toContain("Retry failed deposits");
    expect(section.text.text).toContain("revision 2");
  });

  it("never renders a button whose action id collides with the lexi route", () => {
    const actions = blocks.find((b) => b.type === "actions") as {
      elements: Array<{ action_id: string }>;
    };
    for (const element of actions.elements) {
      expect(element.action_id.startsWith("lexi_")).toBe(false);
    }
  });
});

describe("parseSpecApprovalAction", () => {
  it("reads an approve click", () => {
    expect(
      parseSpecApprovalAction(SPEC_APPROVAL_ACTIONS.APPROVE, JSON.stringify({ specId: "s1", revision: 3 })),
    ).toEqual({ decision: "approve", specId: "s1", revision: 3 });
  });

  it("reads a request-changes click", () => {
    expect(
      parseSpecApprovalAction(
        SPEC_APPROVAL_ACTIONS.REQUEST_CHANGES,
        JSON.stringify({ specId: "s1", revision: 3 }),
      ),
    ).toEqual({ decision: "request_changes", specId: "s1", revision: 3 });
  });

  it("reads the human-only supersede and discard actions", () => {
    expect(
      parseSpecApprovalAction(SPEC_APPROVAL_ACTIONS.SUPERSEDE, JSON.stringify({ specId: "s1", revision: 3 })),
    ).toEqual({ decision: "supersede", specId: "s1", revision: 3 });
    expect(
      parseSpecApprovalAction(SPEC_APPROVAL_ACTIONS.DISCARD_AND_RESTART, JSON.stringify({ specId: "s1", revision: 3 })),
    ).toEqual({ decision: "discard_and_restart", specId: "s1", revision: 3 });
    expect(
      parseSpecApprovalAction(SPEC_APPROVAL_ACTIONS.REQUEST_CHANGES_AFTER_APPROVAL, JSON.stringify({ specId: "s1", revision: 3 })),
    ).toEqual({ decision: "request_changes_after_approval", specId: "s1", revision: 3 });
  });

  it("returns null for an unrelated action id", () => {
    expect(parseSpecApprovalAction("lexi_keep_open_12", "{}")).toBeNull();
  });

  it("returns null rather than guessing when the payload is malformed", () => {
    for (const raw of ["", "not json", "{}", JSON.stringify({ specId: "s1" }), JSON.stringify({ revision: 1 })]) {
      expect(parseSpecApprovalAction(SPEC_APPROVAL_ACTIONS.APPROVE, raw), raw).toBeNull();
    }
  });

  it("refuses a non-integer or non-positive revision instead of coercing it", () => {
    for (const revision of [0, -1, 1.5, "2", null]) {
      expect(
        parseSpecApprovalAction(SPEC_APPROVAL_ACTIONS.APPROVE, JSON.stringify({ specId: "s1", revision })),
        String(revision),
      ).toBeNull();
    }
  });
});

describe("specLabelTransition", () => {
  it("flips spec:draft to spec:approved on approval", () => {
    const transition = specLabelTransition(["type:spec", "spec:draft"], "APPROVED", POLICY);
    expect(transition.labels).toEqual(["type:spec", "spec:approved"]);
    expect(transition.added).toEqual(["spec:approved"]);
    expect(transition.removed).toEqual(["spec:draft"]);
  });

  it("returns a spec to spec:draft when changes are requested", () => {
    const transition = specLabelTransition(["type:spec", "spec:approved"], "DRAFTING", POLICY);
    expect(transition.labels).toEqual(["type:spec", "spec:draft"]);
    expect(transition.added).toEqual(["spec:draft"]);
    expect(transition.removed).toEqual(["spec:approved"]);
  });

  it("preserves unrelated labels — a spec may carry team or platform tags", () => {
    const transition = specLabelTransition(
      ["team:home", "type:spec", "spec:draft", "platform:mobile"],
      "APPROVED",
      POLICY,
    );
    expect(transition.labels).toEqual(["team:home", "type:spec", "platform:mobile", "spec:approved"]);
  });

  it("is idempotent — re-approving reports no change rather than duplicating a label", () => {
    const transition = specLabelTransition(["type:spec", "spec:approved"], "APPROVED", POLICY);
    expect(transition.labels).toEqual(["type:spec", "spec:approved"]);
    expect(transition.added).toEqual([]);
    expect(transition.removed).toEqual([]);
  });
});

/**
 * Surfacing the tier.
 *
 * The two-person rule is invisible at the point of decision unless the message
 * says why it applies. An approver refused for self-approving a spec they
 * believed was trivial has been given no way to tell whether the refusal was
 * right — so the tier, including the *absence* of one, is stated on the card.
 */
describe("risk tier on the approval card", () => {
  function text(args: Parameters<typeof specApprovalBlocks>[0]): string {
    const section = specApprovalBlocks(args).find((b) => b.type === "section") as {
      text: { text: string };
    };
    return section.text.text;
  }

  it("states the tier when the spec carries one", () => {
    expect(text({ specId: "s1", revision: 1, title: "T", riskTier: "low" })).toContain("Risk tier: low");
  });

  it("says the tier is unclassified rather than saying nothing at all", () => {
    const rendered = text({ specId: "s1", revision: 1, title: "T" });

    // Silence reads as "no risk". An absent tier is the case where the gate is
    // STRICTEST, so it is the case that most needs explaining.
    expect(rendered).toMatch(/Risk tier/i);
    expect(rendered).toMatch(/unclassified/i);
  });

  it("names the tier the gate will substitute for an unclassified spec", () => {
    const rendered = text({
      specId: "s1",
      revision: 1,
      title: "T",
      defaultRiskTier: "high",
    });
    expect(rendered).toMatch(/high/);
  });

  it("explains that a second approver is needed, when one is", () => {
    const rendered = text({
      specId: "s1",
      revision: 1,
      title: "T",
      riskTier: "critical",
      twoPersonRuleApplies: true,
    });
    expect(rendered).toMatch(/second/i);
  });

  it("says self-approval is allowed when the tier sits below the rule", () => {
    const rendered = text({
      specId: "s1",
      revision: 1,
      title: "T",
      riskTier: "low",
      twoPersonRuleApplies: false,
    });
    expect(rendered).toMatch(/self-approv/i);
  });
});
