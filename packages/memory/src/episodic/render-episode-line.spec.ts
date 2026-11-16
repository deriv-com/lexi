import { describe, it, expect } from "vitest";
import type { MemoryEpisodeRecord } from "@lexi/contracts";
import { renderEpisodeLine } from "./render-episode-line";

/**
 * The prompt line for one recalled episode.
 *
 * The property under test is that a superseded fact cannot reach the prompt
 * looking current. `temporalStatus` being right on the record is not enough —
 * the model reads the rendered block, and the block used to render every
 * episode identically, so a retracted rule arrived indistinguishable from the
 * rule that replaced it.
 */
function episode(overrides: Partial<MemoryEpisodeRecord> = {}): MemoryEpisodeRecord {
  return {
    id: "e1",
    scope: "org",
    kind: "decision",
    content: "release candidate branches use a hyphen",
    importance: 0.9,
    confidence: 1,
    provenance: {},
    createdAt: "2026-08-01T09:00:00.000Z",
    temporalStatus: "current",
    ...overrides,
  };
}

describe("renderEpisodeLine", () => {
  it("renders a current episode exactly as before", () => {
    // Byte-identical to the inline template this replaced. If this changes,
    // every turn's memory block moves at once and the change is
    // unattributable.
    expect(renderEpisodeLine(episode())).toBe("- (decision) release candidate branches use a hyphen");
  });

  it("marks a superseded episode as no longer current, with the date", () => {
    const line = renderEpisodeLine(
      episode({
        temporalStatus: "historical",
        supersededById: "e2",
        supersededAt: "2026-05-04T14:22:00.000Z",
        validUntil: "2026-05-04T14:22:00.000Z",
      }),
    );

    expect(line).toContain("no longer current");
    expect(line).toContain("2026-05-04");
    // The content still comes through — a stale fact is evidence, not noise.
    expect(line).toContain("release candidate branches use a hyphen");
  });

  it("still marks it when the date is missing rather than falling back to looking current", () => {
    // A row superseded before `supersededAt` existed, or by a store that did
    // not set it. "No longer current" with no date is far better than a line
    // that reads as present tense.
    const line = renderEpisodeLine(episode({ temporalStatus: "historical" }));
    expect(line).toContain("no longer current");
    expect(line).not.toContain("since");
  });

  it("falls back to validUntil when supersededAt is absent", () => {
    const line = renderEpisodeLine(episode({ temporalStatus: "historical", validUntil: "2026-07-15T00:00:00.000Z" }));
    expect(line).toContain("2026-07-15");
  });

  it("ignores an unparseable date rather than rendering Invalid Date", () => {
    const line = renderEpisodeLine(episode({ temporalStatus: "historical", supersededAt: "not-a-date" }));
    expect(line).toContain("no longer current");
    expect(line).not.toContain("Invalid");
  });

  it("treats a record with no temporalStatus as current", () => {
    // Rows read before supersession shipped, and any store double that does
    // not populate it. Absent must not mean "historical".
    const { temporalStatus: _dropped, ...withoutStatus } = episode();
    expect(renderEpisodeLine(withoutStatus as MemoryEpisodeRecord)).not.toContain("no longer current");
  });
});
