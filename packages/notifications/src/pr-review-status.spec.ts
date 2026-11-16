import { describe, it, expect } from "vitest";
import {
  PR_REVIEW_STATUS_TOOL,
  PULL_REQUEST_REVIEW_PORT_METHODS,
  describePrReviewStatus,
  summarizePrReviewStatus,
  type PullRequestReviewPort,
  type PullRequestReviewStatus,
} from "./pr-review-status";

/**
 * PR review-status read tool.
 *
 * The capability exists so Lexi can answer "what is this PR waiting on" —
 * reviews, checks, mergeability. It uses `PullRequests:write` for *comments
 * only*. Merging and closing a PR are permanent non-goals, and the
 * tests below assert that as a property of the surface rather than trusting a
 * reviewer to notice if someone adds a merge method later.
 */

const BASE: PullRequestReviewStatus = {
  number: 42,
  url: "https://github.com/acme/web-app/pull/42",
  state: "open",
  draft: false,
  reviews: [],
  checks: [],
  mergeable: true,
};

function status(overrides: Partial<PullRequestReviewStatus> = {}): PullRequestReviewStatus {
  return { ...BASE, ...overrides };
}

function at(iso: string): Date {
  return new Date(iso);
}

describe("Lexi never merges or closes a pull request", () => {
  it("exposes no merge or close capability on the read port", () => {
    for (const method of PULL_REQUEST_REVIEW_PORT_METHODS) {
      expect(method).not.toMatch(/merge/i);
      expect(method).not.toMatch(/close/i);
    }
  });

  it("declares only read methods on the port", () => {
    expect([...PULL_REQUEST_REVIEW_PORT_METHODS]).toEqual(["getReviewStatus"]);
  });

  // A structural check on the port type itself: this must not compile if a
  // merge method is ever added, because the object below is a complete
  // implementation of the interface.
  it("is fully implementable with a single read method", () => {
    const port: PullRequestReviewPort = {
      getReviewStatus: async () => status(),
    };

    expect(Object.keys(port)).toEqual([...PULL_REQUEST_REVIEW_PORT_METHODS]);
  });

  it("ships a tool schema with no merge or close verb anywhere in it", () => {
    const serialized = JSON.stringify(PR_REVIEW_STATUS_TOOL).toLowerCase();

    expect(serialized).not.toContain("merge_pull_request");
    expect(serialized).not.toContain("close_pull_request");
    expect(PR_REVIEW_STATUS_TOOL.name).toBe("get_pull_request_review_status");
  });

  it("tells the model in the tool description that it cannot merge or close", () => {
    expect(PR_REVIEW_STATUS_TOOL.description.toLowerCase()).toMatch(/read-only|never merges/);
  });

  it("takes only a repo and PR reference as input — no action parameter to abuse", () => {
    const properties = PR_REVIEW_STATUS_TOOL.input_schema.properties as Record<string, unknown>;

    expect(Object.keys(properties).sort()).toEqual(["owner", "pull_number", "repo"]);
    expect(PR_REVIEW_STATUS_TOOL.input_schema.required).toEqual(["owner", "repo", "pull_number"]);
  });
});

