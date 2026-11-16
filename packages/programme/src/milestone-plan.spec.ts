import { describe, it, expect } from "vitest";
import {
  applyCriterionMapping,
  applyRefinements,
  deferredCriteria,
  deriveMilestonePlan,
  deriveSharedInfraTasks,
  parseCriteriaByScreen,
  screenDomain,
  sharedInfraTaskId,
  validateMilestonePlanAgainstShared,
  type MilestonePlanInput,
  type PlannedTask,
} from "./milestone-plan";
import { validateTaskGraph, topologicalOrder } from "./task-graph";

const input = (overrides: Partial<MilestonePlanInput> = {}): MilestonePlanInput => ({
  programmeKey: "web-site-rebuild",
  milestoneId: "m1",
  screenStates: ["Home", "Trade", "Portfolio"],
  acceptanceCriterionIds: ["AC-aaaa1111", "AC-bbbb2222", "AC-cccc3333", "AC-dddd4444"],
  platform: "web_ai",
  ...overrides,
});

function fullPlan(overrides: Partial<MilestonePlanInput> = {}) {
  const args = input(overrides);
  const shared = deriveSharedInfraTasks({
    programmeKey: args.programmeKey,
    platform: args.platform,
  });
  const milestone = deriveMilestonePlan(args);
  return validateMilestonePlanAgainstShared(shared, milestone);
}

describe("deriveSharedInfraTasks", () => {
  it("emits exactly three programme-scoped infra tasks", () => {
    const shared = deriveSharedInfraTasks({ programmeKey: "web-site-rebuild", platform: "web_ai" });
    expect(shared.map((task) => task.id)).toEqual([
      "web-site-rebuild:shared:scaffold",
      "web-site-rebuild:shared:design-bindings",
      "web-site-rebuild:shared:data-layer",
    ]);
    expect(validateTaskGraph(shared).valid).toBe(true);
  });

  it("is identical across milestones — one set per programme", () => {
    const a = deriveSharedInfraTasks({ programmeKey: "p", platform: "web_ai" });
    const b = deriveSharedInfraTasks({ programmeKey: "p", platform: "web_ai" });
    expect(a).toEqual(b);
    expect(sharedInfraTaskId("p", "scaffold")).toBe("p:shared:scaffold");
  });
});

