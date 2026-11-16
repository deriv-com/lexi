import { describe, expect, it } from "vitest";
import { GITHUB_ISSUE_NUMBER_MAX, isGithubIssueNumber } from "./github-issue-number";

describe("isGithubIssueNumber", () => {
  it("accepts ordinary checklist and bill numbers", () => {
    expect(isGithubIssueNumber(2098)).toBe(true);
    expect(isGithubIssueNumber(1)).toBe(true);
    expect(isGithubIssueNumber(GITHUB_ISSUE_NUMBER_MAX)).toBe(true);
  });

  it("rejects GitHub Actions run ids that overflow INT4", () => {
    expect(isGithubIssueNumber(32_334_312_816)).toBe(false);
    expect(isGithubIssueNumber(18_402_933_210)).toBe(false);
  });

  it("rejects non-integers and non-positive values", () => {
    expect(isGithubIssueNumber(0)).toBe(false);
    expect(isGithubIssueNumber(-1)).toBe(false);
    expect(isGithubIssueNumber(1.5)).toBe(false);
    expect(isGithubIssueNumber("2098")).toBe(false);
  });
});
