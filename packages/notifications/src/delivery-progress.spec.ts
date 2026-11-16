import { describe, it, expect } from "vitest";
import {
  deliveryProgress,
  evaluateVerification,
  isDeliveryComplete,
  verificationModeFor,
  type DeploymentEvidence,
  type LinkedPullRequest,
} from "./delivery-progress";

/**
 * Two delivery-tracking bugs this module exists to fix:
 *
 *   1. Retest fires on *any* merged linked PR. A fix split across a backend PR
 *      and a frontend PR is declared delivered the moment the first one lands,
 *      so the bug is retested against half a fix and comes back "still
 *      reproducible" — which reads as the fix having failed.
 *   2. Features are verified by bug retest. "Is it still reproducible?" is a
 *      meaningless question about a feature that never had a defect to
 *      reproduce, so a feature can never legitimately reach VERIFIED that way.
 */

const NOW = new Date("2026-08-15T12:00:00.000Z");

function pr(number: number, state: LinkedPullRequest["state"]): LinkedPullRequest {
  return { number, state, merged: state === "merged" };
}

function deployment(overrides: Partial<DeploymentEvidence> = {}): DeploymentEvidence {
  return {
    releaseVersion: "v1.2.3",
    repository: "acme/web-app",
    environment: "production",
    status: "success",
    deployedAt: NOW,
    ...overrides,
  };
}

describe("isDeliveryComplete — multi-PR awareness", () => {
  it("is not complete with no linked PRs at all", () => {
    expect(isDeliveryComplete({ linkedPrs: [] })).toBe(false);
  });

  it("is complete for the single-PR case", () => {
    expect(isDeliveryComplete({ linkedPrs: [pr(1, "merged")] })).toBe(true);
  });

  // The regression: today `linkedPrs.some(pr => pr.merged)` says yes here.
  it("is NOT complete when one of two linked PRs is still open", () => {
    expect(isDeliveryComplete({ linkedPrs: [pr(1, "merged"), pr(2, "open")] })).toBe(false);
  });

  it("is complete once every linked PR is merged", () => {
    expect(isDeliveryComplete({ linkedPrs: [pr(1, "merged"), pr(2, "merged")] })).toBe(true);
  });

  it("is not complete when every linked PR is still open", () => {
    expect(isDeliveryComplete({ linkedPrs: [pr(1, "open"), pr(2, "open")] })).toBe(false);
  });

  // An abandoned PR must not block delivery forever — it is no longer part of
  // the fix, unlike an open one which is still expected to land.
  it("ignores a PR closed without merging", () => {
    expect(isDeliveryComplete({ linkedPrs: [pr(1, "merged"), pr(2, "closed")] })).toBe(true);
  });

  it("is not complete when every PR was closed unmerged — nothing shipped", () => {
    expect(isDeliveryComplete({ linkedPrs: [pr(1, "closed"), pr(2, "closed")] })).toBe(false);
  });

  it("honours an explicit primary PR and ignores the rest", () => {
    const linkedPrs = [pr(1, "merged"), pr(2, "open")];

    expect(isDeliveryComplete({ linkedPrs, primaryPrNumber: 1 })).toBe(true);
  });

  it("is not complete when the explicit primary PR is still open", () => {
    const linkedPrs = [pr(1, "merged"), pr(2, "open")];

    expect(isDeliveryComplete({ linkedPrs, primaryPrNumber: 2 })).toBe(false);
  });

  it("falls back to the all-merged rule when the primary PR is not among the linked PRs", () => {
    const linkedPrs = [pr(1, "merged"), pr(2, "open")];

    expect(isDeliveryComplete({ linkedPrs, primaryPrNumber: 99 })).toBe(false);
  });

  it("can be reduced to the legacy any-merged rule when explicitly asked", () => {
    const linkedPrs = [pr(1, "merged"), pr(2, "open")];

    expect(isDeliveryComplete({ linkedPrs, requireAllLinkedPrsMerged: false })).toBe(true);
  });
});