describe("deriveMilestonePlan", () => {
  it("produces screens/integration/e2e that depend on shared infra, not a fresh scaffold", () => {
    const milestone = deriveMilestonePlan(input());
    const ids = milestone.map((task) => task.id);
    expect(ids).not.toContain("web-site-rebuild:m1:scaffold");
    expect(ids).not.toContain("web-site-rebuild:m1:design-bindings");
    expect(ids).not.toContain("web-site-rebuild:m1:data-layer");
    expect(ids).toContain("web-site-rebuild:m1:screen-home");
    expect(ids).toContain("web-site-rebuild:m1:integration");
    expect(ids).toContain("web-site-rebuild:m1:e2e");

    const home = milestone.find((task) => task.id.endsWith(":screen-home"))!;
    expect(home.dependsOn).toEqual([
      "web-site-rebuild:shared:design-bindings",
      "web-site-rebuild:shared:data-layer",
    ]);
  });

  it("combined with shared infra forms a valid graph with the deterministic spine", () => {
    const plan = fullPlan();
    expect(validateTaskGraph(plan).valid).toBe(true);

    const ordered = topologicalOrder(plan).map((task) => task.id);
    const pos = (id: string) => ordered.indexOf(id);
    expect(pos("web-site-rebuild:shared:scaffold")).toBeLessThan(
      pos("web-site-rebuild:shared:design-bindings"),
    );
    expect(pos("web-site-rebuild:shared:scaffold")).toBeLessThan(
      pos("web-site-rebuild:shared:data-layer"),
    );
    expect(pos("web-site-rebuild:shared:design-bindings")).toBeLessThan(
      pos("web-site-rebuild:m1:screen-home"),
    );
    expect(pos("web-site-rebuild:shared:data-layer")).toBeLessThan(
      pos("web-site-rebuild:m1:screen-home"),
    );
    expect(pos("web-site-rebuild:m1:screen-portfolio")).toBeLessThan(
      pos("web-site-rebuild:m1:integration"),
    );
    expect(ordered[ordered.length - 1].endsWith(":e2e")).toBe(true);
  });

  it("two milestones share the same three infra task ids — no N×3 duplication", () => {
    const shared = deriveSharedInfraTasks({ programmeKey: "web-site-rebuild", platform: "web_ai" });
    const m1 = deriveMilestonePlan(input({ milestoneId: "m1" }));
    const m2 = deriveMilestonePlan(input({ milestoneId: "m2", screenStates: ["Settings"] }));
    const combined = [...shared, ...m1, ...m2];
    expect(validateTaskGraph(combined).valid).toBe(true);
    const infra = combined.filter((task) =>
      ["scaffold", "design-bindings", "data-layer"].includes(task.kind),
    );
    expect(infra).toHaveLength(3);
    expect(m2.find((task) => task.kind === "screen")!.dependsOn).toEqual([
      "web-site-rebuild:shared:design-bindings",
      "web-site-rebuild:shared:data-layer",
    ]);
  });

  it("every acceptance criterion is owned by exactly one screen task", () => {
    const plan = deriveMilestonePlan(input());
    const owned = plan.flatMap((task) => task.acceptanceCriterionIds);
    expect([...owned].sort()).toEqual(
      ["AC-aaaa1111", "AC-bbbb2222", "AC-cccc3333", "AC-dddd4444"].sort(),
    );
  });

  it("is idempotent — same input, same ids", () => {
    expect(deriveMilestonePlan(input())).toEqual(deriveMilestonePlan(input()));
  });

  it("mobile platforms demand widget and maestro kinds; web demands e2e", () => {
    const web = fullPlan();
    expect(web.find((task) => task.id.endsWith(":e2e"))?.testKinds).toEqual(["e2e"]);

    const mobile = fullPlan({ platform: "mobile_ai" });
    expect(mobile.find((task) => task.id.endsWith(":e2e"))?.testKinds).toEqual(["maestro"]);
    expect(mobile.find((task) => task.id.endsWith(":scaffold"))?.testKinds).toContain("widget");
  });

  it("throws on a milestone with no prototype screens rather than inventing them", () => {
    expect(() => deriveMilestonePlan(input({ screenStates: [] }))).toThrow(
      /no prototype screen states/,
    );
  });
});

