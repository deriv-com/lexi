import { describe, expect, it, vi } from "vitest";
import type { ApiContractDocument, DesignContextDocument } from "@lexi/contracts";
import {
  InMemoryProgrammeStore,
  type BuildTaskRecord,
  type MilestoneRecord,
  type ProgrammeRecord,
  type ProgrammeStore,
} from "../programme-store";
import { PrismaProgrammeSpecReader, PrismaProgrammeStore } from "./programme-store.prisma";
import { schemaFakeClient, schemaFieldNames } from "./schema-fake.test-support";

const MODELS = ["AppRebuildProgramme", "ProgrammeMilestone", "BuildTask", "DesignContextDocument", "ApiContractDocument"];

function prismaStore(): { store: PrismaProgrammeStore; client: ReturnType<typeof schemaFakeClient> } {
  const client = schemaFakeClient(...MODELS);
  return { store: new PrismaProgrammeStore(client), client };
}

/* Fully populated records: every optional field set, so a dropped column shows. */
const PROGRAMME: ProgrammeRecord = {
  id: "prog-1",
  key: "acme_web_rebuild",
  title: "Web rebuild",
  status: "BUILDING",
  targetRepoKey: "acme_web",
  platform: "web",
  sourceSpecRepoKey: "acme_specs",
  sourceSpecIssueNumber: 12,
  figmaFileKeys: ["FILE_A", "FILE_B"],
  designContextId: "dc-1",
  specId: "spec-1",
  referenceRepoKey: "acme_legacy",
  pausedReason: "waiting on a decision",
  createdBy: "U0TEST01",
  metadata: { baseBranch: "rebuild/main", trackingIssue: { number: 3, url: "https://github.com/acme/web/issues/3" } },
};

const MILESTONE: MilestoneRecord = {
  id: "acme_web_rebuild:m1",
  programmeId: "prog-1",
  ordinal: 1,
  title: "Auth",
  status: "IN_REVIEW",
  specId: "spec-m1",
  reviewChannel: "C0TEST01",
  reviewThreadTs: "1700000000.000100",
  approvedBy: "U0TEST02",
  sweepAttemptId: "attempt-sweep-1",
  sweepHeadSha: "abc123",
};

const TASK: BuildTaskRecord = {
  id: "acme_web_rebuild:m1:login",
  programmeId: "prog-1",
  milestoneId: "acme_web_rebuild:m1",
  title: "Login screen",
  status: "PR_OPEN",
  dependsOn: ["acme_web_rebuild:m1:shell"],
  codeRepoKey: "acme_web",
  acceptanceCriterionIds: ["AC-aaaa1111", "AC-bbbb2222"],
  designContextNodeIds: ["1:2"],
  attempts: 2,
  currentAttemptId: "attempt-7",
  prNumber: 41,
  mergedSha: "def456",
  lastMergeVerdict: { allowed: false, reasons: ["checks pending"] } as unknown as BuildTaskRecord["lastMergeVerdict"],
  metadata: { kind: "screen", screenStates: ["empty", "error"], testKinds: ["unit"], dispatchedAt: "2026-01-01T00:00:00.000Z" },
};

const DESIGN: DesignContextDocument = {
  id: "dc-1",
  figmaFileKey: "FILE_A",
  version: 2,
  capturedAt: "2026-01-02T03:04:05.000Z",
  states: [],
  componentCatalogue: { components: ["Button"] },
};

const CONTRACT: ApiContractDocument = {
  id: "api-1",
  sourceRepoSlug: "acme/api",
  sourcePath: "openapi.yaml",
  sourceSha: "0123abcd",
  version: 3,
  capturedAt: "2026-01-02T03:04:05.000Z",
  info: { title: "Acme API", version: "1.0.0" },
  operations: [],
  excludedOperationCount: 4,
  spec: { openapi: "3.1.0" },
};

async function seed(store: ProgrammeStore): Promise<void> {
  await store.createProgramme(PROGRAMME);
  await store.createMilestones([MILESTONE]);
  await store.upsertBuildTasks([TASK]);
  await store.saveDesignContext(DESIGN);
  await store.saveApiContract(CONTRACT);
}

