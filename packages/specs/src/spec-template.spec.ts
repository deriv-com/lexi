import { afterEach, describe, it, expect, vi } from "vitest";
import { createCoverageRecord, deferDimension, recordCoverage } from "./coverage";
import {
  parseSpecFrontmatter,
  renderSpec,
  SPEC_SECTIONS,
  type SpecDraftInput,
  type SpecFrontmatter,
} from "./spec-template";

/**
 * Rendering is deterministic code, not an LLM call. The model's job is
 * to elicit answers; turning answers into a document is string assembly, and
 * paying for a model turn to do it would also make the same spec render
 * differently on a re-run, which breaks the content hash the mirror depends on.
 */

const FRONTMATTER: SpecFrontmatter = {
  specId: "spec-1",
  title: "Deposit retry on mobile web",
  status: "DRAFTING",
  revision: 1,
  requestedBy: "U1",
  trackingRepoKey: "home_mobile",
  codeRepoKey: "home_mobile",
  platforms: ["mobile"],
  createdAt: "2026-08-15T10:00:00.000Z",
  labels: ["type:spec", "spec:draft"],
};

function draft(overrides: Partial<SpecDraftInput> = {}): SpecDraftInput {
  return { frontmatter: FRONTMATTER, coverage: createCoverageRecord(), ...overrides };
}

describe("frontmatter validation", () => {
  it("accepts a well-formed frontmatter", () => {
    expect(() => parseSpecFrontmatter(FRONTMATTER)).not.toThrow();
  });

  it("rejects a missing title", () => {
    expect(() => parseSpecFrontmatter({ ...FRONTMATTER, title: "" })).toThrow(/Invalid spec frontmatter/);
  });

  it("rejects a revision below 1", () => {
    expect(() => parseSpecFrontmatter({ ...FRONTMATTER, revision: 0 })).toThrow(/Invalid spec frontmatter/);
  });

  it("rejects a status outside the frozen lifecycle", () => {
    expect(() => parseSpecFrontmatter({ ...FRONTMATTER, status: "PENDING" as never })).toThrow(
      /Invalid spec frontmatter/,
    );
  });

  it("rejects a missing tracking repo — a spec has to live somewhere", () => {
    expect(() => parseSpecFrontmatter({ ...FRONTMATTER, trackingRepoKey: "" })).toThrow(
      /Invalid spec frontmatter/,
    );
  });

  it("rejects a non-ISO createdAt", () => {
    expect(() => parseSpecFrontmatter({ ...FRONTMATTER, createdAt: "yesterday" })).toThrow(
      /Invalid spec frontmatter/,
    );
  });
});

