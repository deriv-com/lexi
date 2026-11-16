import { describe, expect, it } from "vitest";

import { createCoverageRecord } from "./coverage";
import { diffSpecRevisions, summariseSpecDiff } from "./spec-diff";
import {
  renderSpec,
  SPEC_OPEN_QUESTIONS_SECTION_ID,
  SPEC_TASK_BREAKDOWN_SECTION_ID,
  type SpecDraftInput,
  type SpecFrontmatter,
} from "./spec-template";

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
  } as SpecDraftInput;
}

describe("renderSpec section map", () => {
  it("emits every template section plus the two trailing ones", () => {
    const rendered = renderSpec(draft());
    const ids = rendered.sections.map((s) => s.id);

    expect(ids).toContain("problem");
    expect(ids).toContain("acceptance_criteria");
    expect(ids).toContain(SPEC_OPEN_QUESTIONS_SECTION_ID);
    expect(ids).toContain(SPEC_TASK_BREAKDOWN_SECTION_ID);
    // Trailing sections come last, in render order.
    expect(ids.at(-3)).toBe(SPEC_OPEN_QUESTIONS_SECTION_ID);
    expect(ids.at(-2)).toBe(SPEC_TASK_BREAKDOWN_SECTION_ID);
    expect(ids.at(-1)).toBe("revision_ledger");
  });

  it("keeps the section map and the body in paired order, not as a bag of substrings", () => {
    // A substring check cannot catch emit() attaching the wrong body to an id:
    // both strings still appear in `body`. Pairing requires each section's
    // heading to precede its own body, in render order, with no later section
    // claiming an earlier unique body.
    const rendered = renderSpec(
      draft({
        sections: {
          problem: "UNIQUE_PROBLEM_BODY",
          scope: "UNIQUE_SCOPE_BODY",
          acceptance_criteria: "UNIQUE_AC_BODY",
        },
        openQuestions: ["Which PSPs are affected?"],
        tasks: [{ title: "Add retry telemetry", kind: "chore" }],
      }),
    );

    let cursor = 0;
    for (const section of rendered.sections) {
      const headingAt = rendered.body.indexOf(`## ${section.heading}`, cursor);
      expect(headingAt, `heading ${section.id}`).toBeGreaterThanOrEqual(cursor);
      const bodyAt = rendered.body.indexOf(section.body, headingAt);
      expect(bodyAt, `body ${section.id}`).toBeGreaterThan(headingAt);
      cursor = bodyAt + section.body.length;
    }
  });

  it("pins the rendered body hash so an emit() refactor cannot silently rewrite stored documents", () => {
    // Not "two identical calls agree with each other" — that passes after any
    // format change. This pins the bytes a stored contentHash is taken from.
    const rendered = renderSpec(
      draft({
        sections: { problem: "Deposits fail silently on retry." },
        openQuestions: ["Which PSPs?"],
        blockingOpenQuestions: ["Do we hold the release?"],
        tasks: [{ title: "Add retry telemetry", kind: "chore", notes: "p75 only" }],
      }),
    );
    expect(rendered.body).toContain("- **BLOCKING** Do we hold the release?");
    expect(rendered.body).toContain("- [ ] Add retry telemetry _(chore)_");
    expect(rendered.body).toContain("      p75 only");
    expect(rendered.contentHash).toBe(
      "553f96c05bc0b0253e4973eaf6db258f71ab85062441e2d046122ec4c4e3f864",
    );
  });
});

