import { validateTaskGraph, type TaskNode } from "./task-graph";

/**
 * Deterministic milestone planning — the programme
 * replacement for `deriveTaskBreakdown`, whose one-task-per-repo output is
 * the right shape for a feature and the wrong one for building an app.
 *
 * The skeleton is code, not model output. Shared infra — scaffold,
 * design-system bindings, data layer — is emitted ONCE per programme
 * (`deriveSharedInfraTasks`) and reused as completed dependencies by every
 * milestone. Per-milestone work is one task per prototype screen, then
 * integration, then end-to-end. A model may REFINE a plan (split a screen
 * task, add a dependency) through a tool whose output must pass
 * `validateTaskGraph`, but the spine — and therefore the build order — is
 * deterministic and identical on every re-plan.
 *
 * Re-emitting scaffold / design-bindings / data-layer on every milestone
 * used to create ~3 × N redundant infra tasks on an N-milestone programme
 * (and risked design-token drift). Those three now live under the
 * programme-scoped `:shared:` id namespace.
 */

export interface MilestonePlanInput {
  programmeKey: string;
  milestoneId: string;
  /** Sanitised prototype screen names from the design-context snapshot. */
  screenStates: string[];
  /** `AC-<8 hex>` ids from the milestone's approved spec. */
  acceptanceCriterionIds: string[];
  /** Registry platform key — decides which test kinds the tasks demand. */
  platform: string;
}

export type PlannedTaskKind =
  | "technical-spec"
  | "scaffold"
  | "design-bindings"
  | "data-layer"
  | "screen"
  | "integration"
  | "e2e";

export interface PlannedTask extends TaskNode {
  title: string;
  /** Deterministic slot kind — drives the model ladder's per-kind override. */
  kind: PlannedTaskKind;
  /** Criteria this task must prove. The union across tasks covers them all. */
  acceptanceCriterionIds: string[];
  /** Prototype states this task renders, for design-context scoping. */
  screenStates: string[];
  testKinds: Array<"unit" | "widget" | "integration" | "e2e" | "maestro">;
}

/** Milestone-id segment used for programme-level shared infra task ids. */
export const SHARED_INFRA_MILESTONE_ID = "shared";

export type SharedInfraSlot = "technical-spec" | "scaffold" | "design-bindings" | "data-layer";

/** Stable shared-infra task id: programme + `shared` + slot. */
export function sharedInfraTaskId(programmeKey: string, slot: SharedInfraSlot): string {
  return `${programmeKey}:${SHARED_INFRA_MILESTONE_ID}:${slot}`;
}

/** Stable per-milestone task id: programme + milestone + slot. */
function taskId(input: MilestonePlanInput, slot: string): string {
  return `${input.programmeKey}:${input.milestoneId}:${slot}`;
}

/**
 * The slug a screen name contributes to its task id. Exported so a caller
 * accepting names without an inventory can dedupe and refuse on exactly what
 * the plan will key on — two names with one slug are one task id.
 */
export function screenSlug(state: string): string {
  return slugify(state);
}

function slugify(state: string): string {
  return state
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|(?<!-)-+$/g, "");
}

const isMobile = (platform: string): boolean => platform.includes("mobile");

/**
 * The three programme-level infra tasks. Done once; every milestone's screen
 * tasks depend on the design-bindings and data-layer ids this returns.
 */
