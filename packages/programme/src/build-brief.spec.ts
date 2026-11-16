import { describe, it, expect } from "vitest";
import { buildTaskBrief, InvalidBuildBriefError, type BuildBriefArgs } from "./build-brief";

const args = (overrides: Partial<BuildBriefArgs> = {}): BuildBriefArgs => ({
  attemptId: "attempt-1",
  buildTaskId: "prog:m1:screen-home",
  programmeKey: "prog",
  milestone: { id: "m1", ordinal: 1, title: "Shell" },
  spec: {
    specId: "spec-1",
    trackingRepoSlug: "acme/web-app-ai",
    issueNumber: 12,
    revision: 3,
    contentHash: "deadbeef",
  },
  acceptanceCriteria: [{ id: "AC-aaaa1111", text: "Home renders the account switcher" }],
  constraints: { testKinds: ["unit"] },
  trustedInstruction: "Implement the Home screen per the design context.",
  attempt: 1,
  taskKind: "screen",
  ...overrides,
});

describe("buildTaskBrief", () => {
  it("composes a v1 brief deterministically", () => {
    const brief = buildTaskBrief(args());
    expect(brief.briefVersion).toBe(1);
    expect(brief.attemptId).toBe("attempt-1");
    expect(brief.fileManifestHints).toEqual([]);
    expect(brief.dependencies).toEqual([]);
    expect(buildTaskBrief(args())).toEqual(brief);
  });

  it("refuses a brief with no acceptance criteria — the evidence loop would be vacuous", () => {
    expect(() => buildTaskBrief(args({ acceptanceCriteria: [] }))).toThrow(InvalidBuildBriefError);
  });

  it("refuses an empty trusted instruction", () => {
    expect(() => buildTaskBrief(args({ trustedInstruction: "   " }))).toThrow(InvalidBuildBriefError);
  });

  it("refuses when untrusted context leaks into the trusted instruction (quarantine)", () => {
    expect(() =>
      buildTaskBrief(
        args({
          trustedInstruction: "Do the thing. Reporter says: the app is broken",
          untrustedContext: "the app is broken",
        }),
      ),
    ).toThrow(/quarantine/);
  });

  it("omits untrustedContext entirely when not supplied", () => {
    expect("untrustedContext" in buildTaskBrief(args())).toBe(false);
  });
});
