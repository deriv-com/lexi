import { describe, expect, it, vi } from "vitest";
import {
  correlateDispatchedRun,
  dispatchSearchFloor,
  runLinkSuffix,
  slackRunLink,
  DISPATCH_CLOCK_SKEW_MS,
} from "./correlate-dispatched-run";
import type { DispatchedWorkflowRun } from "./types";

const RUN: DispatchedWorkflowRun = {
  runId: 123,
  runUrl: "https://github.com/o/r/actions/runs/123",
  status: "queued",
};

/** No real waiting — a retry loop should cost a test nothing. */
const noWait = () => Promise.resolve();

describe("dispatchSearchFloor", () => {
  it("searches from BEFORE the dispatch, because GitHub's created_at can precede our clock", () => {
    const at = new Date("2026-08-25T10:00:00.000Z");
    expect(dispatchSearchFloor(at).toISOString()).toBe("2026-08-25T09:59:30.000Z");
    expect(at.getTime() - dispatchSearchFloor(at).getTime()).toBe(DISPATCH_CLOCK_SKEW_MS);
  });
});

describe("correlateDispatchedRun", () => {
  it("returns the run when it is found on the first look", async () => {
    const find = vi.fn().mockResolvedValue(RUN);
    const run = await correlateDispatchedRun(find, "o", "r", "w.yml", new Date(), { wait: noWait });
    expect(run).toEqual(RUN);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("retries while the run has not registered yet, then returns it", async () => {
    // The reason this helper exists: a single lookup loses a run that is
    // milliseconds late, which is what left `Run:` lines empty.
    const find = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(RUN);
    const run = await correlateDispatchedRun(find, "o", "r", "w.yml", new Date(), { wait: noWait });
    expect(run).toEqual(RUN);
    expect(find).toHaveBeenCalledTimes(3);
  });

  it("gives up after the configured attempts rather than looping forever", async () => {
    const find = vi.fn().mockResolvedValue(null);
    const run = await correlateDispatchedRun(find, "o", "r", "w.yml", new Date(), {
      attempts: 2,
      wait: noWait,
    });
    expect(run).toBeNull();
    expect(find).toHaveBeenCalledTimes(2);
  });

  it("treats a missing provider method as 'no link', not an error", async () => {
    await expect(correlateDispatchedRun(undefined, "o", "r", "w.yml", new Date())).resolves.toBeNull();
  });

  it("NEVER throws — the dispatch already succeeded, so a lookup failure must not surface as one", async () => {
    const onError = vi.fn();
    const find = vi.fn().mockRejectedValue(new Error("GitHub 500"));
    const run = await correlateDispatchedRun(find, "o", "r", "w.yml", new Date(), {
      wait: noWait,
      onError,
    });
    expect(run).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("stops looking after an error instead of hammering a failing API", async () => {
    const find = vi.fn().mockRejectedValue(new Error("GitHub 500"));
    await correlateDispatchedRun(find, "o", "r", "w.yml", new Date(), { wait: noWait, onError: () => {} });
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("passes excludeRunIds through so neighbouring dispatches cannot claim one run", async () => {
    const find = vi.fn().mockResolvedValue(RUN);
    await correlateDispatchedRun(find, "o", "r", "w.yml", new Date(), {
      excludeRunIds: [7, 8],
      nameContains: "ISSUE-4",
      wait: noWait,
    });
    expect(find).toHaveBeenCalledWith("o", "r", "w.yml", expect.any(Date), [7, 8], "ISSUE-4");
  });

  it("does not sleep before the first attempt", async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    await correlateDispatchedRun(vi.fn().mockResolvedValue(RUN), "o", "r", "w.yml", new Date(), { wait });
    expect(wait).not.toHaveBeenCalled();
  });

  it("always makes at least one attempt, even if asked for zero", async () => {
    const find = vi.fn().mockResolvedValue(null);
    await correlateDispatchedRun(find, "o", "r", "w.yml", new Date(), { attempts: 0, wait: noWait });
    expect(find).toHaveBeenCalledTimes(1);
  });
});

describe("link formatting", () => {
  it("renders a leading-space suffix so it drops into a sentence", () => {
    expect(runLinkSuffix(RUN)).toBe(" Run: https://github.com/o/r/actions/runs/123");
  });

  it("stays silent rather than printing 'Run: undefined'", () => {
    expect(runLinkSuffix(null)).toBe("");
    expect(runLinkSuffix(undefined)).toBe("");
    expect(runLinkSuffix({ ...RUN, runUrl: "" })).toBe("");
  });

  it("renders a Slack link, and nothing when there is no run", () => {
    expect(slackRunLink(RUN)).toBe("<https://github.com/o/r/actions/runs/123|run>");
    expect(slackRunLink(null)).toBe("");
  });
});
