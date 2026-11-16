import { describe, expect, it } from "vitest";
import { workflowRunDisplayName, workflowRunNameIncludes } from "./workflow-run-name";

describe("workflowRunNameIncludes", () => {
  it("matches QA Mobile ISSUE-N run titles without grabbing ISSUE-N0", () => {
    expect(workflowRunNameIncludes("QA Mobile ISSUE-1962 · android · feature", "ISSUE-1962")).toBe(true);
    expect(workflowRunNameIncludes("QA Mobile ISSUE-19620 · android · feature", "ISSUE-1962")).toBe(false);
    expect(workflowRunNameIncludes("QA Mobile ISSUE-2148 · android · fix", "ISSUE-2170")).toBe(false);
  });

  it("rejects empty tokens", () => {
    expect(workflowRunNameIncludes("QA Mobile ISSUE-1962", "  ")).toBe(false);
  });
});

describe("workflowRunDisplayName", () => {
  it("joins name and display_title", () => {
    expect(workflowRunDisplayName({ name: "QA Mobile ISSUE-1", display_title: "android" })).toBe(
      "QA Mobile ISSUE-1 android",
    );
  });
});