describe("technical-spec slot and criteria mapping", () => {
  it("emits the technical-spec task ahead of the scaffold only when asked, and the scaffold depends on it", () => {
    const withSpec = deriveSharedInfraTasks({ programmeKey: "p", platform: "web_ai", requireTechnicalSpec: true });
    expect(withSpec.map((task) => task.id)).toEqual([
      "p:shared:technical-spec",
      "p:shared:scaffold",
      "p:shared:design-bindings",
      "p:shared:data-layer",
    ]);
    const spec = withSpec[0]!;
    expect(spec.kind).toBe("technical-spec");
    expect(spec.dependsOn).toEqual([]);
    expect(spec.testKinds).toEqual([]); // a document: nothing to test red/green
    expect(withSpec.find((task) => task.id === "p:shared:scaffold")?.dependsOn).toContain("p:shared:technical-spec");
    expect(validateTaskGraph(withSpec).valid).toBe(true);
    // Absent flag → the pre-existing three, untouched.
    expect(deriveSharedInfraTasks({ programmeKey: "p", platform: "web_ai" }).map((t) => t.id)).toEqual([
      "p:shared:scaffold",
      "p:shared:design-bindings",
      "p:shared:data-layer",
    ]);
  });

  it("parses the 'Acceptance criteria by screen' table and ignores everything else", () => {
    const markdown = [
      "# Technical spec",
      "## Routing and screens",
      "| Screen | Route |",
      "| --- | --- |",
      "| (auth)/login | /login |",
      "## Acceptance criteria by screen",
      "",
      "| Screen | Criteria |",
      "| --- | --- |",
      "| (auth)/login | AC-aaaa1111, AC-bbbb2222 |",
      "| home | `AC-cccc3333` |",
      "| (auth)/signup | |",
      "",
      "## Decisions",
      "| Screen | Criteria |",
      "| other | AC-dddd4444 |",
    ].join("\n");
    expect(parseCriteriaByScreen(markdown)).toEqual({
      "(auth)/login": ["AC-aaaa1111", "AC-bbbb2222"],
      home: ["AC-cccc3333"],
    });
    expect(parseCriteriaByScreen("# nothing here")).toEqual({});
  });

  it("applyCriterionMapping re-owns criteria by screen, keeps unmapped ones where they were, and never duplicates", () => {
    const milestone = deriveMilestonePlan(input({ screenStates: ["(auth)/login", "home"] }));
    const screens = milestone.filter((task) => task.kind === "screen");
    expect(screens).toHaveLength(2);
    const before = screens.flatMap((task) => task.acceptanceCriterionIds).sort();
    expect(before).toEqual(["AC-aaaa1111", "AC-bbbb2222", "AC-cccc3333", "AC-dddd4444"]);

    const mapped = applyCriterionMapping(screens, {
      "(auth)/login": ["AC-aaaa1111", "AC-bbbb2222", "AC-cccc3333"],
      home: ["AC-dddd4444"],
      "unknown-screen": ["AC-aaaa1111"], // no such task: ignored, not invented
    });
    const login = mapped.find((task) => task.screenStates.includes("(auth)/login"))!;
    const home = mapped.find((task) => task.screenStates.includes("home"))!;
    expect(login.acceptanceCriterionIds.sort()).toEqual(["AC-aaaa1111", "AC-bbbb2222", "AC-cccc3333"]);
    expect(home.acceptanceCriterionIds).toEqual(["AC-dddd4444"]);
    // Every criterion still owned exactly once.
    expect(mapped.flatMap((task) => task.acceptanceCriterionIds).sort()).toEqual(before);
    // Same input, same output: the service applies it once per document sha.
    expect(applyCriterionMapping(screens, { home: ["AC-dddd4444"] })).toEqual(applyCriterionMapping(screens, { home: ["AC-dddd4444"] }));
  });
});

describe("criteria the spec places on screens outside the milestone", () => {
  it("removes them from every planned task instead of leaving them round-robined, and reports them", () => {
    const milestone = deriveMilestonePlan(input({ screenStates: ["(auth)/login", "home"] }));
    const screens = milestone.filter((task) => task.kind === "screen");
    // The technical spec maps the whole prototype; cfds is not in this milestone.
    const mapping = {
      "(auth)/login": ["AC-aaaa1111"],
      home: ["AC-bbbb2222"],
      cfds: ["AC-cccc3333", "AC-dddd4444"],
    };
    const changed = applyCriterionMapping(screens, mapping);
    const all = screens.map((task) => changed.find((c) => c.id === task.id) ?? task);
    expect(all.flatMap((task) => task.acceptanceCriterionIds).sort()).toEqual(["AC-aaaa1111", "AC-bbbb2222"]);
    expect(deferredCriteria(screens, mapping)).toEqual(["AC-cccc3333", "AC-dddd4444"]);
    // A criterion the table puts on BOTH a planned and an unplanned screen is owned, not deferred.
    expect(deferredCriteria(screens, { home: ["AC-cccc3333"], cfds: ["AC-cccc3333"] })).toEqual([]);
  });
});