describe("PrismaProgrammeStore round-trips every field the in-memory store keeps", () => {
  // The in-memory store keeps whatever it is handed, so it cannot see a column
  // the Prisma path forgets to write. Every engine spec runs against it. This
  // block is what catches a dropped column: identical writes into both stores,
  // identical reads expected, through a client that only knows schema.prisma.
  it("creates", async () => {
    const memory = new InMemoryProgrammeStore();
    const { store } = prismaStore();
    await seed(memory);
    await seed(store);

    expect(await store.getProgramme(PROGRAMME.key)).toEqual(await memory.getProgramme(PROGRAMME.key));
    expect(await store.getMilestone(MILESTONE.id)).toEqual(await memory.getMilestone(MILESTONE.id));
    expect(await store.listMilestones("prog-1")).toEqual(await memory.listMilestones("prog-1"));
    expect(await store.getBuildTask(TASK.id)).toEqual(await memory.getBuildTask(TASK.id));
    expect(await store.getBuildTaskByAttempt("attempt-7")).toEqual(await memory.getBuildTaskByAttempt("attempt-7"));
    expect(await store.getDesignContext(DESIGN.id)).toEqual(await memory.getDesignContext(DESIGN.id));
    expect(await store.latestDesignContext("FILE_A")).toEqual(await memory.latestDesignContext("FILE_A"));
    expect(await store.getApiContract(CONTRACT.id)).toEqual(await memory.getApiContract(CONTRACT.id));
    expect(await store.latestApiContract("acme/api", "openapi.yaml")).toEqual(
      await memory.latestApiContract("acme/api", "openapi.yaml"),
    );
  });

  it("updates", async () => {
    const memory = new InMemoryProgrammeStore();
    const { store } = prismaStore();
    for (const target of [memory, store] as ProgrammeStore[]) {
      await seed(target);
      await target.updateProgramme(PROGRAMME.key, {
        status: "PAUSED",
        pausedReason: "paused by alice",
        designContextId: "dc-2",
        specId: "spec-2",
        metadata: { decisions: ["keep the header"] },
      });
      await target.updateMilestone(MILESTONE.id, {
        status: "APPROVED",
        specId: "spec-m1b",
        reviewChannel: "C0TEST02",
        reviewThreadTs: "1700000000.000200",
        approvedBy: "U0TEST03",
        sweepAttemptId: null,
        sweepHeadSha: null,
      });
      await target.updateBuildTask(TASK.id, {
        status: "MERGED",
        attempts: 3,
        currentAttemptId: "attempt-8",
        prNumber: 42,
        mergedSha: "fedcba",
        lastMergeVerdict: null,
        metadata: { kind: "screen", headSha: "fedcba" },
        acceptanceCriterionIds: ["AC-cccc3333"],
      });
    }
    expect(await store.getProgramme(PROGRAMME.key)).toEqual(await memory.getProgramme(PROGRAMME.key));
    expect(await store.getMilestone(MILESTONE.id)).toEqual(await memory.getMilestone(MILESTONE.id));
    expect(await store.getBuildTask(TASK.id)).toEqual(await memory.getBuildTask(TASK.id));
  });

  it("re-plans without regressing a live task, as the in-memory store does", async () => {
    const memory = new InMemoryProgrammeStore();
    const { store } = prismaStore();
    for (const target of [memory, store] as ProgrammeStore[]) {
      await target.upsertBuildTasks([TASK]);
      await target.upsertBuildTasks([
        {
          ...TASK,
          title: "Login screen (retitled)",
          status: "PENDING",
          attempts: 0,
          currentAttemptId: null,
          prNumber: null,
          dependsOn: [],
          metadata: { kind: "screen", screenStates: ["empty"], testKinds: [] },
        },
      ]);
    }
    const after = await store.getBuildTask(TASK.id);
    expect(after).toEqual(await memory.getBuildTask(TASK.id));
    expect(after?.status).toBe("PR_OPEN");
    expect(after?.currentAttemptId).toBe("attempt-7");
    expect(after?.metadata).toMatchObject({ screenStates: ["empty"], dispatchedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("maps every column of the five models to a record field (none written and never read back)", () => {
    // A column added to schema.prisma without a mapping here is the same bug
    // from the other side: written by nobody, read by nobody.
    const unmapped = (model: string, mapped: string[]) =>
      [...schemaFieldNames(model)].filter((column) => !mapped.includes(column));
    const audit = ["createdAt", "updatedAt"];
    expect(unmapped("AppRebuildProgramme", [...Object.keys(PROGRAMME), ...audit])).toEqual([]);
    expect(unmapped("ProgrammeMilestone", [...Object.keys(MILESTONE), "approvedAt", ...audit])).toEqual([]);
    expect(unmapped("BuildTask", [...Object.keys(TASK), ...audit])).toEqual([]);
    expect(unmapped("DesignContextDocument", ["id", "figmaFileKey", "version", "capturedAt", "content", "componentCatalogue"])).toEqual([]);
    expect(unmapped("ApiContractDocument", Object.keys(CONTRACT))).toEqual([]);
  });
});

describe("PrismaProgrammeStore milestone approvals", () => {
  const conclusion = (approvedBy?: string): MilestoneRecord => ({
    id: "acme_web_rebuild:hardening",
    programmeId: "prog-1",
    ordinal: 0,
    title: "Hardening conclusion",
    status: "APPROVED",
    ...(approvedBy ? { approvedBy } : {}),
  });

  it("writes approvedBy and approvedAt when creating a hardening conclusion row", async () => {
    const { store, client } = prismaStore();
    await store.createMilestones([conclusion("U0TEST01")]);
    const row = client.programmeMilestone!.rows[0]!;
    expect(row.approvedBy).toBe("U0TEST01");
    expect(row.approvedAt).toBeInstanceOf(Date);
  });

  it("repairs a missing approval on a row that already exists, and leaves planner rows alone", async () => {
    const { store, client } = prismaStore();
    await store.createMilestones([conclusion()]);
    await store.createMilestones([conclusion("U0TEST01")]);
    expect((await store.getMilestone("acme_web_rebuild:hardening"))?.approvedBy).toBe("U0TEST01");

    await store.createMilestones([{ ...MILESTONE, approvedBy: null }]);
    await store.updateMilestone(MILESTONE.id, { status: "APPROVED" });
    await store.createMilestones([{ ...MILESTONE, approvedBy: null, status: "PENDING" }]);
    expect((await store.getMilestone(MILESTONE.id))?.status).toBe("APPROVED");
    expect(client.programmeMilestone!.rows).toHaveLength(2);
  });

  it("clears approvedAt with the approver", async () => {
    const { store, client } = prismaStore();
    await store.createMilestones([conclusion("U0TEST01")]);
    await store.updateMilestone("acme_web_rebuild:hardening", { approvedBy: null });
    expect(client.programmeMilestone!.rows[0]!.approvedAt).toBeNull();
  });
});

describe("PrismaProgrammeStore conditional task writes", () => {
  it("writes through updateMany guarded on status, and reports whether a row matched", async () => {
    const updateMany = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const store = new PrismaProgrammeStore({ buildTask: { updateMany } });
    expect(await store.updateBuildTaskIfStatus("t1", ["PR_OPEN"], { acceptanceCriterionIds: ["AC-aaaa1111"] })).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "t1", status: { in: ["PR_OPEN"] } },
      data: { acceptanceCriterionIds: ["AC-aaaa1111"] },
    });
    expect(await store.updateBuildTaskIfStatus("t1", ["PR_OPEN"], {})).toBe(false);
  });

  it("refuses when the status moved", async () => {
    const { store } = prismaStore();
    await store.upsertBuildTasks([TASK]);
    expect(await store.updateBuildTaskIfStatus(TASK.id, ["DISPATCHED"], { status: "PR_OPEN" })).toBe(false);
    expect(await store.updateBuildTaskIfStatus(TASK.id, ["PR_OPEN"], { status: "MERGED" })).toBe(true);
    expect((await store.getBuildTask(TASK.id))?.status).toBe("MERGED");
  });

  it("lists programmes by status in creation order", async () => {
    const { store } = prismaStore();
    await store.createProgramme(PROGRAMME);
    await store.createProgramme({ ...PROGRAMME, id: "prog-2", key: "acme_mobile_rebuild", status: "COMPLETE" });
    expect((await store.listProgrammesByStatus(["BUILDING", "PAUSED"])).map((p) => p.key)).toEqual(["acme_web_rebuild"]);
  });

  it("names the missing delegate when the client predates the migration", async () => {
    const store = new PrismaProgrammeStore({});
    await expect(store.getProgramme("x")).rejects.toThrow(/no appRebuildProgramme delegate/);
  });
});

describe("PrismaProgrammeSpecReader", () => {
  it("reads the latest APPROVED revision and parses its rendered criteria", async () => {
    const client = schemaFakeClient("SpecDocument");
    const base = { sessionId: "spec-1", trackingRepoKey: "acme_specs", contentHash: "h", issueNumber: 9 };
    await client.specDocument!.create({ data: { ...base, revision: 1, status: "APPROVED", body: "- **AC-aaaa1111** — old" } });
    await client.specDocument!.create({ data: { ...base, revision: 2, status: "APPROVED", body: "- **AC-bbbb2222** — Signs in" } });
    await client.specDocument!.create({ data: { ...base, revision: 3, status: "DRAFT", body: "- **AC-cccc3333** — draft" } });
    const view = await new PrismaProgrammeSpecReader(client).loadApprovedSpec("spec-1");
    expect(view).toEqual({
      specId: "spec-1",
      revision: 2,
      status: "APPROVED",
      contentHash: "h",
      issueNumber: 9,
      trackingRepoKey: "acme_specs",
      acceptanceCriteria: [{ id: "AC-bbbb2222", text: "Signs in" }],
    });
    expect(await new PrismaProgrammeSpecReader(client).loadApprovedSpec("unknown")).toBeNull();
    expect(await new PrismaProgrammeSpecReader({}).loadApprovedSpec("spec-1")).toBeNull();
  });
});
