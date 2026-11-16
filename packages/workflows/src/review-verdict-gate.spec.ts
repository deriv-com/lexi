import { describe, expect, it } from "vitest";

import type {
  ReviewDomain,
  ReviewVerdictOutcome,
  ReviewVerdictRecord,
} from "./review-verdict.types";

import { evaluateReviewGate, summariseReviewGate } from "./review-verdict-gate";

const NOW = "2026-08-17T12:00:00.000Z";
const CHANGE = "pr/acme/web#4821";
const AUTHOR = "author-alice";

function verdict(
  domain: ReviewDomain,
  actorId: string,
  outcome: ReviewVerdictOutcome = "pass",
  overrides: Partial<ReviewVerdictRecord> = {},
): ReviewVerdictRecord {
  return {
    id: `v-${domain}-${actorId}`,
    changeRef: CHANGE,
    domain,
    outcome,
    actorId,
    authorId: AUTHOR,
    recordedAt: "2026-08-17T10:00:00.000Z",
    evidence: [{ label: "review notes", uri: "https://github.com/acme/web/pull/4821" }],
    ...overrides,
  };
}

/** Three distinct non-author owners, all passing — the only allowed shape. */
function threeGreen(): ReviewVerdictRecord[] {
  return [
    verdict("design", "owner-design"),
    verdict("engineering", "owner-eng"),
    verdict("security", "owner-sec"),
  ];
}