describe("applyRefinements", () => {
  const basePlan = (): PlannedTask[] =>
    deriveMilestonePlan({
      programmeKey: "p",
      milestoneId: "m1",
      screenStates: ["home", "login"],
      acceptanceCriterionIds: ["AC-00000001", "AC-00000002", "AC-00000003", "AC-00000004", "AC-00000005"],
      platform: "web",
    });

  it("splits a task, conserving every acceptance criterion exactly once", () => {
    const before = basePlan();
    const parent = before.find((task) => task.id === "p:m1:screen-home")!;
    const criteriaBefore = [...parent.acceptanceCriterionIds];
    expect(criteriaBefore.length).toBeGreaterThan(1);

    const { plan, applied, rejected } = applyRefinements(before, [
      { op: "split", taskId: "p:m1:screen-home", detail: "tab shell, campaigns" },
    ]);

    expect(rejected).toEqual([]);
    expect(applied).toHaveLength(1);

    const family = plan.filter((task) => task.id.startsWith("p:m1:screen-home"));
    expect(family.map((task) => task.id)).toEqual([
      "p:m1:screen-home",
      "p:m1:screen-home-tab-shell",
      "p:m1:screen-home-campaigns",
    ]);

    // The union is unchanged and nothing is owned twice.
    const owned = family.flatMap((task) => task.acceptanceCriterionIds);
    expect([...owned].sort()).toEqual([...criteriaBefore].sort());
    expect(new Set(owned).size).toBe(owned.length);

    // The OTHER screen's criteria are untouched.
    expect(plan.find((task) => task.id === "p:m1:screen-login")!.acceptanceCriterionIds).toEqual(
      before.find((task) => task.id === "p:m1:screen-login")!.acceptanceCriterionIds,
    );
  });

  it("makes whatever depended on the parent depend on the new siblings too", () => {
    const { plan } = applyRefinements(basePlan(), [
      { op: "split", taskId: "p:m1:screen-home", detail: "tab shell, campaigns" },
    ]);
    const integration = plan.find((task) => task.id === "p:m1:integration")!;
    expect(integration.dependsOn).toContain("p:m1:screen-home");
    expect(integration.dependsOn).toContain("p:m1:screen-home-tab-shell");
    expect(integration.dependsOn).toContain("p:m1:screen-home-campaigns");
  });

  it("keeps the split plan a valid graph", () => {
    const { plan } = applyRefinements(basePlan(), [
      { op: "split", taskId: "p:m1:screen-home", detail: "tab shell, campaigns" },
    ]);
    const shared = deriveSharedInfraTasks({ programmeKey: "p", platform: "web" });
    expect(validateTaskGraph([...shared, ...plan]).valid).toBe(true);
  });

  it("inherits the parent's dependencies, kind, screen states and test kinds", () => {
    const { plan } = applyRefinements(basePlan(), [
      { op: "split", taskId: "p:m1:screen-home", detail: "tab shell" },
    ]);
    const parent = plan.find((task) => task.id === "p:m1:screen-home")!;
    const child = plan.find((task) => task.id === "p:m1:screen-home-tab-shell")!;
    expect(child.dependsOn).toEqual(parent.dependsOn);
    expect(child.kind).toBe(parent.kind);
    expect(child.screenStates).toEqual(parent.screenStates);
    expect(child.testKinds).toEqual(parent.testKinds);
    expect(child.status).toBe("PENDING");
  });

  it("is idempotent: re-running the same split adds nothing and says why", () => {
    const once = applyRefinements(basePlan(), [
      { op: "split", taskId: "p:m1:screen-home", detail: "tab shell" },
    ]);
    const twice = applyRefinements(once.plan, [
      { op: "split", taskId: "p:m1:screen-home", detail: "tab shell" },
    ]);
    expect(twice.plan).toHaveLength(once.plan.length);
    expect(twice.applied).toEqual([]);
    expect(twice.rejected[0]).toMatch(/collides with existing task/);
  });

  it("adds a dependency, and refuses an unknown or self id", () => {
    const ok = applyRefinements(basePlan(), [
      { op: "add_dependency", taskId: "p:m1:screen-home", detail: "p:m1:screen-login" },
    ]);
    expect(ok.rejected).toEqual([]);
    expect(ok.plan.find((task) => task.id === "p:m1:screen-home")!.dependsOn).toContain(
      "p:m1:screen-login",
    );

    const unknown = applyRefinements(basePlan(), [
      { op: "add_dependency", taskId: "p:m1:screen-home", detail: "p:m1:screen-nope" },
    ]);
    expect(unknown.applied).toEqual([]);
    expect(unknown.rejected[0]).toMatch(/unknown task id/);

    const selfDep = applyRefinements(basePlan(), [
      { op: "add_dependency", taskId: "p:m1:screen-home", detail: "p:m1:screen-home" },
    ]);
    expect(selfDep.rejected[0]).toMatch(/cannot depend on itself/);
  });

  it("rejects an unknown task and an empty detail without touching the plan", () => {
    const before = basePlan();
    const { plan, applied, rejected } = applyRefinements(before, [
      { op: "retitle", taskId: "p:m1:screen-nope", detail: "x" },
      { op: "split", taskId: "p:m1:screen-home", detail: "   " },
    ]);
    expect(applied).toEqual([]);
    expect(rejected).toHaveLength(2);
    expect(plan).toEqual(before);
  });

  it("retitles a task", () => {
    const { plan, applied } = applyRefinements(basePlan(), [
      { op: "retitle", taskId: "p:m1:screen-home", detail: "Screen: home surface only" },
    ]);
    expect(plan.find((task) => task.id === "p:m1:screen-home")!.title).toBe(
      "Screen: home surface only",
    );
    expect(applied[0]).toMatch(/retitled/);
  });
});