describe("deliveryProgress", () => {
  it("reports which PRs are still pending so a nudge can name them", () => {
    const progress = deliveryProgress({ linkedPrs: [pr(1, "merged"), pr(2, "open"), pr(3, "closed")] });

    expect(progress.stage).toBe("partially_merged");
    expect(progress.mergedPrNumbers).toEqual([1]);
    expect(progress.pendingPrNumbers).toEqual([2]);
    expect(progress.abandonedPrNumbers).toEqual([3]);
  });

  it("reports no_prs when nothing is linked", () => {
    expect(deliveryProgress({ linkedPrs: [] }).stage).toBe("no_prs");
  });

  it("reports in_progress when work has started but nothing has merged", () => {
    expect(deliveryProgress({ linkedPrs: [pr(1, "open")] }).stage).toBe("in_progress");
  });

  it("reports delivered once the completion rule is satisfied", () => {
    expect(deliveryProgress({ linkedPrs: [pr(1, "merged"), pr(2, "merged")] }).stage).toBe("delivered");
  });
});

describe("verificationModeFor", () => {
  it("verifies a bug by retest", () => {
    expect(verificationModeFor("bug")).toBe("retest");
  });

  it("verifies a feature by deployment record", () => {
    expect(verificationModeFor("feature")).toBe("deployment_record");
  });

  it("verifies chores and specs by deployment record too — none of them have a defect to reproduce", () => {
    expect(verificationModeFor("chore")).toBe("deployment_record");
    expect(verificationModeFor("spec")).toBe("deployment_record");
  });
});

describe("evaluateVerification", () => {
  it("verifies a bug whose retest no longer reproduces it", () => {
    const result = evaluateVerification({ kind: "bug", retest: { reproduced: false, complete: true } });

    expect(result.verified).toBe(true);
    expect(result.mode).toBe("retest");
  });

  it("does not verify a bug that still reproduces", () => {
    const result = evaluateVerification({ kind: "bug", retest: { reproduced: true, complete: true } });

    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/still reproduc/i);
  });

  it("does not verify a bug on an incomplete retest", () => {
    const result = evaluateVerification({ kind: "bug", retest: { reproduced: false, complete: false } });

    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/incomplete|coverage/i);
  });

  // The branch this whole module is for.
  it("NEVER verifies a feature from a retest, however clean that retest is", () => {
    const result = evaluateVerification({ kind: "feature", retest: { reproduced: false, complete: true } });

    expect(result.verified).toBe(false);
    expect(result.mode).toBe("deployment_record");
    expect(result.reason).toMatch(/retest/i);
  });

  it("verifies a feature from a successful production deployment record", () => {
    const result = evaluateVerification({ kind: "feature", deployments: [deployment()] });

    expect(result.verified).toBe(true);
    expect(result.mode).toBe("deployment_record");
    expect(result.evidence?.releaseVersion).toBe("v1.2.3");
  });

  it("does not verify a feature from a failed deployment", () => {
    const result = evaluateVerification({ kind: "feature", deployments: [deployment({ status: "failed" })] });

    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/deployment/i);
  });

  it("does not verify a feature from a non-production deployment", () => {
    const result = evaluateVerification({ kind: "feature", deployments: [deployment({ environment: "staging" })] });

    expect(result.verified).toBe(false);
  });

  it("accepts a non-production deployment when the caller widens the environment", () => {
    const result = evaluateVerification({
      kind: "feature",
      deployments: [deployment({ environment: "staging" })],
      environments: ["staging", "production"],
    });

    expect(result.verified).toBe(true);
  });

  it("does not verify a feature with no deployment evidence at all", () => {
    const result = evaluateVerification({ kind: "feature", deployments: [] });

    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/no deployment/i);
  });

  it("picks the most recent qualifying deployment as its evidence", () => {
    const older = deployment({ releaseVersion: "v1.0.0", deployedAt: new Date("2026-08-01T00:00:00.000Z") });
    const newer = deployment({ releaseVersion: "v2.0.0", deployedAt: new Date("2026-08-14T00:00:00.000Z") });

    const result = evaluateVerification({ kind: "feature", deployments: [older, newer] });

    expect(result.evidence?.releaseVersion).toBe("v2.0.0");
  });

  it("filters deployment evidence to the repository the work landed in", () => {
    const result = evaluateVerification({
      kind: "feature",
      deployments: [deployment({ repository: "acme/web-app" })],
      repository: "acme-internal/mobile-app",
    });

    expect(result.verified).toBe(false);
  });
});
