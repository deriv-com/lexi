import { describe, it, expect } from "vitest";
import {
  MILESTONE_REVIEW_ACTIONS,
  milestoneReviewBlocks,
  milestoneReviewFallbackText,
  parseMilestoneReviewClick,
} from "./milestone-review-blocks";

const blockArgs = {
  programmeKey: "web-site-rebuild",
  programmeTitle: "Acme Web web rebuild",
  milestoneId: "m2",
  milestoneOrdinal: 2,
  milestoneTitle: "Trading shell",
  tasksMerged: 7,
  tasksTotal: 7,
  headSha: "abc123def4567890",
  acSummary: "12/12 criteria green",
  evidenceLinks: [{ label: "e2e run", url: "https://example.test/run/1" }],
};

describe("milestoneReviewBlocks", () => {
  it("carries the milestone id and head SHA in both button values", () => {
    const blocks = milestoneReviewBlocks(blockArgs) as Array<{
      type: string;
      elements?: Array<{ action_id: string; value: string }>;
    }>;
    const actions = blocks.find((block) => block.type === "actions");
    expect(actions?.elements).toHaveLength(2);
    for (const element of actions?.elements ?? []) {
      expect(JSON.parse(element.value)).toEqual({ milestoneId: "m2", headSha: "abc123def4567890" });
    }
  });

  it("renders an explicit refusal line when there are no evidence links", () => {
    const blocks = milestoneReviewBlocks({ ...blockArgs, evidenceLinks: [] });
    expect(JSON.stringify(blocks)).toContain("treat as a refusal to review");
  });
});

describe("parseMilestoneReviewClick", () => {
  const value = JSON.stringify({ milestoneId: "m2", headSha: "abc123" });

  it("round-trips both decisions", () => {
    expect(parseMilestoneReviewClick(MILESTONE_REVIEW_ACTIONS.APPROVE, value)).toEqual({
      decision: "approve",
      milestoneId: "m2",
      reviewedSha: "abc123",
    });
    expect(parseMilestoneReviewClick(MILESTONE_REVIEW_ACTIONS.REQUEST_CHANGES, value)).toEqual({
      decision: "request_changes",
      milestoneId: "m2",
      reviewedSha: "abc123",
    });
  });

  it("returns null for foreign action ids, malformed JSON, and empty fields", () => {
    expect(parseMilestoneReviewClick("spec_approval_approve", value)).toBeNull();
    expect(parseMilestoneReviewClick(MILESTONE_REVIEW_ACTIONS.APPROVE, "not json")).toBeNull();
    expect(
      parseMilestoneReviewClick(
        MILESTONE_REVIEW_ACTIONS.APPROVE,
        JSON.stringify({ milestoneId: "", headSha: "x" }),
      ),
    ).toBeNull();
  });
});

describe("milestoneReviewBlocks stays inside Slack's limits", () => {
  // Slack rejects the whole message with `invalid_blocks` if any single
  // section exceeds 3000 characters. A milestone of a few dozen tasks has
  // an evidence list well past that, so an unpacked card would never post.
  const manyLinks = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      label: `PR #${100 + i} — [PROGRAMME-BUILD task:acme-web:acme-web:m1:screen-${i}]`,
      url: `https://github.com/acme/web-rebuild/pull/${100 + i}`,
    }));

  const sectionTexts = (blocks: unknown[]) =>
    blocks
      .filter((b): b is { type: string; text: { text: string } } => {
        const block = b as { type?: string; text?: { text?: unknown } };
        return block.type === "section" && typeof block.text?.text === "string";
      })
      .map((b) => b.text.text);

  it("splits a 37-task evidence list across sections, each under the cap", () => {
    const blocks = milestoneReviewBlocks({ ...blockArgs, evidenceLinks: manyLinks(37) });
    const texts = sectionTexts(blocks);
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(3000);

    // Every link is still reachable — splitting must not lose evidence.
    const all = texts.join("\n");
    for (const link of manyLinks(37)) expect(all).toContain(link.url);
  });

  it("caps an absurd list and says how many it left out rather than dropping them silently", () => {
    const blocks = milestoneReviewBlocks({ ...blockArgs, evidenceLinks: manyLinks(2000) });
    const texts = sectionTexts(blocks);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(3000);
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(texts.join("\n")).toMatch(/and \d+ more not shown/);
  });

  it("clamps a header longer than Slack allows", () => {
    const blocks = milestoneReviewBlocks({
      ...blockArgs,
      programmeTitle: "x".repeat(400),
      evidenceLinks: manyLinks(2),
    });
    const header = blocks[0] as { text: { text: string } };
    expect(header.text.text.length).toBeLessThanOrEqual(150);
  });

  it("keeps the no-evidence refusal as a section", () => {
    const blocks = milestoneReviewBlocks({ ...blockArgs, evidenceLinks: [] });
    expect(sectionTexts(blocks).join("\n")).toContain("No evidence links recorded");
  });
});

describe("milestoneReviewFallbackText", () => {
  it("names the milestone, the counts and the head so a failed card still informs", () => {
    const text = milestoneReviewFallbackText({ ...blockArgs, evidenceLinks: [] });
    expect(text).toContain(blockArgs.milestoneId);
    expect(text).toContain(blockArgs.programmeKey);
    expect(text).toContain(`${blockArgs.tasksMerged}/`);
    expect(text).toContain("could not be rendered");
  });
});
