import { describe, it, expect } from "vitest";
import {
  callerDefaultMaxSessions,
  clampForSlack,
  parseBuildComment,
  parseSessionReport,
  progressStatusLine,
  runApp,
  runMaxSessions,
} from "./report";

/** Shape of what `app-build/report.sh` posts, with the newer markers. */
const REPORT_WITH_MARKERS = [
  "<!-- app-build:report -->",
  "<!-- app-build:feedback-read-at=2026-10-02T04:20:45Z -->",
  "<!-- app-build:session app=web session=3 phase=spec -->",
  "## Session 3 — Acme Markets web app",
  "",
  "[Run log](https://github.com/acme/markets-web/actions/runs/111) · commit `abc1234` · [progress](https://github.com/x)",
  "",
  "# Last session",
  "Wrote the login and sign-up spec from user-journey.md.",
  "- Mapped Ory self-service flows to screens",
  "",
  "## Questions only a person can answer",
  "1. Should RoW sign-up ask for a referral code?",
  "2. **Which** country list applies to RoW?",
  "",
  "Cost this session: $14.20 (Opus 5.5 + Sonnet 5.5)",
  "",
  "### Phase gate",
  "Verdict: PASS — the spec covers milestone 1; advance to plan.",
  "",
  "### Checks",
  "",
  "| Check | Result | Time |",
  "|---|---|---|",
  "| types | ✅ pass | 12s |",
  "| lint | ❌ fail | 3s |",
  "| unit | ➖ missing | 0s |",
  "",
  "_Session 4 starts now. Comment here any time to steer it: each session reads every comment posted since the previous session started._",
].join("\n");

const OLD_STOPPED_REPORT = [
  "<!-- app-build:report -->",
  "## Session 12 — Acme Markets mobile app",
  "",
  "[Run log](https://github.com/acme/markets-web/actions/runs/222) · commit `def5678`",
  "",
  "_The builder did not write LAST_SESSION.md this session._",
  "",
  "### Checks",
  "",
  "_Checks did not run._",
  "",
  "_The build loop stopped: it reached max_sessions (12)._",
].join("\n");

const ASSESSMENT = [
  "<!-- app-build:assessment app=web session=3 -->",
  "## Assessment of session 3",
  "| Check | Result |",
  "|---|---|",
  "| build | ✅ pass |",
  "| e2e | ❌ fail |",
  "Review: 1 blocker, 2 majors",
].join("\n");

describe("parseSessionReport", () => {
  it("reads every field from a report with the session marker", () => {
    const r = parseSessionReport(REPORT_WITH_MARKERS);
    expect(r.app).toBe("web");
    expect(r.session).toBe(3);
    expect(r.phase).toBe("spec");
    expect(r.runUrl).toBe("https://github.com/acme/markets-web/actions/runs/111");
    expect(r.questions).toEqual([
      "Should RoW sign-up ask for a referral code?",
      "Which country list applies to RoW?",
    ]);
    expect(r.cost).toBe("Cost this session: $14.20 (Opus 5.5 + Sonnet 5.5)");
    expect(r.gateVerdict).toBe("Verdict: PASS — the spec covers milestone 1; advance to plan.");
    expect(r.checks).toEqual({ pass: 1, fail: 1, missing: 1 });
    expect(r.summary).toContain("Wrote the login and sign-up spec");
    expect(r.summary).not.toContain("referral");
    expect(r.continuing).toBe(true);
    expect(r.stopReason).toBeNull();
  });

  it("falls back to the heading for an older report and reads the stop reason", () => {
    const r = parseSessionReport(OLD_STOPPED_REPORT);
    expect(r.app).toBe("mobile");
    expect(r.session).toBe(12);
    expect(r.phase).toBeNull();
    expect(r.stopReason).toBe("it reached max_sessions (12)");
    expect(r.continuing).toBe(false);
    expect(r.questions).toEqual([]);
    expect(r.cost).toBeNull();
    expect(r.gateVerdict).toBeNull();
  });

  it("treats a 'None' questions section as no questions", () => {
    const body = REPORT_WITH_MARKERS.replace(
      /## Questions only a person can answer\n1\.[^\n]*\n2\.[^\n]*/,
      "## Questions only a person can answer\nNone.",
    );
    expect(parseSessionReport(body).questions).toEqual([]);
  });
});

describe("parseBuildComment", () => {
  it("tells reports, assessments and ordinary comments apart", () => {
    expect(parseBuildComment(REPORT_WITH_MARKERS)?.kind).toBe("report");
    const a = parseBuildComment(ASSESSMENT);
    expect(a?.kind).toBe("assessment");
    if (a?.kind !== "assessment") throw new Error("unreachable");
    expect(a.app).toBe("web");
    expect(a.session).toBe(3);
    expect(a.checks).toEqual({ pass: 1, fail: 1, missing: 0 });
    expect(a.blockers).toBe(1);
    expect(a.majors).toBe(2);
    expect(parseBuildComment("Feedback from Mallory via Slack:\n\nuse the darker blue")).toBeNull();
  });
});

describe("run and caller helpers", () => {
  it("attributes a run to an app only when its title names exactly one", () => {
    expect(runApp({ displayTitle: "Lexi app build — web session 3 of 12" })).toBe("web");
    expect(runApp({ displayTitle: "Lexi app build — mobile session 1" })).toBe("mobile");
    expect(runApp({ displayTitle: "Lexi app build" })).toBeNull();
    expect(runMaxSessions({ displayTitle: "Lexi app build — web session 3 of 12" })).toBe(12);
    expect(runMaxSessions({ displayTitle: "Lexi app build" })).toBeNull();
  });

  it("reads the caller's per-app default max_sessions", () => {
    const yaml = "max_sessions: ${{ inputs.max_sessions != '' && inputs.max_sessions || (inputs.app == 'mobile' && '18' || '12') }}";
    expect(callerDefaultMaxSessions(yaml, "web")).toBe(12);
    expect(callerDefaultMaxSessions(yaml, "mobile")).toBe(18);
    expect(callerDefaultMaxSessions("description: Empty = 10 for web, 14 for mobile.", "mobile")).toBe(14);
    expect(callerDefaultMaxSessions("nothing here", "web")).toBeNull();
  });

  it("reads a single-app caller's default max_sessions", () => {
    const yaml = "max_sessions: ${{ inputs.max_sessions != '' && inputs.max_sessions || '20' }}";
    expect(callerDefaultMaxSessions(yaml, "web")).toBe(20);
    expect(callerDefaultMaxSessions(yaml, "mobile")).toBe(20);
    expect(callerDefaultMaxSessions("description: Hard cap on sessions, and so on spend. Empty = 20.", "web")).toBe(20);
    // The per-app form still wins when both are present.
    const both = "Empty = 10 for web, 14 for mobile.\nmax_sessions: ${{ inputs.max_sessions != '' && inputs.max_sessions || '20' }}";
    expect(callerDefaultMaxSessions(both, "web")).toBe(10);
  });

  it("returns PROGRESS.md's Status line only", () => {
    expect(progressStatusLine("\nStatus: building — milestone 1\n\nmore")).toBe("Status: building — milestone 1");
    expect(progressStatusLine("# Progress")).toBeNull();
    expect(progressStatusLine(null)).toBeNull();
  });

  it("keeps Slack text under the 3000-character section cap", () => {
    const clamped = clampForSlack("x".repeat(10_000));
    expect(clamped.length).toBeLessThanOrEqual(2900);
    expect(clamped).toMatch(/full text is on the PR/);
    expect(clampForSlack("short")).toBe("short");
  });
});
