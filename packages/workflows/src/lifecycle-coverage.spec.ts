import { describe, expect, it } from "vitest";
import {
  enrichResultDetailsWithLifecycle,
  inferRequiredLifecycleStates,
  lifecycleAutoCloseBlockReason,
  mergeLifecycleCoverage,
} from "./lifecycle-coverage";
import { evaluateAutoClose } from "./auto-close-policy";

describe("lifecycle-coverage", () => {
  it("infers post_signup_authenticated from after signup phrasing", () => {
    const states = inferRequiredLifecycleStates(
      "[P2] Console errors for Novu and Intercom on signup",
      "After signing up to demo, Novu and Intercom console errors.",
    );
    expect(states).toContain("post_signup_authenticated");
  });

  it("marks incomplete when only signup form evidence exists for post-signup issue", () => {
    const issue = {
      title: "[P2] Console errors for Novu and Intercom on signup",
      body: "After signing up to demo, Novu and Intercom console errors.",
    };
    const details = {
      scenarioFit: 1,
      outcomeKind: "bug_not_observed",
      reproduced: false,
      incompleteEvidence: false,
      evidence: [
        { type: "screenshot", url: "http://localhost/landing.png", description: "landing" },
        { type: "screenshot", url: "http://localhost/signup_form.png", description: "signup_form" },
      ],
    };
    const enriched = enrichResultDetailsWithLifecycle(issue, details);
    expect(enriched?.incompleteEvidence).toBe(true);
    expect(enriched?.lifecycleCoverage).toMatchObject({
      coverageComplete: false,
      missingStates: expect.arrayContaining(["post_signup_authenticated"]),
    });

    const policy = evaluateAutoClose({
      classification: "CANNOT_REPRODUCE",
      decisionConfidence: 0.9,
      resultDetails: enriched,
    });
    expect(policy.allowed).toBe(false);
    expect(policy.reason).toContain("post-signup state was not reached");
  });

  it("builds explicit block reason for missing post-signup state", () => {
    const reason = lifecycleAutoCloseBlockReason({
      requiredStates: ["post_signup_authenticated"],
      reachedStates: ["signup_form"],
      coverageComplete: false,
      missingStates: ["post_signup_authenticated"],
    });
    expect(reason).toContain("signup form");
  });

  it("allows auto-close when lifecycle coverage is complete", () => {
    const lifecycle = mergeLifecycleCoverage(
      { title: "After signup bug", body: "after signup demo errors" },
      {
        lifecycleCoverage: {
          requiredStates: ["post_signup_authenticated"],
          reachedStates: ["post_signup_authenticated", "dashboard_loaded"],
          coverageComplete: true,
          missingStates: [],
        },
        scenarioFit: 0.9,
        outcomeKind: "bug_not_observed",
        reproduced: false,
      },
    );
    expect(lifecycle.coverageComplete).toBe(true);
    const policy = evaluateAutoClose({
      classification: "CANNOT_REPRODUCE",
      decisionConfidence: 0.9,
      resultDetails: {
        lifecycleCoverage: lifecycle,
        incompleteEvidence: false,
        scenarioFit: 0.9,
        outcomeKind: "bug_not_observed",
        reproduced: false,
      },
    });
    expect(policy.allowed).toBe(true);
  });
});