describe("evaluateReviewGate", () => {
  it("allows a change with three distinct passing owners", () => {
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: threeGreen(),
      now: NOW,
    });

    expect(result.allowed).toBe(true);
    expect(result.refusals).toEqual([]);
    expect(result.coveredDomains).toEqual(["design", "engineering", "security"]);
  });

  it("blocks and names the uncovered domain rather than accepting two of three", () => {
    // The accepted limit: with a small
    // roster a change may lack a third eligible reviewer. The gate must say so.
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [verdict("design", "owner-design"), verdict("engineering", "owner-eng")],
      now: NOW,
    });

    expect(result.allowed).toBe(false);
    const uncovered = result.refusals.filter((r) => r.code === "DOMAIN_UNCOVERED");
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]!.domain).toBe("security");
    expect(uncovered[0]!.detail).toContain("security has none");
  });

  it("refuses one actor holding two domains even when both pass", () => {
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [
        verdict("design", "owner-both"),
        verdict("engineering", "owner-both"),
        verdict("security", "owner-sec"),
      ],
      now: NOW,
    });

    expect(result.allowed).toBe(false);
    const cross = result.refusals.find((r) => r.code === "CROSS_DOMAIN_ACTOR");
    expect(cross?.actorId).toBe("owner-both");
    expect(cross?.detail).toContain("design, engineering");
  });

  it("refuses a verdict recorded by the change author", () => {
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [
        verdict("design", AUTHOR),
        verdict("engineering", "owner-eng"),
        verdict("security", "owner-sec"),
      ],
      now: NOW,
    });

    expect(result.allowed).toBe(false);
    const self = result.refusals.find((r) => r.code === "SELF_VERDICT_FORBIDDEN");
    expect(self?.actorId).toBe(AUTHOR);
    expect(self?.domain).toBe("design");
  });

  it("still reports self-review when a later verdict supersedes it", () => {
    // A superseded self-verdict still happened; a re-review does not erase it.
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [
        verdict("design", AUTHOR, "pass", { recordedAt: "2026-08-17T09:00:00.000Z" }),
        verdict("design", "owner-design", "pass", {
          id: "v-design-later",
          recordedAt: "2026-08-17T11:00:00.000Z",
        }),
        verdict("engineering", "owner-eng"),
        verdict("security", "owner-sec"),
      ],
      now: NOW,
    });

    expect(result.allowed).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain("SELF_VERDICT_FORBIDDEN");
  });

  it("takes the latest verdict per domain by server receipt time", () => {
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [
        verdict("design", "owner-design", "fail", {
          recordedAt: "2026-08-17T09:00:00.000Z",
          rationale: "focus order wrong",
        }),
        verdict("design", "owner-design", "pass", {
          id: "v-design-fixed",
          recordedAt: "2026-08-17T11:00:00.000Z",
        }),
        verdict("engineering", "owner-eng"),
        verdict("security", "owner-sec"),
      ],
      now: NOW,
    });

    expect(result.allowed).toBe(true);
  });

  it("blocks a fail and surfaces the owner's rationale", () => {
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [
        verdict("design", "owner-design"),
        verdict("engineering", "owner-eng"),
        verdict("security", "owner-sec", "fail", { rationale: "unbounded retry on a paid endpoint" }),
      ],
      now: NOW,
    });

    expect(result.allowed).toBe(false);
    const blocking = result.refusals.find((r) => r.code === "BLOCKING_FAILURE");
    expect(blocking?.domain).toBe("security");
    expect(blocking?.detail).toContain("unbounded retry on a paid endpoint");
  });

  it("allows a complete, unexpired exception", () => {
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [
        verdict("design", "owner-design"),
        verdict("engineering", "owner-eng"),
        verdict("security", "owner-sec", "exception", {
          rationale: "residual risk accepted for one release",
          exception: {
            expiresAt: "2026-09-01T00:00:00.000Z",
            monitoring: "alert on 4xx rate for the endpoint",
            remediation: "rate limiter ships in the next sprint",
            ownerId: "owner-sec",
          },
        }),
      ],
      now: NOW,
    });

    expect(result.allowed).toBe(true);
  });

  it("refuses an expired exception, evaluated against the injected clock", () => {
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [
        verdict("design", "owner-design"),
        verdict("engineering", "owner-eng"),
        verdict("security", "owner-sec", "exception", {
          exception: {
            expiresAt: "2026-08-01T00:00:00.000Z",
            monitoring: "alert on 4xx rate",
            remediation: "rate limiter",
            ownerId: "owner-sec",
          },
        }),
      ],
      now: NOW,
    });

    expect(result.allowed).toBe(false);
    expect(result.refusals.find((r) => r.code === "EXCEPTION_EXPIRED")?.domain).toBe("security");
  });

  it("treats a malformed expiry as expired rather than valid", () => {
    // Date.parse -> NaN makes every comparison false, which would read as
    // "not expired" if the gate compared naively.
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [
        verdict("design", "owner-design"),
        verdict("engineering", "owner-eng"),
        verdict("security", "owner-sec", "exception", {
          exception: {
            expiresAt: "whenever we get round to it",
            monitoring: "alert",
            remediation: "fix",
            ownerId: "owner-sec",
          },
        }),
      ],
      now: NOW,
    });

    expect(result.allowed).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain("EXCEPTION_EXPIRED");
  });

  it("refuses an exception missing monitoring or remediation", () => {
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [
        verdict("design", "owner-design"),
        verdict("engineering", "owner-eng"),
        verdict("security", "owner-sec", "exception", {
          exception: {
            expiresAt: "2026-09-01T00:00:00.000Z",
            monitoring: "   ",
            remediation: "",
            ownerId: "owner-sec",
          },
        }),
      ],
      now: NOW,
    });

    expect(result.allowed).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain("EXCEPTION_INCOMPLETE");
  });

  it("refuses an exception outcome carrying no exception payload at all", () => {
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [
        verdict("design", "owner-design"),
        verdict("engineering", "owner-eng"),
        verdict("security", "owner-sec", "exception"),
      ],
      now: NOW,
    });

    expect(result.allowed).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain("EXCEPTION_INCOMPLETE");
  });

  it("collects every refusal rather than stopping at the first", () => {
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [verdict("design", AUTHOR), verdict("engineering", AUTHOR)],
      now: NOW,
    });

    const codes = new Set(result.refusals.map((r) => r.code));
    expect(codes).toContain("DOMAIN_UNCOVERED");
    expect(codes).toContain("SELF_VERDICT_FORBIDDEN");
    expect(codes).toContain("CROSS_DOMAIN_ACTOR");
  });

  it("refuses an empty ledger with all three domains named", () => {
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [],
      now: NOW,
    });

    expect(result.allowed).toBe(false);
    expect(result.refusals).toHaveLength(3);
    expect(result.coveredDomains).toEqual([]);
  });

  it("scopes independence to one change", () => {
    // owner-eng already holds engineering on CHANGE. The same person holding
    // security on a different change must not trip CROSS_DOMAIN_ACTOR here.
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [
        ...threeGreen(),
        verdict("security", "owner-eng", "pass", { changeRef: "pr/other#99", id: "v-foreign" }),
      ],
      now: NOW,
    });
    expect(result.allowed).toBe(true);
    expect(result.refusals.map((r) => r.code)).not.toContain("CROSS_DOMAIN_ACTOR");
  });

  it("does not treat a foreign changeRef as coverage", () => {
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [verdict("design", "owner-design", "pass", { changeRef: "pr/other#99" })],
      now: NOW,
    });
    expect(result.allowed).toBe(false);
    expect(result.coveredDomains).toEqual([]);
    expect(result.refusals.filter((r) => r.code === "DOMAIN_UNCOVERED")).toHaveLength(3);
  });

  it("refuses a pass with no evidence URI", () => {
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [
        verdict("design", "owner-design", "pass", { evidence: [] }),
        verdict("engineering", "owner-eng"),
        verdict("security", "owner-sec"),
      ],
      now: NOW,
    });
    expect(result.allowed).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain("EVIDENCE_REQUIRED");
  });

  it("does not require performance evidence when no budget was set", () => {
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: threeGreen(),
      now: NOW,
      performanceBudgetSet: false,
    });
    expect(result.allowed).toBe(true);
  });

  it("requires performance evidence on engineering only when a budget was set", () => {
    const without = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: threeGreen(),
      now: NOW,
      performanceBudgetSet: true,
    });
    expect(without.allowed).toBe(false);
    expect(without.refusals.map((r) => r.code)).toContain("PERFORMANCE_EVIDENCE_REQUIRED");

    const withPerf = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [
        verdict("design", "owner-design"),
        verdict("engineering", "owner-eng", "pass", {
          evidence: [
            { label: "review notes", uri: "https://github.com/acme/web/pull/4821" },
            { label: "LCP p75", uri: "https://example.com/budget", kind: "performance" },
          ],
        }),
        verdict("security", "owner-sec"),
      ],
      now: NOW,
      performanceBudgetSet: true,
    });
    expect(withPerf.allowed).toBe(true);
  });

  it("refuses a self-verdict even when input.authorId was rewritten", () => {
    // The ledger column is what survives a PR-author rewrite.
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: "rewritten-not-the-author",
      verdicts: [
        verdict("design", AUTHOR, "pass", { authorId: AUTHOR }),
        verdict("engineering", "owner-eng"),
        verdict("security", "owner-sec"),
      ],
      now: NOW,
    });
    expect(result.allowed).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain("SELF_VERDICT_FORBIDDEN");
  });

  it("refuses an incomplete exception object without throwing", () => {
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [
        verdict("design", "owner-design"),
        verdict("engineering", "owner-eng"),
        verdict("security", "owner-sec", "exception", {
          exception: {} as ReviewVerdictRecord["exception"],
        }),
      ],
      now: NOW,
    });
    expect(result.allowed).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain("EXCEPTION_INCOMPLETE");
  });

  it("refuses an exception whose owner is the change author", () => {
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [
        verdict("design", "owner-design"),
        verdict("engineering", "owner-eng"),
        verdict("security", "owner-sec", "exception", {
          exception: {
            expiresAt: "2026-09-01T00:00:00.000Z",
            monitoring: "watch crash rate",
            remediation: "restore the control",
            ownerId: AUTHOR,
          },
        }),
      ],
      now: NOW,
    });
    expect(result.allowed).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain("EXCEPTION_OWNER_IS_AUTHOR");
  });

  it("counts distinct owners, not domains-with-a-row, in DOMAIN_UNCOVERED", () => {
    const result = evaluateReviewGate({
      changeRef: CHANGE,
      authorId: AUTHOR,
      verdicts: [
        verdict("design", "owner-both"),
        verdict("engineering", "owner-both"),
      ],
      now: NOW,
    });
    const uncovered = result.refusals.find((r) => r.code === "DOMAIN_UNCOVERED");
    expect(uncovered?.detail).toContain("1 distinct owner");
    expect(uncovered?.detail).toContain("security has none");
  });
});

describe("summariseReviewGate", () => {
  it("names the domains on a pass", () => {
    const summary = summariseReviewGate(
      evaluateReviewGate({
        changeRef: CHANGE,
        authorId: AUTHOR,
        verdicts: threeGreen(),
        now: NOW,
      }),
    );
    expect(summary).toContain("Review gate passed");
    expect(summary).toContain("security");
  });

  it("leads with the codes on a refusal", () => {
    const summary = summariseReviewGate(
      evaluateReviewGate({
        changeRef: CHANGE,
        authorId: AUTHOR,
        verdicts: [],
        now: NOW,
      }),
    );
    expect(summary).toContain("Review gate blocked");
    expect(summary).toContain("DOMAIN_UNCOVERED");
  });
});