export function deriveSharedInfraTasks(input: {
  programmeKey: string;
  platform: string;
  /**
   * Plan a `technical-spec` task ahead of the scaffold (programme-policy.yaml
   * programmes.repoSettings.<key>.requireTechnicalSpec). The coding agent
   * writes docs/technical-spec/<programme>.md and opens a PR that a HUMAN
   * merges — the merge is the approval — and every other shared task depends
   * on it, so nothing builds against an unapproved architecture. Off by
   * default so every existing programme's task ids are unchanged.
   */
  requireTechnicalSpec?: boolean;
}): PlannedTask[] {
  const unitKinds: PlannedTask["testKinds"] = isMobile(input.platform)
    ? ["unit", "widget"]
    : ["unit"];

  const technicalSpecId = sharedInfraTaskId(input.programmeKey, "technical-spec");
  const scaffoldId = sharedInfraTaskId(input.programmeKey, "scaffold");
  const designBindingsId = sharedInfraTaskId(input.programmeKey, "design-bindings");
  const dataLayerId = sharedInfraTaskId(input.programmeKey, "data-layer");

  const technicalSpec: PlannedTask | null = input.requireTechnicalSpec
    ? {
        id: technicalSpecId,
        kind: "technical-spec",
        title: "Technical spec: architecture, routing, API mapping, criteria by screen",
        dependsOn: [],
        status: "PENDING",
        acceptanceCriterionIds: [],
        screenStates: [],
        // A document, not code: the runner skips RED/GREEN/checks for this
        // kind and the auto-merge gate can therefore never pass — which is
        // the point. A person merges it.
        testKinds: [],
      }
    : null;

  const scaffold: PlannedTask = {
    id: scaffoldId,
    kind: "scaffold",
    title: "Scaffold: app skeleton, CI, test-id registry",
    dependsOn: technicalSpec ? [technicalSpecId] : [],
    status: "PENDING",
    acceptanceCriterionIds: [],
    screenStates: [],
    testKinds: unitKinds,
  };

  const designBindings: PlannedTask = {
    id: designBindingsId,
    kind: "design-bindings",
    title: "Design-system bindings: tokens, base components",
    dependsOn: [scaffoldId],
    status: "PENDING",
    acceptanceCriterionIds: [],
    screenStates: [],
    testKinds: unitKinds,
  };

  const dataLayer: PlannedTask = {
    id: dataLayerId,
    kind: "data-layer",
    title: "Data layer: API clients, state, fixtures",
    dependsOn: [scaffoldId],
    status: "PENDING",
    acceptanceCriterionIds: [],
    screenStates: [],
    testKinds: [...unitKinds, "integration"],
  };

  const plan = technicalSpec
    ? [technicalSpec, scaffold, designBindings, dataLayer]
    : [scaffold, designBindings, dataLayer];
  const validation = validateTaskGraph(plan);
  if (!validation.valid) {
    throw new Error(
      `deriveSharedInfraTasks produced an invalid graph: ${validation.problems.join("; ")}`,
    );
  }
  return plan;
}

/**
 * Per-milestone tasks only (screens → integration → e2e). Depends on the
 * programme-level shared infra ids from `deriveSharedInfraTasks` — validate
 * the combined graph with `validateTaskGraph([...shared, ...milestone])`.
 */
/**
 * The domain a prototype screen belongs to: its first meaningful path
 * segment, with a route-group marker like `(auth)` unwrapped.
 *
 *   `(auth)/login/password` -> `auth`
 *   `rac/address/map`       -> `rac`
 *   `home`                  -> `home`
 *
 * Domains exist for one reason: screens inside one share modules, and
 * screens across two rarely do.
 */
export function screenDomain(state: string): string {
  const first = state.split("/").filter(Boolean)[0] ?? state;
  return first.replace(/^\((.*)\)$/, "$1").toLowerCase();
}

