/**
 * Parity test: automated, assisted and manual adapters produce
 * consistent policy behavior for the same issue state.
 *
 * Proves: regardless of which executor verifies an issue, the downstream
 * policy (auto-close, escalation) produces semantically equivalent decisions.
 */
import { describe, expect, it } from "vitest";
import {
  mapReproductionResultToVerification,
  mapAssistedResultToVerification,
  mapManualInvestigationToVerification,
} from "./verification-adapters";
import {
  evaluateVerificationAutoClose,
  evaluateVerificationEscalation,
} from "./verification-policy";
import { canNeverBecomeNegativeEvidence } from "./verification-contract";

const issue = {
  title: "Dashboard crashes after login",
  body: "After logging in, the dashboard shows blank white page",
};

describe("Verification parity: All adapters → same policy behavior", () => {
  describe("Bug confirmed (OBSERVED) → all adapters agree: cannot auto-close", () => {
    it("Automated: reproduced=true → OBSERVED → cannot close", () => {
      const r = mapReproductionResultToVerification(issue, {
        reproduced: true,
        outcomeKind: "bug_observed",
        scenarioFit: 0.9,
        lifecycleCoverage: { requiredStates: ["post_login_authenticated", "dashboard_loaded"], reachedStates: ["post_login_authenticated", "dashboard_loaded"], coverageComplete: true, missingStates: [] },
      }, true);
      expect(r.verdict).toBe("OBSERVED");
      expect(evaluateVerificationAutoClose(r).allowed).toBe(false);
      expect(evaluateVerificationEscalation(r).required).toBe(false);
    });

    it("Assisted: bugObserved=true → OBSERVED → cannot close", () => {
      const r = mapAssistedResultToVerification(issue, {
        externalId: "fc-1",
        status: "completed",
        bugObserved: true,
        stepsCompleted: ["post_login_authenticated", "dashboard_loaded"],
      });
      expect(r.verdict).toBe("OBSERVED");
      expect(evaluateVerificationAutoClose(r).allowed).toBe(false);
    });

    it("Manual: bugObserved=true → OBSERVED → cannot close", () => {
      const r = mapManualInvestigationToVerification(issue, {
        investigator: "qa-lead",
        bugObserved: true,
        stepsPerformed: ["Logged in", "Waited for TH"],
        statesReached: ["post_login_authenticated", "dashboard_loaded"],
        notes: "Confirmed white screen",
        confidence: 0.95,
      });
      expect(r.verdict).toBe("OBSERVED");
      expect(evaluateVerificationAutoClose(r).allowed).toBe(false);
    });
  });

  describe("Bug not observed with complete coverage → all adapters agree: can auto-close", () => {
    it("Automated: reproduced=false + complete → NOT_OBSERVED → can close", () => {
      const r = mapReproductionResultToVerification(issue, {
        reproduced: false,
        outcomeKind: "bug_not_observed",
        scenarioFit: 0.88,
        incompleteEvidence: false,
        lifecycleCoverage: { requiredStates: ["post_login_authenticated", "dashboard_loaded"], reachedStates: ["post_login_authenticated", "dashboard_loaded"], coverageComplete: true, missingStates: [] },
      }, false);
      expect(r.verdict).toBe("NOT_OBSERVED_COMPLETE_COVERAGE");
      expect(evaluateVerificationAutoClose(r).allowed).toBe(true);
    });

    it("Assisted: bugObserved=false + complete → NOT_OBSERVED → can close", () => {
      const r = mapAssistedResultToVerification(issue, {
        externalId: "fc-2",
        status: "completed",
        bugObserved: false,
        stepsCompleted: ["post_login_authenticated", "dashboard_loaded"],
      });
      expect(r.verdict).toBe("NOT_OBSERVED_COMPLETE_COVERAGE");
      expect(evaluateVerificationAutoClose(r).allowed).toBe(true);
    });

    it("Manual: bugObserved=false + complete → NOT_OBSERVED → can close", () => {
      const r = mapManualInvestigationToVerification(issue, {
        investigator: "qa-lead",
        bugObserved: false,
        stepsPerformed: ["Logged in", "TH loaded fine"],
        statesReached: ["post_login_authenticated", "dashboard_loaded"],
        notes: "Could not reproduce on latest build",
        confidence: 0.9,
      });
      expect(r.verdict).toBe("NOT_OBSERVED_COMPLETE_COVERAGE");
      expect(evaluateVerificationAutoClose(r).allowed).toBe(true);
    });
  });

  describe("Blocked / incomplete → all adapters agree: CANNOT auto-close, needs escalation", () => {
    it("Automated: blocked by OTP → INCONCLUSIVE → cannot close, escalates", () => {
      const r = mapReproductionResultToVerification(issue, {
        blockedBy: "otp",
        incompleteEvidence: true,
        lifecycleCoverage: { requiredStates: ["post_login_authenticated", "dashboard_loaded"], reachedStates: ["signup_form"], coverageComplete: false, missingStates: ["post_login_authenticated", "dashboard_loaded"] },
      }, null);
      expect(r.verdict).toBe("INCONCLUSIVE");
      expect(canNeverBecomeNegativeEvidence(r)).toBe(true);
      expect(evaluateVerificationAutoClose(r).allowed).toBe(false);
      expect(evaluateVerificationEscalation(r).required).toBe(true);
    });

    it("Assisted: failed → INCONCLUSIVE → cannot close, escalates", () => {
      const r = mapAssistedResultToVerification(issue, {
        externalId: "fc-3",
        status: "failed",
        bugObserved: null,
        stepsCompleted: [],
        blockedAt: "login_step",
      });
      expect(r.verdict).toBe("INCONCLUSIVE");
      expect(evaluateVerificationAutoClose(r).allowed).toBe(false);
      expect(evaluateVerificationEscalation(r).required).toBe(true);
    });

    it("Manual: incomplete coverage → INCONCLUSIVE → cannot close", () => {
      const r = mapManualInvestigationToVerification(issue, {
        investigator: "qa",
        bugObserved: false,
        stepsPerformed: ["Tried to login"],
        statesReached: [], // Did not reach required states
        notes: "Could not get past login",
        confidence: 0.3,
      });
      expect(r.verdict).toBe("INCONCLUSIVE");
      expect(evaluateVerificationAutoClose(r).allowed).toBe(false);
    });
  });

  describe("Unsupported → all sources agree: NEVER negative evidence, records capability gap", () => {
    it("Automated unsupported → UNSUPPORTED → never closes, escalates to manual", () => {
      const r = mapReproductionResultToVerification(issue, { outcomeKind: "unsupported" }, null);
      expect(r.verdict).toBe("UNSUPPORTED");
      expect(canNeverBecomeNegativeEvidence(r)).toBe(true);
      expect(evaluateVerificationAutoClose(r).allowed).toBe(false);
      expect(evaluateVerificationEscalation(r).target).toBe("manual");
    });

    it("Assisted null → UNSUPPORTED → never closes", () => {
      const r = mapAssistedResultToVerification(issue, null);
      expect(r.verdict).toBe("UNSUPPORTED");
      expect(evaluateVerificationAutoClose(r).allowed).toBe(false);
    });
  });

  describe("Safety invariant: infra failure is NEVER evidence", () => {
    it("Automated infra failure cannot auto-close regardless of any other field", () => {
      const r = mapReproductionResultToVerification(issue, {
        outcomeKind: "infra_failure",
        reproduced: false, // Even if reproduced=false, infra failure means the result is garbage
        scenarioFit: 0.99,
        lifecycleCoverage: { requiredStates: [], reachedStates: [], coverageComplete: true, missingStates: [] },
      }, false);
      // The safety rule catches infra_failure first
      expect(r.verdict).toBe("INCONCLUSIVE");
      expect(r.blockedBy).toBe("INFRA_FAILURE");
      expect(canNeverBecomeNegativeEvidence(r)).toBe(true);
      expect(evaluateVerificationAutoClose(r).allowed).toBe(false);
    });
  });
});