describe("diffSpecRevisions", () => {
  it("reports no changes between identical revisions", () => {
    const rendered = renderSpec(draft());
    const diff = diffSpecRevisions({ rendered }, { rendered });

    expect(diff.hasChanges).toBe(false);
    expect(diff.changed).toEqual([]);
    expect(diff.sections.every((s) => s.kind === "unchanged")).toBe(true);
  });

  it("detects a changed section and carries both texts", () => {
    const before = renderSpec(draft({ sections: { problem: "Deposits fail." } }));
    const after = renderSpec(
      draft({ sections: { problem: "Deposits fail silently on retry." } }),
    );

    const diff = diffSpecRevisions({ rendered: before }, { rendered: after });

    expect(diff.hasChanges).toBe(true);
    const problem = diff.changed.find((s) => s.id === "problem");
    expect(problem?.kind).toBe("changed");
    expect(problem?.before).toBe("Deposits fail.");
    expect(problem?.after).toBe("Deposits fail silently on retry.");
  });

  it("does not report a section changed on whitespace alone", () => {
    const before = renderSpec(draft({ sections: { problem: "Deposits fail." } }));
    const after = renderSpec(draft({ sections: { problem: "  Deposits fail.  " } }));

    const diff = diffSpecRevisions({ rendered: before }, { rendered: after });
    expect(diff.changed.find((s) => s.id === "problem")).toBeUndefined();
  });

  it("is not fooled by a section body that looks like a heading", () => {
    // The reason this diffs the section map instead of the rendered markdown: a
    // requester can legitimately type a Markdown heading into an answer, and a
    // body parser would split the document there.
    const before = renderSpec(draft({ sections: { problem: "Deposits fail." } }));
    const after = renderSpec(
      draft({
        sections: {
          // Two headings inside one answer. The second deliberately reuses a
          // REAL template heading ("Metrics"), which is the case a body parser
          // gets most wrong: it would attribute this prose to the Metrics
          // section and report that section as changed when it was not touched.
          problem:
            "## Injected heading\n\nStaged behind a flag.\n\n## Metrics\n\nRetry success rate.",
        },
      }),
    );

    const diff = diffSpecRevisions({ rendered: before }, { rendered: after });

    // Exactly one section moved — the one actually edited.
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.id).toBe("problem");
    // The invented heading did not become a section of its own.
    expect(diff.sections.filter((s) => s.heading === "Injected heading")).toEqual([]);
    // And the real Metrics section is untouched, not captured by the text that
    // happens to carry its heading.
    expect(diff.sections.find((s) => s.id === "metrics")?.kind).toBe("unchanged");
    expect(diff.sections.find((s) => s.id === "metrics")?.after).not.toContain(
      "Retry success rate.",
    );
  });

  it("reports a section present only in the newer revision as added", () => {
    const before = renderSpec(draft());
    const after = renderSpec(draft());
    // Simulate a template gaining a section.
    const grown = {
      ...after,
      sections: [...after.sections, { id: "compliance_notes", heading: "Compliance notes", body: "Staged." }],
    };

    const diff = diffSpecRevisions({ rendered: before }, { rendered: grown });
    const added = diff.changed.find((s) => s.id === "compliance_notes");
    expect(added?.kind).toBe("added");
    expect(added?.after).toBe("Staged.");
    expect(added?.before).toBeUndefined();
  });

  it("appends a removed section rather than interleaving it", () => {
    const after = renderSpec(draft());
    const before = {
      ...after,
      sections: [
        { id: "legacy", heading: "Legacy notes", body: "Old approach." },
        ...after.sections,
      ],
    };

    const diff = diffSpecRevisions({ rendered: before }, { rendered: after });
    const removed = diff.sections.at(-1);
    expect(removed?.id).toBe("legacy");
    expect(removed?.kind).toBe("removed");
    expect(removed?.before).toBe("Old approach.");
    expect(removed?.after).toBeUndefined();
  });

  it("matches sections by id, so rewording a heading is not a change", () => {
    const before = renderSpec(draft({ sections: { scope: "Retry once." } }));
    const after = renderSpec(draft({ sections: { scope: "Retry once." } }));
    const reworded = {
      ...after,
      sections: after.sections.map((s) =>
        s.id === "scope" ? { ...s, heading: "Scope for v1" } : s,
      ),
    };

    const diff = diffSpecRevisions({ rendered: before }, { rendered: reworded });
    const scope = diff.sections.find((s) => s.id === "scope");
    expect(scope?.kind).toBe("unchanged");
    // Displays the current wording, not the historical one.
    expect(scope?.heading).toBe("Scope for v1");
  });

  it("reports frontmatter moves when frontmatter is supplied", () => {
    const rendered = renderSpec(draft());
    const diff = diffSpecRevisions(
      { rendered, frontmatter: FRONTMATTER },
      {
        rendered,
        frontmatter: { ...FRONTMATTER, status: "APPROVED", riskTier: "high", revision: 2 },
      },
    );

    expect(diff.hasChanges).toBe(true);
    const status = diff.frontmatter.find((f) => f.field === "status");
    expect(status).toEqual({ field: "status", before: "DRAFT_READY", after: "APPROVED" });
    const tier = diff.frontmatter.find((f) => f.field === "riskTier");
    expect(tier).toEqual({ field: "riskTier", before: undefined, after: "high" });
    // `revision` itself is the diff's premise, never a finding.
    expect(diff.frontmatter.find((f) => f.field === "revision")).toBeUndefined();
  });

  it("reports no frontmatter findings only when both sides omit frontmatter", () => {
    const rendered = renderSpec(draft());
    const diff = diffSpecRevisions({ rendered }, { rendered });
    expect(diff.frontmatter).toEqual([]);
  });

  it("reports title and status when only one side supplies frontmatter", () => {
    const rendered = renderSpec(draft());
    const oneSided = diffSpecRevisions({ rendered, frontmatter: FRONTMATTER }, { rendered });
    expect(oneSided.frontmatter.find((f) => f.field === "title")).toEqual({
      field: "title",
      before: FRONTMATTER.title,
      after: undefined,
    });
    expect(oneSided.frontmatter.find((f) => f.field === "status")).toEqual({
      field: "status",
      before: "DRAFT_READY",
      after: undefined,
    });
  });

  it("ignores a mutated body when the section map is unchanged", () => {
    // The central invariant: never parse rendered.body. If a later fallback
    // started splitting the markdown, this case would start reporting a change.
    const before = renderSpec(draft({ sections: { problem: "Deposits fail." } }));
    const after = {
      ...before,
      body: before.body.replace("Deposits fail.", "TAMPERED — looks like a heading\n\n## Metrics"),
    };
    const diff = diffSpecRevisions({ rendered: before }, { rendered: after });
    expect(diff.hasChanges).toBe(false);
    expect(diff.changed).toEqual([]);
  });

  it("throws on a duplicate section id rather than dropping one side", () => {
    const rendered = renderSpec(draft());
    const duplicated = {
      ...rendered,
      sections: [...rendered.sections, rendered.sections[0]!],
    };
    expect(() => diffSpecRevisions({ rendered: duplicated }, { rendered })).toThrow(/Duplicate spec section id/);
  });

  it("detects an acceptance-criteria change, which is the one reviewers care about", () => {
    const before = renderSpec(
      draft({ sections: { acceptance_criteria: "Retry succeeds within 3 attempts." } }),
    );
    const after = renderSpec(
      draft({
        sections: {
          acceptance_criteria: "Retry succeeds within 3 attempts.\nFailure surfaces a toast.",
        },
      }),
    );

    const diff = diffSpecRevisions({ rendered: before }, { rendered: after });
    expect(diff.changed.map((s) => s.id)).toContain("acceptance_criteria");
  });
});