export function deriveMilestonePlan(input: MilestonePlanInput): PlannedTask[] {
  if (input.screenStates.length === 0) {
    // A milestone with no screens is not plannable from a prototype — the
    // caller must supply the design context first, not receive a plan with
    // an invented screen list.
    throw new Error(
      `milestone ${input.milestoneId} has no prototype screen states to plan from`,
    );
  }

  const unitKinds: PlannedTask["testKinds"] = isMobile(input.platform)
    ? ["unit", "widget"]
    : ["unit"];
  const e2eKinds: PlannedTask["testKinds"] = isMobile(input.platform) ? ["maestro"] : ["e2e"];

  const designBindingsId = sharedInfraTaskId(input.programmeKey, "design-bindings");
  const dataLayerId = sharedInfraTaskId(input.programmeKey, "data-layer");

  // Acceptance criteria are spread across the screen tasks round-robin so
  // every criterion has exactly one owning task. The integration task picks
  // up any remainder when there are more criteria than screens — never the
  // other way round, so no criterion is silently owned by nobody.
  // One PATHFINDER per domain: the first screen of a domain runs alone, and
  // its siblings depend on it.
  //
  // Without this every screen is READY at once and each writes the domain's
  // shared modules itself: most auth screens independently create the same
  // auth client module. The visible symptom is a conflict storm in the build
  // log and the locale file, but that is the surface — the real cost is the
  // same module derived many times and then reconciled by hand.
  //
  // The cost is one screen's latency per domain, paid once. Domains still run
  // in parallel with each other, so a three-domain milestone at concurrency 4
  // loses a single task's wall-clock, not a phase.
  //
  // The first screen in prototype order is the pathfinder deliberately: the
  // prototype lists a domain's entry point first (`(auth)/login` before
  // `(auth)/login/password`), and an entry point is what has to stand up the
  // domain's client, types and fixtures. Picking by criteria count would be
  // less predictable and no better founded.
  const pathfinderByDomain = new Map<string, string>();
  for (const state of input.screenStates) {
    const domain = screenDomain(state);
    if (!pathfinderByDomain.has(domain)) {
      pathfinderByDomain.set(domain, taskId(input, `screen-${slugify(state)}`));
    }
  }

  const screenTasks: PlannedTask[] = input.screenStates.map((state, index) => {
    const id = taskId(input, `screen-${slugify(state)}`);
    const pathfinderId = pathfinderByDomain.get(screenDomain(state));
    // A pathfinder does not depend on itself, and a domain of one is its own
    // pathfinder with nothing waiting on it.
    const domainDependency = pathfinderId && pathfinderId !== id ? [pathfinderId] : [];
    return {
      id,
      kind: "screen" as const,
      title: `Screen: ${state}`,
      dependsOn: [designBindingsId, dataLayerId, ...domainDependency],
      status: "PENDING" as const,
      acceptanceCriterionIds: input.acceptanceCriterionIds.filter(
        (_, criterionIndex) => criterionIndex % input.screenStates.length === index,
      ),
      screenStates: [state],
      testKinds: unitKinds,
    };
  });

  const integration: PlannedTask = {
    id: taskId(input, "integration"),
    kind: "integration",
    title: "Integration: navigation, journey wiring",
    dependsOn: screenTasks.map((task) => task.id),
    status: "PENDING",
    acceptanceCriterionIds: [],
    screenStates: input.screenStates,
    testKinds: ["integration"],
  };

  const endToEnd: PlannedTask = {
    id: taskId(input, "e2e"),
    kind: "e2e",
    title: "End-to-end: full-journey tests against the preview build",
    dependsOn: [integration.id],
    status: "PENDING",
    acceptanceCriterionIds: [],
    screenStates: input.screenStates,
    testKinds: e2eKinds,
  };

  return [screenTasks, integration, endToEnd].flat();
}

/**
 * Validates the milestone plan against the shared infra it depends on.
 * Throws when the combined graph is invalid — the skeleton is deterministic,
 * so that is a bug here, not bad input.
 */
export function validateMilestonePlanAgainstShared(
  shared: PlannedTask[],
  milestone: PlannedTask[],
): PlannedTask[] {
  const plan = [...shared, ...milestone];
  const validation = validateTaskGraph(plan);
  if (!validation.valid) {
    throw new Error(`deriveMilestonePlan produced an invalid graph: ${validation.problems.join("; ")}`);
  }
  return plan;
}


/**
 * Re-assigns acceptance criteria to screen tasks from an explicit mapping —
 * the technical spec's "Acceptance criteria by screen" table, once a human has
 * merged it. Deterministic and total: a criterion the table maps to a screen
 * this plan knows goes there; a criterion it maps to an unknown screen, or
 * does not mention, keeps its round-robin slot so nothing is silently dropped.
 * Returns the tasks whose ownership changed, so the caller can upsert exactly
 * those. `mapping` keys are screen names as the plan spells them (case
 * ignored), values are `AC-…` ids.
 */
export function applyCriterionMapping(
  screenTasks: PlannedTask[],
  mapping: Record<string, string[]>,
): PlannedTask[] {
  const byScreen = new Map<string, PlannedTask>();
  for (const task of screenTasks) {
    if (task.kind !== "screen") continue;
    for (const state of task.screenStates) byScreen.set(state.toLowerCase(), task);
  }
  const owned = new Map<string, string>();
  // Criteria the document places on a screen this milestone does NOT build.
  // They are removed from every planned task rather than left where the
  // round-robin spread put them: a trading criterion round-robined onto the
  // login task would demand a green test the login task can never write, and
  // the merge gate would refuse the PR for the wrong reason. A later
  // milestone that plans that screen picks them up from the same table.
  const deferred = new Set<string>();
  for (const [screen, ids] of Object.entries(mapping)) {
    const task = byScreen.get(screen.trim().toLowerCase());
    for (const id of ids) {
      if (!/^AC-[0-9a-f]{8}$/i.test(id)) continue;
      if (!task) {
        deferred.add(id);
        continue;
      }
      // First mapping wins: two screens claiming one criterion would put one
      // row in the matrix under two owners.
      if (!owned.has(id)) owned.set(id, task.id);
    }
  }
  for (const id of owned.keys()) deferred.delete(id);
  if (owned.size === 0 && deferred.size === 0) return [];

  const before = new Map(screenTasks.map((task) => [task.id, task.acceptanceCriterionIds]));
  const next = screenTasks.map((task) => {
    if (task.kind !== "screen") return task;
    const kept = task.acceptanceCriterionIds.filter(
      (id) => !deferred.has(id) && (!owned.has(id) || owned.get(id) === task.id),
    );
    const gained = [...owned.entries()].filter(([, owner]) => owner === task.id).map(([id]) => id);
    const ids = [...new Set([...kept, ...gained])].sort((a, b) => a.localeCompare(b));
    return { ...task, acceptanceCriterionIds: ids };
  });
  return next.filter((task) => {
    const prior = [...(before.get(task.id) ?? [])].sort((a, b) => a.localeCompare(b));
    return prior.join(",") !== [...task.acceptanceCriterionIds].sort((a, b) => a.localeCompare(b)).join(",");
  });
}

