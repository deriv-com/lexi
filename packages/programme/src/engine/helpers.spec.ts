import { describe, expect, it } from "vitest";
import { isProgrammeBuildResult } from "./helpers";

/**
 * `result.json` is composed by the workflow's `publish` job from a hand-off the
 * agent's job wrote. The run state there has a fourth value, `drafted` (a
 * technical spec was written, so no RED/GREEN/checks ran). It must never be
 * read as a result: a result is shipped, handed back or failed, and "shipped"
 * is then judged on the orchestrator's own record of the task's kind and the
 * evidence it holds.
 */
describe("isProgrammeBuildResult", () => {
  const base = { schemaVersion: 1, taskId: "T-1", attemptId: "A-1" };

  it("accepts the three result statuses", () => {
    for (const status of ["shipped", "handback", "failed"]) {
      expect(isProgrammeBuildResult({ ...base, status })).toBe(true);
    }
  });

  it("refuses the workflow's internal 'drafted' state, whatever task kind the payload claims", () => {
    expect(isProgrammeBuildResult({ ...base, status: "drafted" })).toBe(false);
    expect(isProgrammeBuildResult({ ...base, status: "drafted", taskKind: "technical-spec", prNumber: 7 })).toBe(false);
    expect(isProgrammeBuildResult({ ...base, status: "pending" })).toBe(false);
  });

  it("refuses a payload without the identifying fields", () => {
    expect(isProgrammeBuildResult({ ...base, schemaVersion: 2, status: "shipped" })).toBe(false);
    expect(isProgrammeBuildResult({ schemaVersion: 1, status: "shipped" })).toBe(false);
    expect(isProgrammeBuildResult(null)).toBe(false);
  });
});