describe("summariseSpecDiff", () => {
  it("says so plainly when nothing moved", () => {
    const rendered = renderSpec(draft());
    const summary = summariseSpecDiff(diffSpecRevisions({ rendered }, { rendered }));
    expect(summary).toBe("No content changes between these revisions.");
  });

  it("lists frontmatter moves and section changes without pasting bodies", () => {
    const before = renderSpec(draft({ sections: { problem: "Short." } }));
    const after = renderSpec(
      draft({ sections: { problem: "A very long restatement of the problem.".repeat(20) } }),
    );

    const summary = summariseSpecDiff(
      diffSpecRevisions(
        { rendered: before, frontmatter: FRONTMATTER },
        { rendered: after, frontmatter: { ...FRONTMATTER, status: "APPROVED" } },
      ),
    );

    expect(summary).toContain("status: DRAFT_READY → APPROVED");
    expect(summary).toContain("Problem: changed");
    // The body is not in the summary.
    expect(summary).not.toContain("A very long restatement");
  });

  it("renders an unset value as (unset) rather than undefined", () => {
    const rendered = renderSpec(draft());
    const summary = summariseSpecDiff(
      diffSpecRevisions(
        { rendered, frontmatter: FRONTMATTER },
        { rendered, frontmatter: { ...FRONTMATTER, riskTier: "medium" } },
      ),
    );
    expect(summary).toContain("riskTier: (unset) → medium");
  });
});
