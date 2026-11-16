import { describe, it, expect } from "vitest";
import type { RepoDescriptor } from "@lexi/contracts";
import { loadSpecPolicy } from "./load-spec-policy";
import { createCoverageRecord } from "./coverage";
import { renderSpec, type SpecFrontmatter } from "./spec-template";
import {
  assertSpecRepo,
  buildSpecAnnouncement,
  buildSpecIssue,
  specIssueLabels,
  specIssueTitle,
  SpecRepoRoleError,
  toSpecDocumentMirror,
} from "./spec-output";

/**
 * Spec output. A spec is filed in the **product repo it governs** and
 * never in `issues`, whose corpus sync, dedup, triage and
 * reproduction machinery assumes every issue is a production defect. That is
 * enforced here by a role check that throws, not by a comment asking nicely.
 */

const POLICY = loadSpecPolicy();

const PRODUCT_REPO: RepoDescriptor = {
  key: "home_mobile",
  organization: "acme-internal",
  repository: "mobile-app",
  slug: "acme-internal/mobile-app",
  roles: ["code", "specs"],
  platform: "mobile",
  team: "home",
};

const BUG_REPO: RepoDescriptor = {
  key: "issues",
  organization: "acme-internal",
  repository: "issues",
  slug: "acme-internal/issues",
  roles: ["issues"],
};

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

describe("repo role gate", () => {
  it("accepts a repo carrying the specs role", () => {
    expect(() => assertSpecRepo(PRODUCT_REPO, POLICY)).not.toThrow();
  });

  it("refuses issues by name and by role", () => {
    expect(() => assertSpecRepo(BUG_REPO, POLICY)).toThrow(SpecRepoRoleError);
    expect(() => assertSpecRepo(BUG_REPO, POLICY)).toThrow(/issues/);
  });

  it("refuses a code repo that was never granted the specs role", () => {
    const codeOnly: RepoDescriptor = { ...PRODUCT_REPO, key: "some_repo", roles: ["code"] };
    expect(() => assertSpecRepo(codeOnly, POLICY)).toThrow(/specs/);
  });

  it("refuses a repo with no roles at all", () => {
    expect(() => assertSpecRepo({ ...PRODUCT_REPO, roles: [] }, POLICY)).toThrow(SpecRepoRoleError);
  });
});

describe("issue title and labels", () => {
  it("prefixes the title per policy", () => {
    expect(specIssueTitle("Deposit retry", POLICY)).toBe("[Spec] Deposit retry");
  });

  it("does not double-prefix an already-prefixed title", () => {
    expect(specIssueTitle("[Spec] Deposit retry", POLICY)).toBe("[Spec] Deposit retry");
  });

  it("labels a draft type:spec + spec:draft", () => {
    expect(specIssueLabels("DRAFT_READY", POLICY)).toEqual(["type:spec", "spec:draft"]);
  });

  it("labels an approved spec type:spec + spec:approved", () => {
    expect(specIssueLabels("APPROVED", POLICY)).toEqual(["type:spec", "spec:approved"]);
  });

  it("keeps a spec under review labelled as a draft", () => {
    // Only approval flips the label — otherwise a spec in review would read as
    // approved to anyone filtering the repo by label.
    expect(specIssueLabels("IN_REVIEW", POLICY)).toEqual(["type:spec", "spec:draft"]);
  });
});

describe("building the issue payload", () => {
  const rendered = renderSpec({ frontmatter: FRONTMATTER, coverage: createCoverageRecord() });

  it("targets the product repo slug", () => {
    const issue = buildSpecIssue({ repo: PRODUCT_REPO, frontmatter: FRONTMATTER, rendered, policy: POLICY });

    expect(issue.repoSlug).toBe("acme-internal/mobile-app");
    expect(issue.title).toBe("[Spec] Deposit retry on mobile web");
    expect(issue.labels).toEqual(["type:spec", "spec:draft"]);
    expect(issue.body).toBe(rendered.body);
  });

  it("refuses to build an issue for the bug repo", () => {
    expect(() =>
      buildSpecIssue({ repo: BUG_REPO, frontmatter: FRONTMATTER, rendered, policy: POLICY }),
    ).toThrow(SpecRepoRoleError);
  });

  it("carries the board column so the spec lands in Spec review", () => {
    const issue = buildSpecIssue({ repo: PRODUCT_REPO, frontmatter: FRONTMATTER, rendered, policy: POLICY });
    expect(issue.boardColumn).toBe("Spec review");
  });
});

describe("SpecDocument mirror", () => {
  const rendered = renderSpec({ frontmatter: FRONTMATTER, coverage: createCoverageRecord() });

  it("mirrors the rendered spec with its content hash", () => {
    const mirror = toSpecDocumentMirror({
      sessionId: "sess-1",
      frontmatter: FRONTMATTER,
      rendered,
      issueNumber: 42,
    });

    expect(mirror.sessionId).toBe("sess-1");
    expect(mirror.trackingRepoKey).toBe("home_mobile");
    expect(mirror.codeRepoKey).toBe("home_mobile");
    expect(mirror.revision).toBe(1);
    expect(mirror.status).toBe("DRAFT_READY");
    expect(mirror.contentHash).toBe(rendered.contentHash);
    expect(mirror.body).toBe(rendered.body);
  });

  it("mirrors without an issue number when GitHub writes are disabled", () => {
    // SPEC_SESSIONS_ENABLED runs DB-only with zero GitHub writes,
    // so the mirror has to be complete on its own.
    const mirror = toSpecDocumentMirror({ sessionId: "sess-1", frontmatter: FRONTMATTER, rendered });

    expect(mirror.issueNumber).toBeUndefined();
    expect(mirror.contentHash).toBe(rendered.contentHash);
  });
});

describe("governance announcement", () => {
  it("announces with a link, taking the channel from the caller", () => {
    const announcement = buildSpecAnnouncement({
      channelId: "C0TEST06",
      frontmatter: FRONTMATTER,
      issueUrl: "https://github.com/acme-internal/mobile-app/issues/42",
      readinessReason: "coverage_complete",
    });

    expect(announcement.channelId).toBe("C0TEST06");
    expect(announcement.text).toContain("Deposit retry on mobile web");
    expect(announcement.text).toContain("https://github.com/acme-internal/mobile-app/issues/42");
  });

  it("says so when the draft was forced by the question cap", () => {
    const announcement = buildSpecAnnouncement({
      channelId: "C1",
      frontmatter: FRONTMATTER,
      readinessReason: "question_turn_cap",
      blockingOpenQuestions: ["rollout: how does this ship?"],
    });

    // Drafting over gaps is allowed; hiding that it happened is not.
    expect(announcement.text).toMatch(/open question/i);
    expect(announcement.text).toContain("rollout");
  });

  it("hard-codes no channel id of its own", () => {
    const announcement = buildSpecAnnouncement({
      channelId: "C-CALLER",
      frontmatter: FRONTMATTER,
      readinessReason: "coverage_complete",
    });

    // The audit flagged hard-coded channel ids as existing debt; this
    // build must not add more. The id arrives from escalation-policy.yaml via
    // the caller.
    expect(announcement.channelId).toBe("C-CALLER");
    expect(announcement.text).not.toContain("C0TEST06");
  });
});
