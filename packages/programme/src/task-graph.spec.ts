import { describe, it, expect } from "vitest";
import { readyTasks, topologicalOrder, validateTaskGraph, type TaskNode } from "./task-graph";

const node = (id: string, dependsOn: string[] = [], status: TaskNode["status"] = "PENDING"): TaskNode => ({
  id,
  dependsOn,
  status,
});

describe("validateTaskGraph", () => {
  it("accepts a valid DAG", () => {
    const result = validateTaskGraph([node("a"), node("b", ["a"]), node("c", ["a", "b"])]);
    expect(result.valid).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("refuses an empty graph — a plan with no tasks is a planning failure", () => {
    const result = validateTaskGraph([]);
    expect(result.valid).toBe(false);
    expect(result.problems).toContain("task graph is empty");
  });

  it("names duplicate ids", () => {
    const result = validateTaskGraph([node("a"), node("a")]);
    expect(result.problems).toContain("duplicate task id: a");
  });

  it("names dangling dependencies", () => {
    const result = validateTaskGraph([node("a", ["ghost"])]);
    expect(result.problems).toContain("task a depends on unknown task ghost");
  });

  it("names self-dependencies", () => {
    const result = validateTaskGraph([node("a", ["a"])]);
    expect(result.problems).toContain("task a depends on itself");
  });

  it("detects a cycle", () => {
    const result = validateTaskGraph([node("a", ["c"]), node("b", ["a"]), node("c", ["b"])]);
    expect(result.valid).toBe(false);
    expect(result.problems.some((p) => p.startsWith("dependency cycle"))).toBe(true);
  });
});

describe("readyTasks", () => {
  it("frees a dependent whose dependency was retired, and never offers the retired task itself", () => {
    // The whole point of retiring "scaffold, already on the branch" is that the
    // screens depending on it can run. If CANCELLED did not satisfy, cancelling
    // would wedge the graph instead of skipping work: `b` would sit PENDING for
    // ever with no tool able to free it.
    const tasks = [node("scaffold", [], "CANCELLED"), node("b", ["scaffold"], "PENDING")];
    expect(readyTasks(tasks).map((t) => t.id)).toEqual(["b"]);
  });

  it("does not offer a retired task even when its own dependencies are merged", () => {
    const tasks = [node("a", [], "MERGED"), node("retired", ["a"], "CANCELLED")];
    expect(readyTasks(tasks).map((t) => t.id)).toEqual([]);
  });

  it("offers only tasks whose every dependency is merged or verified", () => {
    const tasks = [
      node("a", [], "MERGED"),
      node("b", [], "PR_OPEN"),
      node("c", ["a"], "PENDING"),
      node("d", ["b"], "PENDING"),
      node("e", ["a", "b"], "PENDING"),
    ];
    expect(readyTasks(tasks).map((t) => t.id)).toEqual(["c"]);
  });

  it("does not re-offer tasks already past READY", () => {
    const tasks = [node("a", [], "MERGED"), node("b", ["a"], "DISPATCHED")];
    expect(readyTasks(tasks)).toEqual([]);
  });

  it("treats VERIFIED dependencies as satisfied", () => {
    const tasks = [node("a", [], "VERIFIED"), node("b", ["a"], "READY")];
    expect(readyTasks(tasks).map((t) => t.id)).toEqual(["b"]);
  });

  it("is deterministic across calls", () => {
    const tasks = [node("a", [], "MERGED"), node("b", ["a"]), node("c", ["a"])];
    expect(readyTasks(tasks)).toEqual(readyTasks(tasks));
  });
});

describe("topologicalOrder", () => {
  it("orders dependencies before dependents, ties by input order", () => {
    const tasks = [node("c", ["a", "b"]), node("b", ["a"]), node("a")];
    expect(topologicalOrder(tasks).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("throws on an invalid graph rather than looping", () => {
    expect(() => topologicalOrder([node("a", ["b"]), node("b", ["a"])])).toThrow(
      /invalid graph/,
    );
  });
});
