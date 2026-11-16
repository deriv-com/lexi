import { describe, it, expect } from "vitest";
import {
  InMemoryProgrammeStore,
  parseRenderedAcceptanceCriteria,
} from "./programme-store";

describe("InMemoryProgrammeStore", () => {
  it("upsertBuildTasks refreshes structure but never regresses a live status", async () => {
    const store = new InMemoryProgrammeStore();
    const base = {
      programmeId: "p",
      milestoneId: "m",
      codeRepoKey: "acme_web",
      acceptanceCriterionIds: ["AC-1"],
      designContextNodeIds: [],
      attempts: 0,
    };
    await store.upsertBuildTasks([
      { ...base, id: "t1", title: "T1", status: "PENDING", dependsOn: [] },
    ]);
    await store.updateBuildTask("t1", { status: "DISPATCHED", currentAttemptId: "a1", attempts: 1 });

    // Re-plan arrives with a fresh PENDING row for the same id.
    await store.upsertBuildTasks([
      { ...base, id: "t1", title: "T1 (retitled)", status: "PENDING", dependsOn: ["t0"], acceptanceCriterionIds: ["AC-2"] },
    ]);

    const task = await store.getBuildTask("t1");
    expect(task?.title).toBe("T1 (retitled)");
    expect(task?.dependsOn).toEqual(["t0"]);
    expect(task?.acceptanceCriterionIds).toEqual(["AC-2"]);
    // The live half survived: a re-plan must not re-dispatch running work.
    expect(task?.status).toBe("DISPATCHED");
    expect(task?.currentAttemptId).toBe("a1");
    expect(task?.attempts).toBe(1);
  });

  it("getBuildTaskByAttempt resolves the correlation key", async () => {
    const store = new InMemoryProgrammeStore();
    await store.upsertBuildTasks([
      {
        id: "t1",
        programmeId: "p",
        milestoneId: "m",
        title: "T1",
        status: "DISPATCHED",
        dependsOn: [],
        codeRepoKey: "k",
        acceptanceCriterionIds: [],
        designContextNodeIds: [],
        attempts: 1,
        currentAttemptId: "attempt-9",
      },
    ]);
    expect((await store.getBuildTaskByAttempt("attempt-9"))?.id).toBe("t1");
    expect(await store.getBuildTaskByAttempt("ghost")).toBeNull();
  });

  it("latestDesignContext returns the highest version", async () => {
    const store = new InMemoryProgrammeStore();
    await store.saveDesignContext({ id: "d1", figmaFileKey: "F", version: 1, capturedAt: "t", states: [] });
    await store.saveDesignContext({ id: "d2", figmaFileKey: "F", version: 2, capturedAt: "t", states: [] });
    expect((await store.latestDesignContext("F"))?.id).toBe("d2");
    expect(await store.latestDesignContext("ghost")).toBeNull();
  });
});

describe("parseRenderedAcceptanceCriteria", () => {
  it("parses the exact shape the spec template renders", () => {
    const body = [
      "## Acceptance criteria",
      "- **AC-a1b2c3d4** — Home renders the account switcher",
      "- **AC-9e8f7a6b** — Deposits open the cashier",
      "- a stray bullet without an id is ignored",
    ].join("\n");
    expect(parseRenderedAcceptanceCriteria(body)).toEqual([
      { id: "AC-a1b2c3d4", text: "Home renders the account switcher" },
      { id: "AC-9e8f7a6b", text: "Deposits open the cashier" },
    ]);
  });

  it("returns empty for a body with no rendered criteria — never invents ids", () => {
    expect(parseRenderedAcceptanceCriteria("just prose")).toEqual([]);
  });
});
