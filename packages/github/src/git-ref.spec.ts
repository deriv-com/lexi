import { describe, it, expect } from "vitest";
import { assertFullSha, assertSafeBranchName, assertSubmodulePath } from "./git-ref";

describe("assertSafeBranchName", () => {
  it("accepts the integration branch the skill names", () => {
    expect(assertSafeBranchName("release/integration-2026-08-19", "branch")).toBe(
      "release/integration-2026-08-19",
    );
  });

  it("rejects path traversal and lock-file names", () => {
    expect(() => assertSafeBranchName("foo/../main", "branch")).toThrow(/not a legal git ref/);
    expect(() => assertSafeBranchName("heads/main.lock", "branch")).toThrow(/not a legal git ref/);
    expect(() => assertSafeBranchName("", "branch")).toThrow(/required/);
  });
});

describe("assertFullSha", () => {
  it("accepts a 40-char lowercase sha", () => {
    const sha = "a".repeat(40);
    expect(assertFullSha(sha, "sha")).toBe(sha);
  });

  it("rejects a short sha", () => {
    expect(() => assertFullSha("abc1234", "sha")).toThrow(/full 40-character/);
  });
});

describe("assertSubmodulePath", () => {
  it("allows the two nested gitlinks", () => {
    expect(assertSubmodulePath("packages")).toBe("packages");
    expect(assertSubmodulePath("design_system")).toBe("design_system");
  });

  it("rejects anything else", () => {
    expect(() => assertSubmodulePath("src")).toThrow(/not allowed/);
    expect(() => assertSubmodulePath("../packages")).toThrow(/not allowed/);
  });
});