describe("one pathfinder per domain", () => {
  const plan = (screenStates: string[]) =>
    deriveMilestonePlan({
      programmeKey: "p",
      milestoneId: "p:m1",
      screenStates,
      acceptanceCriterionIds: ["AC-1", "AC-2", "AC-3"],
      platform: "web",
    });

  const screens = (tasks: PlannedTask[]) => tasks.filter((t) => t.kind === "screen");

  it("derives a domain from the first path segment, unwrapping a route group", () => {
    expect(screenDomain("(auth)/login/password")).toBe("auth");
    expect(screenDomain("rac/address/map")).toBe("rac");
    expect(screenDomain("home")).toBe("home");
  });

  it("makes every later screen of a domain depend on that domain's first", () => {
    // Without this every screen is READY at once and each writes the domain's
    // shared modules itself, and the auth screens each create the same
    // auth client module.
    const tasks = screens(plan(["(auth)/login", "(auth)/login/password", "(auth)/signup"]));
    const [pathfinder, second, third] = tasks;
    expect(pathfinder!.dependsOn).not.toContain(pathfinder!.id);
    expect(second!.dependsOn).toContain(pathfinder!.id);
    expect(third!.dependsOn).toContain(pathfinder!.id);
  });

  it("keeps domains independent of each other, so they still build in parallel", () => {
    const tasks = screens(plan(["(auth)/login", "(auth)/signup", "rac", "rac/address"]));
    const auth = tasks[0]!;
    const rac = tasks[2]!;
    expect(rac.dependsOn).not.toContain(auth.id);
    expect(tasks[3]!.dependsOn).toContain(rac.id);
    expect(tasks[3]!.dependsOn).not.toContain(auth.id);
  });

  it("leaves a single-screen domain with nothing extra to wait for", () => {
    const tasks = screens(plan(["home"]));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.dependsOn).toEqual(
      expect.arrayContaining([sharedInfraTaskId("p", "design-bindings"), sharedInfraTaskId("p", "data-layer")]),
    );
    expect(tasks[0]!.dependsOn).not.toContain(tasks[0]!.id);
  });

  it("still produces a valid graph — a pathfinder edge must not create a cycle", () => {
    const shared = deriveSharedInfraTasks({ programmeKey: "p", platform: "web", requireTechnicalSpec: true });
    const tasks = plan(["(auth)/login", "(auth)/signup", "rac", "rac/address", "home"]);
    expect(() => validateMilestonePlanAgainstShared(tasks, shared)).not.toThrow();
  });
});
