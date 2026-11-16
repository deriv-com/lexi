import { describe, expect, it } from "vitest";

import {
  classifyBranch,
  describeProtectedBranchRefusal,
  isProtectedBranch,
  normalizeBranchName,
} from "./protected-branches";

describe("normalizeBranchName", () => {
  it("strips refs/heads/ and heads/", () => {
    expect(normalizeBranchName("refs/heads/main")).toBe("main");
    expect(normalizeBranchName("heads/main")).toBe("main");
    expect(normalizeBranchName("  main  ")).toBe("main");
  });

  it("stops a fully-qualified ref slipping past the guard", () => {
    // The whole point: a caller that passes refs/heads/main must not be treated
    // as a feature branch just because the string is longer.
    expect(isProtectedBranch("refs/heads/main")).toBe(true);
    expect(isProtectedBranch("heads/master")).toBe(true);
  });
});

describe("trunk branches", () => {
  it.each([
    "main",
    "master",
    "develop",
    "dev",
    "trunk",
    "stable",
    "qa",
    "staging",
    "production",
    "prod",
    "release",
    "release/1.2",
  ])("protects %s", (branch) => {
    expect(isProtectedBranch(branch)).toBe(true);
    expect(classifyBranch(branch).reason).toBe("trunk");
  });

  it("allows an integration working branch in EITHER spelling", () => {
    // These are the branches release-integration merges INTO by design.
    // Protecting them would break the flow rather than guard anything.
    //
    // The separator is not the distinction — "integration" is. An earlier
    // version keyed on slash-vs-hyphen and wrongly protected the slash form,
    // which is simply the older spelling of the same working branch and is
    // still what several callers pass.
    expect(isProtectedBranch("release-integration-2026-09-14")).toBe(false);
    expect(isProtectedBranch("release/integration-2026-08-19")).toBe(false);
    expect(isProtectedBranch("release-2026-09-14")).toBe(false);
  });

  it("still protects a real release line", () => {
    expect(isProtectedBranch("release/1.2")).toBe(true);
    expect(isProtectedBranch("release/v2.0.0")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isProtectedBranch("Main")).toBe(true);
    expect(isProtectedBranch("MASTER")).toBe(true);
  });

  it("allows ordinary feature branches", () => {
    for (const branch of [
      "lexi/abc-123",
      "mallory/fix-thing",
      "feature/login",
      "fix/typo",
      "mainline-refactor",
      "release-notes-update",
    ]) {
      expect(isProtectedBranch(branch)).toBe(false);
    }
  });

  it("does not protect a name that merely starts with a trunk word", () => {
    // `main` is protected; `maintenance` is an ordinary branch.
    expect(isProtectedBranch("maintenance")).toBe(false);
    expect(isProtectedBranch("production-readiness-notes")).toBe(false);
  });
});

describe("repository default branch", () => {
  it("protects a non-standard default branch by name", () => {
    const verdict = classifyBranch("shipping", "shipping");
    expect(verdict.protected).toBe(true);
    expect(verdict.reason).toBe("default-branch");
    expect(verdict.defaultBranch).toBe("shipping");
  });

  it("compares the default branch case-insensitively", () => {
    expect(isProtectedBranch("Shipping", "shipping")).toBe(true);
  });

  it("reports trunk rather than default-branch when both apply", () => {
    // master is in the standing list AND is this repo's default; the more
    // general reason is the more useful one to state.
    expect(classifyBranch("master", "master").reason).toBe("trunk");
  });

  it("ignores an absent or blank default branch", () => {
    expect(isProtectedBranch("anything", null)).toBe(false);
    expect(isProtectedBranch("anything", "")).toBe(false);
    expect(isProtectedBranch("anything", undefined)).toBe(false);
  });

  it("still allows a feature branch in a repo with an unusual default", () => {
    expect(isProtectedBranch("lexi/fix-1", "shipping")).toBe(false);
  });
});

describe("empty input", () => {
  it("is not protected, so the caller's own required-field check reports it", () => {
    expect(isProtectedBranch("")).toBe(false);
    expect(isProtectedBranch("   ")).toBe(false);
  });
});

describe("describeProtectedBranchRefusal", () => {
  it("names the branch, the action and states nothing changed", () => {
    const text = describeProtectedBranchRefusal("main", "merge into", classifyBranch("main"));
    expect(text).toContain('"main"');
    expect(text).toContain("merge into");
    expect(text).toContain("trunk or release branch");
    expect(text).toContain("Nothing was changed");
    expect(text).toContain("pull request");
  });

  it("says default branch when that is why it was refused", () => {
    const text = describeProtectedBranchRefusal("shipping", "commit to", classifyBranch("shipping", "shipping"));
    expect(text).toContain("default branch");
  });

  it("normalises the branch in the message", () => {
    const text = describeProtectedBranchRefusal("refs/heads/main", "merge into", classifyBranch("refs/heads/main"));
    expect(text).toContain('"main"');
    expect(text).not.toContain("refs/heads");
  });
});
