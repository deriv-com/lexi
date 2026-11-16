import type { BuildTaskStatus } from "@lexi/contracts";

/**
 * The build-task dependency DAG.
 *
 * Pure structure-checking and scheduling arithmetic — no I/O, no model
 * judgement. The advance job calls `readyTasks` every tick; a task whose
 * dependencies are not all merged simply never becomes dispatchable, so
 * ordering ("data layer before screens") is a property of the graph rather
 * than a hope encoded in a prompt.
 */

export interface TaskNode {
  id: string;
  /** Ids of tasks this one builds on. Must all exist in the same graph. */
  dependsOn: string[];
  status: BuildTaskStatus;
}

export interface TaskGraphValidation {
  valid: boolean;
  /** Every defect found, named — empty only when `valid`. */
  problems: string[];
}

/**
 * Validates a proposed task graph. An EMPTY graph is invalid on purpose,
 * mirroring `validateTaskBreakdown`'s "empty is invalid": a milestone plan
 * with no tasks is a planning failure to surface, not a vacuous success.
 */
export function validateTaskGraph(tasks: TaskNode[]): TaskGraphValidation {
  const problems: string[] = [];

  if (tasks.length === 0) {
    problems.push("task graph is empty");
    return { valid: false, problems };
  }

  const byId = new Map<string, TaskNode>();
  for (const task of tasks) {
    if (byId.has(task.id)) {
      problems.push(`duplicate task id: ${task.id}`);
    }
    byId.set(task.id, task);
  }

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!byId.has(dep)) {
        problems.push(`task ${task.id} depends on unknown task ${dep}`);
      }
      if (dep === task.id) {
        problems.push(`task ${task.id} depends on itself`);
      }
    }
  }

  // Cycle detection via iterative DFS colouring. Reported by naming one task
  // on the cycle — enough to find it, without trying to render the whole
  // cycle path (which duplicates for every entry point).
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  for (const task of tasks) colour.set(task.id, WHITE);

  const visit = (startId: string): string | null => {
    const stack: Array<{ id: string; depIndex: number }> = [{ id: startId, depIndex: 0 }];
    colour.set(startId, GREY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const node = byId.get(frame.id);
      const deps = node ? node.dependsOn.filter((dep) => byId.has(dep)) : [];
      if (frame.depIndex >= deps.length) {
        colour.set(frame.id, BLACK);
        stack.pop();
        continue;
      }
      const dep = deps[frame.depIndex];
      frame.depIndex += 1;
      const depColour = colour.get(dep);
      if (depColour === GREY) return dep;
      if (depColour === WHITE) {
        colour.set(dep, GREY);
        stack.push({ id: dep, depIndex: 0 });
      }
    }
    return null;
  };

  for (const task of tasks) {
    if (colour.get(task.id) === WHITE) {
      const cycleMember = visit(task.id);
      if (cycleMember !== null) {
        problems.push(`dependency cycle involving task ${cycleMember}`);
        break;
      }
    }
  }

  return { valid: problems.length === 0, problems };
}

/**
 * A dependency is satisfied once its change is on the default branch — or once
 * a human has retired it.
 *
 * CANCELLED counts as satisfied on purpose. A task is retired precisely when
 * the work it describes is ALREADY on the branch (a second programme on a repo
 * re-plans `scaffold`, `design-bindings` and `data-layer` that the first one
 * landed). If retiring those left every screen that depends on them unable to
 * become READY, cancel would not be a way to skip redundant work — it would be
 * a way to wedge the graph, and the only escape would be re-planning the whole
 * milestone. The cost of the choice is that cancelling a task whose work does
 * NOT exist lets its dependents run against a missing dependency; that is a
 * judgement the human makes when they name the task, and the reason is
 * recorded on the row.
 */
const SATISFIED: ReadonlySet<BuildTaskStatus> = new Set(["MERGED", "VERIFIED", "CANCELLED"]);

/**
 * Tasks whose every dependency is merged and which have not started yet.
 * Deterministic order (graph order) so two advance ticks agree on which
 * tasks fill the concurrency budget.
 */
export function readyTasks(tasks: TaskNode[]): TaskNode[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.filter((task) => {
    if (task.status !== "PENDING" && task.status !== "READY") return false;
    return task.dependsOn.every((dep) => {
      const node = byId.get(dep);
      return node !== undefined && SATISFIED.has(node.status);
    });
  });
}

/**
 * Deterministic topological order (Kahn's algorithm; ties broken by input
 * order). Throws on a cyclic graph — callers validate first, so a throw here
 * is a programming error, not user input.
 */
export function topologicalOrder(tasks: TaskNode[]): TaskNode[] {
  const validation = validateTaskGraph(tasks);
  if (!validation.valid) {
    throw new Error(`topologicalOrder on invalid graph: ${validation.problems.join("; ")}`);
  }

  const remainingDeps = new Map<string, Set<string>>();
  for (const task of tasks) {
    remainingDeps.set(task.id, new Set(task.dependsOn));
  }

  const ordered: TaskNode[] = [];
  const emitted = new Set<string>();
  while (ordered.length < tasks.length) {
    const next = tasks.find(
      (task) => !emitted.has(task.id) && (remainingDeps.get(task.id)?.size ?? 0) === 0,
    );
    if (!next) {
      // Unreachable after validation, but a silent infinite loop would be
      // worse than a loud throw if validation and this ever disagree.
      throw new Error("topologicalOrder made no progress on a validated graph");
    }
    ordered.push(next);
    emitted.add(next.id);
    for (const deps of remainingDeps.values()) {
      deps.delete(next.id);
    }
  }
  return ordered;
}