describe("rendered document shape", () => {
  it("opens with a YAML frontmatter block", () => {
    const { body } = renderSpec(draft());
    const lines = body.split("\n");

    expect(lines[0]).toBe("---");
    expect(body).toContain("specId: spec-1");
    expect(body).toContain("revision: 1");
    expect(body).toContain("status: DRAFTING");
    expect(lines.indexOf("---", 1)).toBeGreaterThan(0);
  });

  it("renders every template section, in order", () => {
    const { body } = renderSpec(draft());

    let cursor = -1;
    for (const section of SPEC_SECTIONS) {
      const index = body.indexOf(`## ${section.heading}`);
      expect(index, `missing section ${section.heading}`).toBeGreaterThan(-1);
      expect(index, `section ${section.heading} out of order`).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it("titles the document with the spec title", () => {
    const { body } = renderSpec(draft());
    expect(body).toContain("# Deposit retry on mobile web");
  });
});

describe("section content from coverage", () => {
  it("uses the recorded answer for a covered dimension", () => {
    let coverage = createCoverageRecord();
    coverage = recordCoverage(coverage, "problem", {
      state: "COVERED",
      confidence: 1,
      notes: "Deposit retry silently fails on iOS Safari.",
    });

    const { body } = renderSpec(draft({ coverage }));

    expect(body).toContain("Deposit retry silently fails on iOS Safari.");
  });

  it("falls back to the dimension default when nobody answered", () => {
    const { body } = renderSpec(draft());
    // The default is a defensible product position, not a blank — a spec with
    // an empty Rollout section reads as finished when it is not.
    expect(body).toContain("Behind a feature flag, default off");
  });

  it("states the deferral, with its reason, for a deferred dimension", () => {
    const coverage = deferDimension(createCoverageRecord(), "risks", "accepted for v1");
    const { body } = renderSpec(draft({ coverage }));

    expect(body).toMatch(/Deferred.*accepted for v1/);
  });

  it("prefers an explicit section override over coverage", () => {
    let coverage = createCoverageRecord();
    coverage = recordCoverage(coverage, "problem", { state: "COVERED", confidence: 1, notes: "from coverage" });

    const { body } = renderSpec(draft({ coverage, sections: { problem: "hand-written problem" } }));

    expect(body).toContain("hand-written problem");
    expect(body).not.toContain("from coverage");
  });

  it("marks a section with no coverage and no default as not yet specified", () => {
    const { body } = renderSpec(draft());
    expect(body).toContain("_Not yet specified._");
  });
});

describe("open questions", () => {
  it("marks blocking open questions as blocking", () => {
    const { body } = renderSpec(draft({ blockingOpenQuestions: ["rollout: how does this ship?"] }));

    expect(body).toContain("## Open questions");
    expect(body).toContain("**BLOCKING**");
    expect(body).toContain("rollout: how does this ship?");
  });

  it("lists non-blocking questions without the blocking marker", () => {
    const { body } = renderSpec(draft({ openQuestions: ["Do we need analytics on this?"] }));

    expect(body).toContain("Do we need analytics on this?");
    expect(body).not.toContain("**BLOCKING**");
  });

  it("says so explicitly when there are none", () => {
    const { body } = renderSpec(draft());
    expect(body).toContain("_None._");
  });
});

describe("task breakdown", () => {
  it("renders tasks as a checklist with their target repo", () => {
    const { body } = renderSpec(
      draft({
        tasks: [
          { title: "Add retry to the deposit client", codeRepoKey: "home_mobile", kind: "feature" },
          { title: "Remove the dead retry flag", codeRepoKey: "home_mobile", kind: "chore" },
        ],
      }),
    );

    expect(body).toContain("- [ ] Add retry to the deposit client");
    expect(body).toContain("home_mobile");
    expect(body).toContain("chore");
  });

  it("says the breakdown is pending when there are no tasks", () => {
    const { body } = renderSpec(draft());
    expect(body).toContain("## Task breakdown");
  });
});

describe("content hash", () => {
  it("is stable for identical input — replay never depends on GitHub state", () => {
    expect(renderSpec(draft()).contentHash).toBe(renderSpec(draft()).contentHash);
  });

  it("changes when the body changes", () => {
    const before = renderSpec(draft()).contentHash;
    const after = renderSpec(draft({ sections: { problem: "different" } })).contentHash;

    expect(after).not.toBe(before);
  });

  it("changes when the revision changes", () => {
    const before = renderSpec(draft()).contentHash;
    const after = renderSpec(draft({ frontmatter: { ...FRONTMATTER, revision: 2 } })).contentHash;

    expect(after).not.toBe(before);
  });

  it("is a hex sha256", () => {
    expect(renderSpec(draft()).contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("determinism", () => {
  it("renders byte-identical output for identical input", () => {
    expect(renderSpec(draft()).body).toBe(renderSpec(draft()).body);
  });

  it("validates frontmatter as part of rendering", () => {
    expect(() => renderSpec(draft({ frontmatter: { ...FRONTMATTER, title: "" } }))).toThrow(
      /Invalid spec frontmatter/,
    );
  });
});

/**
 * `riskTier` in the frontmatter.
 *
 * The tier is rendered so an approver can see, in the document itself, why one
 * spec needs a second pair of eyes and another does not. That puts it inside
 * the content hash, which is why the stability tests below exist: a previous
 * bug in exactly this area (`createdAt` re-derived from `Date.now()` on read)
 * made unchanged drafts hash differently and created a spurious revision on
 * every redraft.
 */
describe("risk tier in the frontmatter", () => {
  it("renders the tier when the spec carries one", () => {
    const { body } = renderSpec(draft({ frontmatter: { ...FRONTMATTER, riskTier: "critical" } }));
    expect(body).toContain("riskTier: critical");
  });

  it("omits the line entirely when the spec is unclassified", () => {
    const { body } = renderSpec(draft());
    // NOT `riskTier: low` and NOT `riskTier: unknown` — an absent tier must
    // reach `evaluateSpecGate` absent, so the gate substitutes its stricter
    // default rather than reading a value this renderer invented.
    expect(body).not.toContain("riskTier:");
  });

  it("rejects a tier outside the frozen ordering", () => {
    expect(() => parseSpecFrontmatter({ ...FRONTMATTER, riskTier: "catastrophic" })).toThrow(
      /Invalid spec frontmatter/,
    );
  });

  it("hashes differently when the tier changes — the document genuinely differs", () => {
    const low = renderSpec(draft({ frontmatter: { ...FRONTMATTER, riskTier: "low" } })).contentHash;
    const critical = renderSpec(draft({ frontmatter: { ...FRONTMATTER, riskTier: "critical" } })).contentHash;
    expect(low).not.toBe(critical);
  });
});

describe("revision ledger section", () => {
  it("surfaces the six revision ledger fields from structured ledger data", () => {
    const { body, sections } = renderSpec(
      draft({
        ledger: {
          changedSections: [{ id: "problem", heading: "Problem", kind: "changed" }],
          evidenceLinks: [
            {
              href: "https://acme.slack.com/archives/C1/p123",
              label: "Slack thread",
              kind: "slack_thread",
            },
          ],
          owners: [{ role: "requester", name: "U1", slackUserId: "U1" }],
          approvalAction: "approve",
          approvedAt: "2026-08-16T12:00:00.000Z",
        },
      }),
    );

    expect(sections.at(-1)?.id).toBe("revision_ledger");
    expect(body).toContain("**Specification version:** 1");
    expect(body).toContain("**Changed sections:** Problem (changed)");
    expect(body).toContain("**Decision owner:** U1 (requester)");
    expect(body).toContain("[Slack thread](https://acme.slack.com/archives/C1/p123)");
    expect(body).toContain("**Approval or exception:** approve");
    expect(body).toContain("**Timestamp:** 2026-08-16T12:00:00.000Z");
  });

  it("can omit the ledger so a diff does not see the derived section", () => {
    const { sections } = renderSpec(draft({ omitLedger: true }));
    expect(sections.find((s) => s.id === "revision_ledger")).toBeUndefined();
  });
});

describe("hash stability across the wall clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hashes a tiered spec identically when nothing but the clock has moved", () => {
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2026-08-16T01:00:00.000Z"));
    const first = renderSpec(draft({ frontmatter: { ...FRONTMATTER, riskTier: "high" } }));

    // Six days later, same answers, same tier. If any part of rendering reaches
    // for the current time, this is where it shows up.
    vi.setSystemTime(new Date("2026-08-22T17:43:11.000Z"));
    const second = renderSpec(draft({ frontmatter: { ...FRONTMATTER, riskTier: "high" } }));

    expect(second.contentHash).toBe(first.contentHash);
    expect(second.body).toBe(first.body);
  });

  it("hashes an untiered spec identically across the clock too", () => {
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2026-08-16T01:00:00.000Z"));
    const first = renderSpec(draft());
    vi.setSystemTime(new Date("2027-01-02T09:15:00.000Z"));
    const second = renderSpec(draft());

    expect(second.contentHash).toBe(first.contentHash);
  });
});