describe("summarizePrReviewStatus", () => {
  it("reports a merged PR as merged", () => {
    expect(summarizePrReviewStatus(status({ state: "merged" })).verdict).toBe("merged");
  });

  it("reports a PR closed without merging as closed", () => {
    expect(summarizePrReviewStatus(status({ state: "closed" })).verdict).toBe("closed");
  });

  it("reports a draft PR as draft — nobody is expected to review it yet", () => {
    expect(summarizePrReviewStatus(status({ draft: true })).verdict).toBe("draft");
  });

  it("reports an unreviewed PR as awaiting review", () => {
    const summary = summarizePrReviewStatus(status());

    expect(summary.verdict).toBe("awaiting_review");
    expect(summary.approvals).toEqual([]);
  });

  it("reports an approved PR with green checks as ready to merge", () => {
    const summary = summarizePrReviewStatus(
      status({
        reviews: [{ reviewer: "alice", state: "APPROVED", submittedAt: at("2026-08-14T10:00:00Z") }],
        checks: [{ name: "ci", status: "completed", conclusion: "success" }],
      }),
    );

    expect(summary.verdict).toBe("ready_to_merge");
    expect(summary.approvals).toEqual(["alice"]);
    expect(summary.blockers).toEqual([]);
  });

  it("reports requested changes ahead of everything else a human could act on", () => {
    const summary = summarizePrReviewStatus(
      status({
        reviews: [
          { reviewer: "alice", state: "APPROVED", submittedAt: at("2026-08-14T10:00:00Z") },
          { reviewer: "bob", state: "CHANGES_REQUESTED", submittedAt: at("2026-08-14T11:00:00Z") },
        ],
        checks: [{ name: "ci", status: "completed", conclusion: "failure" }],
      }),
    );

    expect(summary.verdict).toBe("changes_requested");
    expect(summary.changesRequestedBy).toEqual(["bob"]);
  });

  it("takes each reviewer's latest decisive review", () => {
    const summary = summarizePrReviewStatus(
      status({
        reviews: [
          { reviewer: "bob", state: "CHANGES_REQUESTED", submittedAt: at("2026-08-14T09:00:00Z") },
          { reviewer: "bob", state: "APPROVED", submittedAt: at("2026-08-14T12:00:00Z") },
        ],
      }),
    );

    expect(summary.verdict).toBe("ready_to_merge");
    expect(summary.approvals).toEqual(["bob"]);
    expect(summary.changesRequestedBy).toEqual([]);
  });

  // A drive-by comment is not a verdict; it must not cancel an approval.
  it("does not let a later COMMENTED review erase an approval", () => {
    const summary = summarizePrReviewStatus(
      status({
        reviews: [
          { reviewer: "alice", state: "APPROVED", submittedAt: at("2026-08-14T09:00:00Z") },
          { reviewer: "alice", state: "COMMENTED", submittedAt: at("2026-08-14T13:00:00Z") },
        ],
      }),
    );

    expect(summary.approvals).toEqual(["alice"]);
  });

  it("ignores a dismissed review", () => {
    const summary = summarizePrReviewStatus(
      status({
        reviews: [
          { reviewer: "alice", state: "APPROVED", submittedAt: at("2026-08-14T09:00:00Z") },
          { reviewer: "alice", state: "DISMISSED", submittedAt: at("2026-08-14T13:00:00Z") },
        ],
      }),
    );

    expect(summary.approvals).toEqual([]);
    expect(summary.verdict).toBe("awaiting_review");
  });

  it("reports a conflicted PR even when it is approved", () => {
    const summary = summarizePrReviewStatus(
      status({
        reviews: [{ reviewer: "alice", state: "APPROVED", submittedAt: at("2026-08-14T10:00:00Z") }],
        mergeable: false,
      }),
    );

    expect(summary.verdict).toBe("conflicted");
    expect(summary.blockers.join(" ")).toMatch(/conflict/i);
  });

  it("reports failing checks and names them", () => {
    const summary = summarizePrReviewStatus(
      status({
        reviews: [{ reviewer: "alice", state: "APPROVED", submittedAt: at("2026-08-14T10:00:00Z") }],
        checks: [
          { name: "unit", status: "completed", conclusion: "success" },
          { name: "e2e", status: "completed", conclusion: "failure" },
        ],
      }),
    );

    expect(summary.verdict).toBe("checks_failing");
    expect(summary.failingChecks).toEqual(["e2e"]);
  });

  it("treats a still-running check as pending, not as failure", () => {
    const summary = summarizePrReviewStatus(
      status({
        reviews: [{ reviewer: "alice", state: "APPROVED", submittedAt: at("2026-08-14T10:00:00Z") }],
        checks: [{ name: "e2e", status: "in_progress", conclusion: null }],
      }),
    );

    expect(summary.verdict).toBe("checks_pending");
    expect(summary.pendingChecks).toEqual(["e2e"]);
  });

  it("does not treat a skipped or neutral check as a failure", () => {
    const summary = summarizePrReviewStatus(
      status({
        reviews: [{ reviewer: "alice", state: "APPROVED", submittedAt: at("2026-08-14T10:00:00Z") }],
        checks: [
          { name: "lint", status: "completed", conclusion: "skipped" },
          { name: "size", status: "completed", conclusion: "neutral" },
        ],
      }),
    );

    expect(summary.verdict).toBe("ready_to_merge");
    expect(summary.failingChecks).toEqual([]);
  });

  it("treats unknown mergeability as not-a-blocker — GitHub is still computing it", () => {
    const summary = summarizePrReviewStatus(
      status({
        reviews: [{ reviewer: "alice", state: "APPROVED", submittedAt: at("2026-08-14T10:00:00Z") }],
        mergeable: null,
      }),
    );

    expect(summary.verdict).toBe("ready_to_merge");
  });
});

describe("describePrReviewStatus", () => {
  it("names a human as the actor for a ready PR — Lexi reports, a human merges", () => {
    const text = describePrReviewStatus(
      status({ reviews: [{ reviewer: "alice", state: "APPROVED", submittedAt: at("2026-08-14T10:00:00Z") }] }),
    );

    expect(text).toContain("#42");
    expect(text.toLowerCase()).toMatch(/ready to merge/);
    expect(text.toLowerCase()).not.toMatch(/i will merge|merging now/);
  });

  it("lists the blockers for a PR that is not ready", () => {
    const text = describePrReviewStatus(
      status({ reviews: [{ reviewer: "bob", state: "CHANGES_REQUESTED", submittedAt: at("2026-08-14T10:00:00Z") }] }),
    );

    expect(text).toContain("bob");
    expect(text.toLowerCase()).toContain("changes requested");
  });
});