/**
 * Criteria the table places on screens none of the given tasks build — the
 * ones {@link applyCriterionMapping} removes from this milestone. Reported so
 * the programme can say which criteria wait for a later milestone.
 */
export function deferredCriteria(screenTasks: PlannedTask[], mapping: Record<string, string[]>): string[] {
  const planned = new Set<string>();
  for (const task of screenTasks) {
    if (task.kind !== "screen") continue;
    for (const state of task.screenStates) planned.add(state.toLowerCase());
  }
  const ownedSomewhere = new Set<string>();
  const deferred = new Set<string>();
  for (const [screen, ids] of Object.entries(mapping)) {
    const isPlanned = planned.has(screen.trim().toLowerCase());
    for (const id of ids) {
      if (!/^AC-[0-9a-f]{8}$/i.test(id)) continue;
      if (isPlanned) ownedSomewhere.add(id);
      else deferred.add(id);
    }
  }
  return [...deferred].filter((id) => !ownedSomewhere.has(id)).sort((a, b) => a.localeCompare(b));
}

/**
 * Parses the technical spec's "Acceptance criteria by screen" table. The
 * section heading and the two-column shape are the contract the brief tells
 * the coding agent to produce; anything else parses to an empty map, which the
 * caller reports rather than acting on.
 *
 *   ## Acceptance criteria by screen
 *   | Screen | Criteria |
 *   |---|---|
 *   | (auth)/login | AC-1111aaaa, AC-2222bbbb |
 */
