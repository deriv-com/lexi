import { describe, it, expect } from "vitest";
import { loadProgrammePolicy, parseProgrammePolicy, programmeWorkingBranch, repoSettingsFor } from "./load-programme-policy";

describe("loadProgrammePolicy", () => {
  it("loads and validates the example policy file", () => {
    // GOVERNANCE_CONFIG_DIR points at examples/config under vitest.
    const policy = loadProgrammePolicy();
    expect(policy.version).toBe(1);
    expect(policy.programmes.allowedRepoKeys).toEqual(["acme_web_rebuild"]);
    // The gate never relaxes: every phase, every check, AC matrix, SHA.
    expect(policy.autoMerge.requiredEvidencePhases).toEqual(["red", "green", "checks"]);
    expect(policy.autoMerge.requireAcMatrixGreen).toBe(true);
    expect(policy.autoMerge.requireHeadShaMatch).toBe(true);
    // Escalation needs distinct rungs, and a per-kind override must itself
    // be a rung: a repeated rung or a stray override breaks escalation
    // silently.
    expect(policy.dispatch.modelLadder.length).toBeGreaterThanOrEqual(1);
    expect(new Set(policy.dispatch.modelLadder).size).toBe(policy.dispatch.modelLadder.length);
    for (const model of Object.values(policy.dispatch.modelByTaskKind)) {
      expect(policy.dispatch.modelLadder).toContain(model);
    }
    // Auth is a separate origin from the core API, and the two must not
    // collapse onto one host — an auth flow pointed at the API host fails
    // looking like a broken login rather than a wrong hostname.
    expect(policy.apiContract?.baseUrl).toMatch(/^https:\/\//);
    expect(policy.apiContract?.authBaseUrl).toMatch(/^https:\/\//);
    expect(policy.apiContract?.authBaseUrl).not.toBe(policy.apiContract?.baseUrl);
    expect(repoSettingsFor(policy, "acme_web_rebuild").workingBranchPrefix).toBe("rebuild/");
  });

  it("defaults every enablement to OFF when keys are absent", () => {
    const policy = parseProgrammePolicy("version: 1\n");
    expect(policy.enabled).toBe(false);
    expect(policy.autoMerge.enabled).toBe(false);
    expect(policy.autoMerge.requireAcMatrixGreen).toBe(true);
    expect(policy.autoMerge.requireHeadShaMatch).toBe(true);
    expect(policy.dispatch.maxTaskAttempts).toBe(3);
    expect(policy.dispatch.modelLadder).toEqual([]);
    expect(policy.hardening.requireZeroOpenFindings).toBe(true);
    // A policy that says nothing about review gets the HUMAN gate per
    // milestone and still demands the sweep — autopilot is opt-in.
    expect(policy.milestoneReview.mode).toBe("gate");
    expect(policy.milestoneReview.requireExploratorySweep).toBe(true);
    expect(policy.designSources.allowedFileKeys).toEqual([]);
    expect(policy.referenceRepos).toEqual({});
  });

  it("refuses an unknown review mode rather than guessing at the gate", () => {
    expect(() =>
      parseProgrammePolicy(["version: 1", "milestoneReview:", "  mode: yolo"].join("\n")),
    ).toThrow(/Invalid programme policy/);
  });

  it("refuses an unknown evidence phase rather than widening the gate", () => {
    expect(() =>
      parseProgrammePolicy(
        ["version: 1", "autoMerge:", "  requiredEvidencePhases: [red, purple]"].join("\n"),
      ),
    ).toThrow(/Invalid programme policy/);
  });
});

describe("programmes.repoSettings (working-branch programmes)", () => {
  const base = ["version: 1", "programmes:", "  allowedRepoKeys: [acme_web]"];

  it("defaults to the default branch, a required sweep, no technical spec and no tracking issue", () => {
    const policy = parseProgrammePolicy(base.join("\n"));
    expect(repoSettingsFor(policy, "acme_web")).toEqual({
      baseBranch: null,
      workingBranchPrefix: null,
      requireExploratorySweep: true,
      requireTechnicalSpec: false, existingTechnicalSpecPath: null,
      autoMergeMilestoneTechnicalSpecs: false,
      autoPlanQueuedMilestones: false,
      featureSpecDir: null,
      trackingIssue: false,
    });
    expect(repoSettingsFor(policy, "unknown")).toEqual({
      baseBranch: null,
      workingBranchPrefix: null,
      requireExploratorySweep: true,
      requireTechnicalSpec: false, existingTechnicalSpecPath: null,
      autoMergeMilestoneTechnicalSpecs: false,
      autoPlanQueuedMilestones: false,
      featureSpecDir: null,
      trackingIssue: false,
    });
  });

  it("reads a repo's settings and lets the per-repo sweep flag override the global one", () => {
    const policy = parseProgrammePolicy(
      [
        ...base,
        "  repoSettings:",
        "    acme_web:",
        "      baseBranch: feat/web-rebuild",
        "      requireExploratorySweep: false",
        "      requireTechnicalSpec: true",
        "      trackingIssue: true",
        "milestoneReview:",
        "  requireExploratorySweep: true",
      ].join("\n"),
    );
    expect(repoSettingsFor(policy, "acme_web")).toEqual({
      baseBranch: "feat/web-rebuild",
      workingBranchPrefix: null,
      requireExploratorySweep: false,
      requireTechnicalSpec: true, existingTechnicalSpecPath: null,
      autoMergeMilestoneTechnicalSpecs: false,
      autoPlanQueuedMilestones: false,
      featureSpecDir: null,
      trackingIssue: true,
    });
  });

  it("refuses a working branch that is a trunk or default branch — a programme never lands code on one", () => {
    for (const branch of ["main", "master", "qa", "staging", "production", "release/1.2", "Develop"]) {
      expect(() =>
        parseProgrammePolicy([...base, "  repoSettings:", "    acme_web:", `      baseBranch: ${branch}`].join("\n")),
        branch,
      ).toThrow(/Invalid programme policy/);
    }
  });

  it("refuses a workingBranchPrefix alongside baseBranch, under release/, or not ending in / or -", () => {
    for (const lines of [
      ["      baseBranch: feat/web-rebuild", "      workingBranchPrefix: feat/"],
      ["      workingBranchPrefix: release/"],
      ["      workingBranchPrefix: release-"],
      ["      workingBranchPrefix: Release/"],
      ["      workingBranchPrefix: feat"],
      ["      workingBranchPrefix: \"feat /\""],
    ]) {
      expect(() => parseProgrammePolicy([...base, "  repoSettings:", "    acme_web:", ...lines].join("\n")), lines.join()).toThrow(
        /Invalid programme policy/,
      );
    }
  });

  it("featureSpecDir is repo-relative with no dot segment, and loses a trailing slash", () => {
    const parse = (dir: string) =>
      parseProgrammePolicy([...base, "  repoSettings:", "    acme_web:", `      featureSpecDir: "${dir}"`].join("\n"));
    for (const dir of ["../x", "/abs", "a/../b", ".", "./", "./docs", "docs/./feature-spec", "docs/feature spec"]) {
      expect(() => parse(dir), dir).toThrow(/Invalid programme policy/);
    }
    expect(repoSettingsFor(parse("docs/feature-spec/"), "acme_web").featureSpecDir).toBe("docs/feature-spec");
    expect(repoSettingsFor(parse("docs/v1.2/feature-spec"), "acme_web").featureSpecDir).toBe("docs/v1.2/feature-spec");
  });

  it("names a programme's branch from the fixed baseBranch, else prefix + key + UTC date, else none", () => {
    const now = new Date("2026-09-28T23:30:00-05:00"); // 2026-09-29 in UTC
    expect(programmeWorkingBranch({ baseBranch: "feat/web-rebuild", workingBranchPrefix: null }, "login", now)).toBe("feat/web-rebuild");
    expect(programmeWorkingBranch({ baseBranch: null, workingBranchPrefix: "feat/" }, "login", now)).toBe("feat/login-20260929");
    expect(programmeWorkingBranch({ baseBranch: null, workingBranchPrefix: null }, "login", now)).toBeNull();
  });

  it("refuses settings for a repo that is not in allowedRepoKeys", () => {
    expect(() =>
      parseProgrammePolicy([...base, "  repoSettings:", "    other_repo:", "      trackingIssue: true"].join("\n")),
    ).toThrow(/Invalid programme policy/);
  });
});
