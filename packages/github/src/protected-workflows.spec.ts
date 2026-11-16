import { describe, expect, it } from "vitest";

import {
  classifyWorkflowDispatch,
  describeProtectedWorkflowRefusal,
  isProtectedWorkflow,
  normalizeWorkflowFile,
} from "./protected-workflows";

describe("blocked workflows", () => {
  it.each([
    "release.yml",
    "release.yaml",
    "production.yml",
    "production.yaml",
    "production_build.yml",
    "production-deploy.yml",
    // Publishing to a registry ships code to users the same way a release does.
    // design-system carries both of these.
    "publish.yml",
    "publish-blocks.yml",
  ])("blocks %s", (file) => {
    expect(isProtectedWorkflow(file)).toBe(true);
  });

  it("blocks the literal release.yml that mobile-packages carries", () => {
    // The concrete workflow this was asked for.
    expect(isProtectedWorkflow("release.yml")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isProtectedWorkflow("Release.yml")).toBe(true);
    expect(isProtectedWorkflow("PRODUCTION.YML")).toBe(true);
  });

  it("blocks regardless of directory prefix", () => {
    expect(isProtectedWorkflow(".github/workflows/release.yml")).toBe(true);
    expect(isProtectedWorkflow("./.github/workflows/production.yml")).toBe(true);
  });

  it("blocks a release/ or production/ workflow directory", () => {
    expect(isProtectedWorkflow("release/publish.yml")).toBe(true);
    expect(isProtectedWorkflow("production/deploy.yml")).toBe(true);
  });
});

describe("workflows that must stay dispatchable", () => {
  it.each([
    // The working-branch integration run — this is what release-integration
    // exists to do, and blocking it would break the flow, not guard anything.
    "release-integration.yml",
    "common-release-integration.yml",
    // Prepares a tag issue; ships nothing.
    "release-prepare-tag.yml",
    // Staging is not production.
    "staging_build.yml",
    "qa-mobile.yml",
    "maestro-smoke-tests-android-gh.yml",
    "direct-fix.yml",
    "common-lexi-build.yml",
    "lexi-runner.yml",
  ])("allows %s", (file) => {
    expect(isProtectedWorkflow(file)).toBe(false);
  });

  it("does not blur release-integration into release", () => {
    // The whole reason the check is anchored: `release-integration` is a
    // different pipeline from `release`, and a substring match would eat it.
    expect(isProtectedWorkflow("release.yml")).toBe(true);
    expect(isProtectedWorkflow("release-integration.yml")).toBe(false);
  });

  it("does not block a name that merely contains the word", () => {
    expect(isProtectedWorkflow("pre-release-checks.yml")).toBe(false);
    expect(isProtectedWorkflow("reproduction-harness.yml")).toBe(false);
  });
});

describe("normalizeWorkflowFile", () => {
  it("strips the workflows directory", () => {
    expect(normalizeWorkflowFile(".github/workflows/ci.yml")).toBe("ci.yml");
  });

  it("tolerates backslashes and a leading ./", () => {
    expect(normalizeWorkflowFile("./.github\\workflows\\ci.yml")).toBe("ci.yml");
  });

  it("returns empty for blank input, which classifies as not blocked", () => {
    expect(normalizeWorkflowFile("   ")).toBe("");
    expect(isProtectedWorkflow("   ")).toBe(false);
  });
});

describe("refusal text", () => {
  it("names the workflow, the repo and states nothing ran", () => {
    const text = describeProtectedWorkflowRefusal(".github/workflows/release.yml", "acme", "web-app");
    expect(text).toContain("release.yml");
    expect(text).toContain("acme/web-app");
    expect(text).toContain("release pipeline");
    expect(text).toContain("Nothing was dispatched");
    expect(text).not.toContain(".github/workflows");
  });

  it("calls a production build a production pipeline", () => {
    expect(classifyWorkflowDispatch("production_build.yml").reason).toBe("a production pipeline");
  });
});
