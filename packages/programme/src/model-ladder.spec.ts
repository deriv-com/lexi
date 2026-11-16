import { describe, it, expect } from "vitest";
import { modelForAttempt } from "./model-ladder";

const ladder = ["claude-sonnet-5", "claude-opus-5"];

describe("modelForAttempt", () => {
  it("climbs the ladder by attempt and repeats the last rung", () => {
    expect(modelForAttempt({ ladder, taskKind: "scaffold", attempt: 1 })).toBe("claude-sonnet-5");
    expect(modelForAttempt({ ladder, taskKind: "scaffold", attempt: 2 })).toBe("claude-opus-5");
    expect(modelForAttempt({ ladder, taskKind: "scaffold", attempt: 3 })).toBe("claude-opus-5");
  });

  it("per-kind override starts that kind on the capable rung and stays there", () => {
    const byTaskKind = { screen: "claude-opus-5" };
    expect(modelForAttempt({ ladder, byTaskKind, taskKind: "screen", attempt: 1 })).toBe("claude-opus-5");
    expect(modelForAttempt({ ladder, byTaskKind, taskKind: "screen", attempt: 2 })).toBe("claude-opus-5");
    expect(modelForAttempt({ ladder, byTaskKind, taskKind: "data-layer", attempt: 1 })).toBe("claude-sonnet-5");
  });

  it("single-rung policy: one rung, no overrides — every kind stays on it for every attempt", () => {
    const ladder = ["model-large"];
    for (const taskKind of ["technical-spec", "screen", "scaffold"]) {
      for (const attempt of [1, 2, 3]) {
        expect(modelForAttempt({ ladder, byTaskKind: {}, taskKind, attempt })).toBe("model-large");
      }
    }
  });

  it("two-rung example: a kind pinned to the escalation rung stays on it", () => {
    const ladder = ["model-small", "model-large"];
    const byTaskKind = { "technical-spec": "model-large" };
    for (const attempt of [1, 2, 3]) {
      expect(modelForAttempt({ ladder, byTaskKind, taskKind: "technical-spec", attempt })).toBe("model-large");
    }
    expect(modelForAttempt({ ladder, byTaskKind, taskKind: "screen", attempt: 1 })).toBe("model-small");
    expect(modelForAttempt({ ladder, byTaskKind, taskKind: "screen", attempt: 2 })).toBe("model-large");
  });

  it("an empty ladder defers to the runner default (undefined) unless overridden", () => {
    expect(modelForAttempt({ ladder: [], taskKind: "screen", attempt: 1 })).toBeUndefined();
    expect(modelForAttempt({ ladder: [], byTaskKind: { screen: "x" }, taskKind: "screen", attempt: 1 })).toBe("x");
  });

  it("tolerates attempt 0 / fractional as attempt 1", () => {
    expect(modelForAttempt({ ladder, taskKind: "e2e", attempt: 0 })).toBe("claude-sonnet-5");
  });
});
