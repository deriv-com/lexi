import { describe, expect, it } from "vitest";

import { createCoverageRecord } from "./coverage";
import { diffSpecRevisions } from "./spec-diff";
import {
  isSpecEvidenceHref,
  ledgerFromDiff,
  parseSpecEvidenceLink,
  sanitizeEvidenceLinks,
  sanitizeNamedOwners,
} from "./spec-revision-ledger";
import { renderSpec, type SpecDraftInput, type SpecFrontmatter } from "./spec-template";

const FRONTMATTER: SpecFrontmatter = {
  specId: "spec-1",
  title: "Deposit retry on mobile web",
  status: "DRAFT_READY",
  revision: 1,
  requestedBy: "U1",
  trackingRepoKey: "home_mobile",
  codeRepoKey: "home_mobile",
  platforms: ["mobile"],
  createdAt: "2026-08-15T10:00:00.000Z",
  labels: [],
};

function draft(overrides: Partial<SpecDraftInput> = {}): SpecDraftInput {
  return {
    frontmatter: FRONTMATTER,
    coverage: createCoverageRecord(),
    ...overrides,
  };
}

describe("isSpecEvidenceHref", () => {
  it("accepts http and https URLs", () => {
    expect(isSpecEvidenceHref("https://acme.slack.com/archives/C1/p123")).toBe(true);
    expect(isSpecEvidenceHref("http://example.com/issue/1")).toBe(true);
  });

  it("rejects the string \"thread\" as an evidence link", () => {
    // The bug this exists to close: a Slack evidence pointer used to be the
    // literal string `"thread"`, which is not a URL and cannot be followed.
    expect(isSpecEvidenceHref("thread")).toBe(false);
    expect(parseSpecEvidenceLink("thread")).toBeNull();
    expect(sanitizeEvidenceLinks(["thread"])).toEqual([]);
  });

  it("rejects other non-URLs", () => {
    expect(isSpecEvidenceHref("")).toBe(false);
    expect(isSpecEvidenceHref("slack")).toBe(false);
    expect(isSpecEvidenceHref("ftp://files.example/doc")).toBe(false);
    expect(isSpecEvidenceHref("/archives/C1/p123")).toBe(false);
    expect(isSpecEvidenceHref("javascript:alert(1)")).toBe(false);
  });
});

describe("parseSpecEvidenceLink", () => {
  it("infers kind from a Slack permalink", () => {
    const link = parseSpecEvidenceLink({
      href: "https://acme.slack.com/archives/C1/p1234567890123456",
      label: "Request thread",
    });
    expect(link).toEqual({
      href: "https://acme.slack.com/archives/C1/p1234567890123456",
      label: "Request thread",
      kind: "slack_thread",
    });
  });

  it("infers GitHub issue and PR kinds", () => {
    expect(parseSpecEvidenceLink("https://github.com/org/repo/issues/42")?.kind).toBe("github_issue");
    expect(parseSpecEvidenceLink("https://github.com/org/repo/pull/9")?.kind).toBe("github_pr");
    expect(parseSpecEvidenceLink("https://www.figma.com/file/abc/Draft")?.kind).toBe("figma");
  });

  it("drops a link rather than inventing a permalink", () => {
    expect(parseSpecEvidenceLink({ href: "thread", label: "Slack thread", kind: "slack_thread" })).toBeNull();
    expect(sanitizeEvidenceLinks([{ href: "thread" }, { href: "https://github.com/org/repo/issues/1" }])).toEqual([
      { href: "https://github.com/org/repo/issues/1", kind: "github_issue" },
    ]);
  });
});

describe("sanitizeNamedOwners", () => {
  it("keeps a requester with a Slack id", () => {
    expect(sanitizeNamedOwners([{ role: "requester", name: "U1", slackUserId: "U1" }])).toEqual([
      { role: "requester", name: "U1", slackUserId: "U1" },
    ]);
  });

  it("drops an owner missing a name or role", () => {
    expect(sanitizeNamedOwners([{ role: "requester" }, { name: "U1" }])).toEqual([]);
  });
});

describe("ledgerFromDiff", () => {
  it("returns an empty list when the diff has no content changes", () => {
    const rendered = renderSpec(draft());
    expect(ledgerFromDiff(diffSpecRevisions({ rendered }, { rendered }))).toEqual([]);
  });

  it("maps added, removed and changed sections and excludes unchanged", () => {
    const before = renderSpec(draft({ sections: { problem: "Deposits fail." } }));
    const after = renderSpec(
      draft({
        sections: { problem: "Deposits fail silently on retry." },
        openQuestions: ["Which PSPs?"],
      }),
    );
    const grown = {
      ...after,
      sections: [...after.sections, { id: "compliance_notes", heading: "Compliance notes", body: "Staged." }],
    };

    const changed = ledgerFromDiff(diffSpecRevisions({ rendered: before }, { rendered: grown }));

    expect(changed.find((s) => s.id === "problem")).toEqual({
      id: "problem",
      heading: "Problem",
      kind: "changed",
    });
    expect(changed.find((s) => s.id === "compliance_notes")).toEqual({
      id: "compliance_notes",
      heading: "Compliance notes",
      kind: "added",
    });
    expect(changed.find((s) => s.id === "open_questions")?.kind).toBe("changed");
    // Unchanged sections are not persisted — a reviewer does not re-read them.
    expect(changed.find((s) => s.id === "users")).toBeUndefined();
    expect(changed.map((s) => s.kind)).toEqual(expect.arrayContaining(["changed", "added"]));
    // Bodies stay off the row.
    expect(changed.every((s) => !("before" in s) && !("after" in s))).toBe(true);
  });

  it("does not record the revision-ledger section as a change", () => {
    const before = renderSpec(draft({ sections: { problem: "A" } }));
    const after = renderSpec(
      draft({
        sections: { problem: "B" },
        ledger: {
          changedSections: [{ id: "problem", heading: "Problem", kind: "changed" }],
          evidenceLinks: [],
          owners: [{ role: "requester", name: "U1" }],
        },
      }),
    );

    const changed = ledgerFromDiff(diffSpecRevisions({ rendered: before }, { rendered: after }));
    expect(changed.find((s) => s.id === "revision_ledger")).toBeUndefined();
    expect(changed.find((s) => s.id === "problem")?.kind).toBe("changed");
  });

  it("reports a subsequent revision's changed sections against the previous render", () => {
    const first = renderSpec(draft({ sections: { problem: "Deposits fail.", rollout: "Flag off." } }));
    const second = renderSpec(
      draft({
        frontmatter: { ...FRONTMATTER, revision: 2 },
        sections: { problem: "Deposits fail silently.", rollout: "Staged 10% then 100%." },
      }),
    );

    const changed = ledgerFromDiff(diffSpecRevisions({ rendered: first }, { rendered: second }));
    expect(changed.map((s) => s.id).sort()).toEqual(["problem", "rollout"]);
    expect(changed.every((s) => s.kind === "changed")).toBe(true);
  });
});
