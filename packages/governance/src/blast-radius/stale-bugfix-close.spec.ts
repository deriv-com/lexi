/**
 * The one pull-request close automation may perform, and the general close it
 * must not loosen.
 */
import { describe, it, expect } from "vitest";
import { classifyAction, isProhibited, STALE_BUGFIX_PULL_REQUEST_CLOSE } from "./index";
import { formatGracePeriod } from "../capability-matrix/capability-matrix";

describe("stale bug-fix pull request close", () => {
  it("is a delayed action with a 20 hour minimum wait and no confirmation", () => {
    const c = classifyAction(STALE_BUGFIX_PULL_REQUEST_CLOSE);
    expect(c.actionClass).toBe("delayed_reversible");
    expect(c.requiresConfirmation).toBe(false);
    expect(c.gracePeriodMs).toBe(20 * 60 * 60 * 1000);
  });

  it("says honestly that a closed PR is not put back", () => {
    expect(classifyAction(STALE_BUGFIX_PULL_REQUEST_CLOSE).reversible).toBe(false);
  });

  it("leaves the general pull_request.close prohibited", () => {
    expect(isProhibited("pull_request.close")).toBe(true);
    expect(isProhibited(STALE_BUGFIX_PULL_REQUEST_CLOSE)).toBe(false);
  });
});

describe("formatGracePeriod", () => {
  it.each([
    [0, "—"],
    [3 * 24 * 60 * 60 * 1000, "3d"],
    [20 * 60 * 60 * 1000, "20h"],
    [36 * 60 * 60 * 1000, "36h"],
  ])("renders %d ms as %s", (ms, expected) => {
    expect(formatGracePeriod(ms)).toBe(expected);
  });
});