export function parseCriteriaByScreen(markdown: string): Record<string, string[]> {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{2,3}\s+acceptance criteria by screen\s*$/i.test(line.trim()));
  if (start < 0) return {};
  const mapping: Record<string, string[]> = {};
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (/^#{1,6}\s/.test(line)) break;
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim()).filter((_, index, all) => index > 0 && index < all.length - 1);
    if (cells.length < 2) continue;
    const [screen, criteria] = cells;
    if (!screen || /^-+$/.test(screen) || /^screen$/i.test(screen)) continue;
    const ids = (criteria ?? "").match(/AC-[0-9a-f]{8}/gi) ?? [];
    if (ids.length === 0) continue;
    const key = screen.replace(/`/g, "").trim();
    mapping[key] = [...new Set([...(mapping[key] ?? []), ...ids.map((id) => `AC-${id.slice(3).toLowerCase()}`)])];
  }
  return mapping;
}

/** A refinement to the deterministic skeleton, from `propose_milestone_plan`. */
export interface PlanRefinement {
  op: "split" | "add_dependency" | "retitle";
  taskId: string;
  detail: string;
}

export interface RefinementOutcome {
  plan: PlannedTask[];
  /** One line per applied op, for the tool's reply. */
  applied: string[];
  /** Ops that could not be applied, with the reason. Never silently dropped. */
  rejected: string[];
}

/**
 * Apply operator refinements to a derived plan.
 *
 * Advertised on `propose_milestone_plan` since the tool was written, and never
 * implemented: `refinements` appeared in the schema and in two comments, and
 * nothing ever read it. A caller splitting an oversized screen task got a
 * success reply and the unchanged skeleton.
 *
 * `split` narrows the PARENT and adds siblings rather than replacing it. The
 * store has no delete for build tasks, so a split that replaced the parent
 * would strand its row — and on a live programme that row may be DISPATCHED,
 * holding a branch, a PR and spent attempts. Narrowing keeps all of it: the
 * update path refreshes structure only and never status or attempts, so the
 * parent keeps building, for less. That is also the honest semantics for work
 * already in flight — you reduce its remit, you do not destroy it.
 *
 * Criteria are re-spread round-robin across the parent and its new siblings,
 * the same rule `deriveMilestonePlan` uses across screens, so every criterion
 * keeps exactly one owner. Anything depending on the parent is made to depend
 * on the siblings too — `validateTaskGraph` would not catch that (no cycle, no
 * unknown id), but an integration task that ran before half the screens it
 * integrates is wrong.
 */
export function applyRefinements(
  plan: PlannedTask[],
  refinements: PlanRefinement[],
): RefinementOutcome {
  const applied: string[] = [];
  const rejected: string[] = [];
  let working = [...plan];

  for (const refinement of refinements) {
    const index = working.findIndex((task) => task.id === refinement.taskId);
    if (index === -1) {
      rejected.push(`${refinement.op} ${refinement.taskId}: no such task in this plan`);
      continue;
    }
    const target = working[index]!;
    const detail = refinement.detail.trim();
    if (detail === "") {
      rejected.push(`${refinement.op} ${refinement.taskId}: detail is empty`);
      continue;
    }

    if (refinement.op === "retitle") {
      working[index] = { ...target, title: detail };
      applied.push(`retitled ${target.id} to "${detail}"`);
      continue;
    }

    if (refinement.op === "add_dependency") {
      const wanted = detail
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "");
      const unknown = wanted.filter((id) => !working.some((task) => task.id === id));
      if (unknown.length > 0) {
        rejected.push(
          `add_dependency ${target.id}: unknown task id(s) ${unknown.join(", ")}`,
        );
        continue;
      }
      if (wanted.includes(target.id)) {
        rejected.push(`add_dependency ${target.id}: a task cannot depend on itself`);
        continue;
      }
      const merged = [...new Set([...target.dependsOn, ...wanted])];
      working[index] = { ...target, dependsOn: merged };
      applied.push(`${target.id} now depends on ${wanted.join(", ")}`);
      continue;
    }

    // split
    const sliceNames = detail
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    if (sliceNames.length === 0) {
      rejected.push(`split ${target.id}: detail names no slices`);
      continue;
    }
    const siblings: PlannedTask[] = [];
    const seen = new Set<string>();
    let clash = false;
    for (const name of sliceNames) {
      const slug = slugify(name);
      if (slug === "") {
        rejected.push(`split ${target.id}: slice name "${name}" has no usable characters`);
        clash = true;
        break;
      }
      const id = `${target.id}-${slug}`;
      // Re-running the same split must not create a second copy, and two
      // slices must not collapse onto one id.
      if (seen.has(id) || working.some((task) => task.id === id)) {
        rejected.push(`split ${target.id}: slice "${name}" collides with existing task ${id}`);
        clash = true;
        break;
      }
      seen.add(id);
      siblings.push({
        id,
        kind: target.kind,
        title: `${target.title} — ${name}`,
        dependsOn: [...target.dependsOn],
        status: "PENDING",
        acceptanceCriterionIds: [],
        screenStates: [...target.screenStates],
        testKinds: [...target.testKinds],
      });
    }
    if (clash) continue;

    // Round-robin the parent's criteria across parent + siblings, so the union
    // is unchanged and every criterion still has exactly one owner.
    const family = [target, ...siblings];
    const shares: string[][] = family.map(() => []);
    target.acceptanceCriterionIds.forEach((criterionId, position) => {
      shares[position % family.length]!.push(criterionId);
    });

    working[index] = { ...target, acceptanceCriterionIds: shares[0]! };
    siblings.forEach((sibling, offset) => {
      sibling.acceptanceCriterionIds = shares[offset + 1]!;
    });

    // Whatever waited for the parent must wait for its siblings too.
    const siblingIds = siblings.map((sibling) => sibling.id);
    working = working.map((task) =>
      task.id !== target.id && task.dependsOn.includes(target.id)
        ? { ...task, dependsOn: [...new Set([...task.dependsOn, ...siblingIds])] }
        : task,
    );
    working = [...working, ...siblings];
    applied.push(
      `split ${target.id} into ${family.length} (${family
        .map((task) => `${task.id.split(":").pop()}: ${task.acceptanceCriterionIds.length} criteria`)
        .join(", ")})`,
    );
  }

  return { plan: working, applied, rejected };
}
