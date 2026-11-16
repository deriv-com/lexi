import { describe, it, expect } from "vitest";
import { extractLinkedRefs } from "./link-extractor";

describe("extractLinkedRefs", () => {
  it("matches a plain issue link", () => {
    const refs = extractLinkedRefs("See https://github.com/acme/legacy-app/issues/1234 for details.");
    expect(refs).toEqual([{ owner: "acme", repo: "legacy-app", number: 1234, type: "issues" }]);
  });

  it("matches a plain PR link", () => {
    const refs = extractLinkedRefs("Fixed by https://github.com/acme/legacy-app/pull/5678");
    expect(refs).toEqual([{ owner: "acme", repo: "legacy-app", number: 5678, type: "pull" }]);
  });

  it("matches multiple links in one string", () => {
    const refs = extractLinkedRefs(
      "Related: https://github.com/acme/legacy-app/issues/1 and https://github.com/acme-internal/issues/pull/2",
    );
    expect(refs).toEqual([
      { owner: "acme", repo: "legacy-app", number: 1, type: "issues" },
      { owner: "acme-internal", repo: "issues", number: 2, type: "pull" },
    ]);
  });

  it("matches links embedded in markdown", () => {
    const refs = extractLinkedRefs("Fixed in [this PR](https://github.com/acme/legacy-app/pull/999).");
    expect(refs).toEqual([{ owner: "acme", repo: "legacy-app", number: 999, type: "pull" }]);
  });

  it("matches case-insensitively on the issues/pull segment", () => {
    const refs = extractLinkedRefs("https://GitHub.com/acme/legacy-app/PULL/42");
    expect(refs).toEqual([{ owner: "acme", repo: "legacy-app", number: 42, type: "pull" }]);
  });

  it("finds no matches on unrelated URLs", () => {
    const refs = extractLinkedRefs(
      "Check https://github.com/acme/legacy-app and https://example.com/issues/123 and https://github.com/acme/legacy-app/commit/abcdef",
    );
    expect(refs).toEqual([]);
  });

  it("dedups the same link repeated twice", () => {
    const refs = extractLinkedRefs(
      "Duplicate mention: https://github.com/acme/legacy-app/issues/42 ... also see https://github.com/acme/legacy-app/issues/42 again.",
    );
    expect(refs).toEqual([{ owner: "acme", repo: "legacy-app", number: 42, type: "issues" }]);
  });

  it("returns an empty array for text with no links at all", () => {
    expect(extractLinkedRefs("Nothing to see here.")).toEqual([]);
  });
});
