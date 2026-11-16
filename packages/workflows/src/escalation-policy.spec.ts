import { describe, expect, it } from "vitest";
import { evaluateEscalation, remapCompleteCoverageClassification } from "./escalation-policy";

describe("escalation-policy", () => {
  it("routes incomplete lifecycle with human verification to BLOCKED_BY_OTP", () => {
    const result = evaluateEscalation({
      incompleteEvidence: true,
      outcomeKind: "blocked_human_verification",
      failureCode: "blocked_human_verification",
      lifecycleCoverage: {
        requiredStates: ["post_signup_authenticated", "dashboard_loaded"],
        reachedStates: ["signup_form", "post_signup_authenticated"],
        coverageComplete: false,
        missingStates: ["dashboard_loaded"],
        blockedBy: "otp",
      },
    });
    expect(result?.classification).toBe("BLOCKED_BY_OTP");
    expect(result?.escalationTarget).toBe("manual");
  });

  it("routes needsDynamicReproduction to the manual lane even when evidence is complete", () => {
    const result = evaluateEscalation({
      plausibleBug: true,
      needsDynamicReproduction: true,
      incompleteEvidence: false,
    });
    expect(result?.classification).toBe("NEEDS_MANUAL_INVESTIGATION");
    expect(result?.escalationTarget).toBe("manual");
  });

  it("does not escalate a simple judgment that needs no dynamic reproduction", () => {
    const result = evaluateEscalation(
      {
        plausibleBug: true,
        needsDynamicReproduction: false,
        incompleteEvidence: false,
      },
    );
    expect(result).toBeNull();
  });

  it("keeps KYC manual even when the judge asked for dynamic reproduction", () => {
    const result = evaluateEscalation(
      {
        needsDynamicReproduction: true,
        incompleteEvidence: true,
        failureCode: "blocked_kyc",
        lifecycleCoverage: {
          requiredStates: ["kyc_complete"],
          reachedStates: ["signup_form"],
          coverageComplete: false,
          missingStates: ["kyc_complete"],
          blockedBy: "kyc",
        },
      },
    );
    expect(result?.classification).toBe("BLOCKED_BY_KYC");
    expect(result?.escalationTarget).toBe("manual");
  });

  it("returns NOT_OBSERVED_WITH_COMPLETE_COVERAGE when lifecycle complete and bug not seen", () => {
    const remapped = remapCompleteCoverageClassification("CANNOT_REPRODUCE", {
      incompleteEvidence: false,
      outcomeKind: "bug_not_observed",
      reproduced: false,
      lifecycleCoverage: {
        requiredStates: ["post_signup_authenticated"],
        reachedStates: ["post_signup_authenticated"],
        coverageComplete: true,
        missingStates: [],
      },
    });
    expect(remapped).toBe("NOT_OBSERVED_WITH_COMPLETE_COVERAGE");
  });

  it("returns NEEDS_MANUAL_INVESTIGATION for generic incomplete lifecycle", () => {
    const result = evaluateEscalation({
      incompleteEvidence: true,
      outcomeKind: "blocked_external",
      reproduced: null,
      lifecycleCoverage: {
        requiredStates: ["post_signup_authenticated"],
        reachedStates: ["signup_form"],
        coverageComplete: false,
        missingStates: ["post_signup_authenticated"],
      },
    });
    expect(result?.classification).toBe("NEEDS_MANUAL_INVESTIGATION");
  });

  it("remaps CANNOT_REPRODUCE to NOT_OBSERVED_WITH_COMPLETE_COVERAGE when lifecycle complete", () => {
    const remapped = remapCompleteCoverageClassification("CANNOT_REPRODUCE", {
      incompleteEvidence: false,
      outcomeKind: "bug_not_observed",
      reproduced: false,
      lifecycleCoverage: {
        requiredStates: ["post_signup_authenticated"],
        reachedStates: ["post_signup_authenticated"],
        coverageComplete: true,
        missingStates: [],
      },
    });
    expect(remapped).toBe("NOT_OBSERVED_WITH_COMPLETE_COVERAGE");
  });
});
