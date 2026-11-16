/**
 * Unit tests for the Prisma-backed ProjectsPersistence adapter, plus a wiring
 * test that drives the real adapter through ProjectsV2Service with a faked
 * GitHub port — the pairing is what was previously unconstructible.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ProjectsV2PrismaPersistence,
  type ProjectsPrismaClient,
} from "./projects-v2.prisma.persistence";
import { ProjectsV2Service, type ProjectsPersistence, type ProjectsV2GitHubPort } from "./projects-v2.service";

interface FakePrisma extends ProjectsPrismaClient {
  projectBoardItem: ProjectsPrismaClient["projectBoardItem"] & {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  issue: ProjectsPrismaClient["issue"] & { findMany: ReturnType<typeof vi.fn> };
}

function fakePrisma(overrides?: {
  boardItems?: unknown[];
  boardItem?: unknown;
  issues?: unknown[];
}): FakePrisma {
  return {
    projectBoardItem: {
      findUnique: vi.fn().mockResolvedValue(overrides?.boardItem ?? null),
      findMany: vi.fn().mockResolvedValue(overrides?.boardItems ?? []),
      upsert: vi.fn().mockResolvedValue({}),
    },
    issue: {
      findMany: vi.fn().mockResolvedValue(overrides?.issues ?? []),
    },
  } as unknown as FakePrisma;
}

const IDENTITY = {
  issueNumber: 856,
  issueRepository: "acme/issues",
  projectOrg: "acme",
  projectNumber: 1,
};

describe("ProjectsV2PrismaPersistence", () => {
  describe("upsertBoardItem", () => {
    it("targets the compound unique key and stamps lastSyncedAt", async () => {
      const prisma = fakePrisma();
      const persistence = new ProjectsV2PrismaPersistence(prisma);

      await persistence.upsertBoardItem({
        ...IDENTITY,
        projectItemId: "PVTI_1",
        status: "In Progress",
        iteration: "Sprint 5",
        priority: "P1",
        assignee: "alice",
      });

      const args = prisma.projectBoardItem.upsert.mock.calls[0][0];
      expect(args.where).toEqual({
        issueNumber_issueRepository_projectOrg_projectNumber: IDENTITY,
      });
      expect(args.create).toMatchObject({ ...IDENTITY, projectItemId: "PVTI_1", status: "In Progress" });
      expect(args.create.lastSyncedAt).toBeInstanceOf(Date);
      // updatedAt is @default(now()) on this model, not @updatedAt — Prisma will
      // not maintain it, so the adapter must.
      expect(args.update.updatedAt).toBeInstanceOf(Date);
    });

    it("does not clobber iteration/priority/assignee on a status-only update", async () => {
      const prisma = fakePrisma();
      const persistence = new ProjectsV2PrismaPersistence(prisma);

      // This is exactly what ProjectsV2Service.updateStatus sends.
      await persistence.upsertBoardItem({
        ...IDENTITY,
        projectItemId: "PVTI_1",
        status: "Done",
        iteration: null,
        priority: null,
        assignee: null,
      });

      const args = prisma.projectBoardItem.upsert.mock.calls[0][0];
      expect(args.update.status).toBe("Done");
      expect(args.update).not.toHaveProperty("iteration");
      expect(args.update).not.toHaveProperty("priority");
      expect(args.update).not.toHaveProperty("assignee");

      // On INSERT the nulls are still written — there is nothing to preserve.
      expect(args.create.iteration).toBeNull();
      expect(args.create.priority).toBeNull();
    });
  });

  describe("getBoardItem", () => {
    it("returns null when the issue is not on the board", async () => {
      const persistence = new ProjectsV2PrismaPersistence(fakePrisma());
      await expect(
        persistence.getBoardItem(856, "acme/issues", "acme", 1),
      ).resolves.toBeNull();
    });

    it("normalises undefined columns to null", async () => {
      const prisma = fakePrisma({ boardItem: { projectItemId: "PVTI_1", status: "Done" } });
      const persistence = new ProjectsV2PrismaPersistence(prisma);

      await expect(
        persistence.getBoardItem(856, "acme/issues", "acme", 1),
      ).resolves.toEqual({
        projectItemId: "PVTI_1",
        status: "Done",
        iteration: null,
        priority: null,
      });
    });
  });

  describe("getIssuesNotOnBoard", () => {
    it("subtracts boarded issues from open issues", async () => {
      const prisma = fakePrisma({
        boardItems: [{ issueNumber: 100 }],
        issues: [
          { githubNumber: 100, title: "Already boarded", labels: ["P1"] },
          { githubNumber: 200, title: "Deposit fails", labels: ["P1", "cashier"] },
        ],
      });
      const persistence = new ProjectsV2PrismaPersistence(prisma);

      const result = await persistence.getIssuesNotOnBoard("acme/issues", "acme", 1);

      expect(result).toEqual([{ issueNumber: 200, title: "Deposit fails", labels: ["P1", "cashier"] }]);
    });

    it("folds a priority filter into the label match", async () => {
      const prisma = fakePrisma({ issues: [] });
      const persistence = new ProjectsV2PrismaPersistence(prisma);

      await persistence.getIssuesNotOnBoard("acme/issues", "acme", 1, {
        labels: ["cashier"],
        priority: "P1",
      });

      const where = prisma.issue.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ state: "open", repoOwner: "acme", repoName: "issues" });
      expect(where.labels).toEqual({ hasEvery: ["cashier", "P1"] });
    });

    it("scopes the open-issue query to the parsed owner/name", async () => {
      const prisma = fakePrisma({ issues: [] });
      const persistence = new ProjectsV2PrismaPersistence(prisma);

      await persistence.getIssuesNotOnBoard("acme/issues", "acme", 1);

      expect(prisma.issue.findMany.mock.calls[0][0].where).toMatchObject({
        repoOwner: "acme",
        repoName: "issues",
      });
    });

    it("returns empty for a malformed repository slug rather than scanning every issue", async () => {
      const prisma = fakePrisma({ issues: [{ githubNumber: 1, title: "x", labels: [] }] });
      const persistence = new ProjectsV2PrismaPersistence(prisma);

      await expect(persistence.getIssuesNotOnBoard("issues", "acme", 1)).resolves.toEqual([]);
      expect(prisma.issue.findMany).not.toHaveBeenCalled();
    });

    it("honours the configured scan limit", async () => {
      const prisma = fakePrisma({ issues: [] });
      const persistence = new ProjectsV2PrismaPersistence(prisma, { unboardedScanLimit: 25 });

      await persistence.getIssuesNotOnBoard("acme/issues", "acme", 1);
      expect(prisma.issue.findMany.mock.calls[0][0].take).toBe(25);
    });
  });

  describe("getProjectItems", () => {
    it("matches status and assignee case-insensitively", async () => {
      const prisma = fakePrisma({ boardItems: [] });
      const persistence = new ProjectsV2PrismaPersistence(prisma);

      await persistence.getProjectItems("acme", 1, { status: "in progress", assignee: "Alice" });

      expect(prisma.projectBoardItem.findMany.mock.calls[0][0].where).toEqual({
        projectOrg: "acme",
        projectNumber: 1,
        status: { equals: "in progress", mode: "insensitive" },
        assignee: { equals: "Alice", mode: "insensitive" },
      });
    });

    it("drops rows missing the identity columns", async () => {
      const prisma = fakePrisma({
        boardItems: [
          { issueNumber: 856, issueRepository: "acme/issues", status: "Done" },
          { issueNumber: null, issueRepository: "acme/issues" },
        ],
      });
      const persistence = new ProjectsV2PrismaPersistence(prisma);

      const items = await persistence.getProjectItems("acme", 1);
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual({
        issueNumber: 856,
        issueRepository: "acme/issues",
        status: "Done",
        priority: null,
        assignee: null,
      });
    });
  });

  describe("getBoardLastSyncedAt", () => {
    it("returns null when the board has never been synced", async () => {
      const persistence = new ProjectsV2PrismaPersistence(fakePrisma({ boardItems: [] }));
      await expect(persistence.getBoardLastSyncedAt("acme", 1)).resolves.toBeNull();
    });

    it("returns the newest lastSyncedAt", async () => {
      const newest = new Date("2026-08-14T06:00:00Z");
      const prisma = fakePrisma({ boardItems: [{ lastSyncedAt: newest }] });
      const persistence = new ProjectsV2PrismaPersistence(prisma);

      await expect(persistence.getBoardLastSyncedAt("acme", 1)).resolves.toEqual(newest);
      expect(prisma.projectBoardItem.findMany.mock.calls[0][0].orderBy).toEqual({ lastSyncedAt: "desc" });
    });
  });

  // ==========================================================================
  // Wiring: the real persistence adapter driven through ProjectsV2Service.
  // ==========================================================================
  describe("ProjectsV2Service wired to the Prisma persistence adapter", () => {
    /** Every port method as a vi mock, so `mockResolvedValueOnce` stays visible. */
    type MockedGithubPort = { [K in keyof ProjectsV2GitHubPort]: ReturnType<typeof vi.fn> };

    function fakeGithubPort(): MockedGithubPort & ProjectsV2GitHubPort {
      return {
        getProject: vi.fn().mockResolvedValue({
          id: "PVT_1",
          title: "Mobile Team",
          fields: [
            {
              id: "F_status",
              name: "Status",
              type: "single_select",
              options: [
                { id: "opt_todo", name: "Todo" },
                { id: "opt_prog", name: "In Progress" },
              ],
            },
          ],
        }),
        listProjectItems: vi.fn().mockResolvedValue({ items: [], hasNext: false }),
        addIssueToProject: vi.fn().mockResolvedValue("PVTI_new"),
        updateProjectItemField: vi.fn().mockResolvedValue(undefined),
        getIssueNodeId: vi.fn().mockResolvedValue("I_kw1"),
      } as never;
    }

    const logger = () => ({ log: vi.fn(), warn: vi.fn() });

    it("satisfies the ProjectsPersistence port structurally", () => {
      // Compile-time guarantee that the adapter is a legal constructor argument;
      // this is the assertion that was impossible before the adapter existed.
      const persistence: ProjectsPersistence = new ProjectsV2PrismaPersistence(fakePrisma());
      const service = new ProjectsV2Service(
        fakeGithubPort(),
        persistence,
        { enabled: true, writesEnabled: true },
        logger(),
      );
      expect(service).toBeInstanceOf(ProjectsV2Service);
    });

    it("addToBoard persists the returned project item id", async () => {
      const prisma = fakePrisma();
      const github = fakeGithubPort();
      const service = new ProjectsV2Service(
        github,
        new ProjectsV2PrismaPersistence(prisma),
        { enabled: true, writesEnabled: true },
        logger(),
      );

      const result = await service.addToBoard(856, "acme/issues", "acme", 1);

      expect(result).toEqual({ added: true, itemId: "PVTI_new" });
      expect(github.getIssueNodeId).toHaveBeenCalledWith("acme", "issues", 856);
      expect(github.addIssueToProject).toHaveBeenCalledWith("PVT_1", "I_kw1");
      expect(prisma.projectBoardItem.upsert.mock.calls[0][0].create.projectItemId).toBe("PVTI_new");
    });

    it("updateStatus resolves the option id and writes the new status", async () => {
      const prisma = fakePrisma({ boardItem: { projectItemId: "PVTI_1", status: "Todo" } });
      const github = fakeGithubPort();
      const service = new ProjectsV2Service(
        github,
        new ProjectsV2PrismaPersistence(prisma),
        { enabled: true, writesEnabled: true },
        logger(),
      );

      const result = await service.updateStatus(856, "acme/issues", "acme", 1, "in progress");

      expect(result.updated).toBe(true);
      expect(github.updateProjectItemField).toHaveBeenCalledWith("PVT_1", "PVTI_1", "F_status", {
        singleSelectOptionId: "opt_prog",
      });
      expect(prisma.projectBoardItem.upsert.mock.calls[0][0].update.status).toBe("in progress");
    });

    it("syncBoard walks every page and persists each issue item", async () => {
      const prisma = fakePrisma();
      const github = fakeGithubPort();
      github.listProjectItems
        .mockResolvedValueOnce({
          items: [
            {
              id: "PVTI_1",
              contentId: "I_1",
              contentType: "Issue",
              issueNumber: 856,
              issueRepository: "acme/issues",
              status: "In Progress",
              priority: "P1",
              assignees: ["alice"],
            },
            // A draft issue has no issue number and must be skipped.
            { id: "PVTI_2", contentId: "DI_1", contentType: "DraftIssue" },
          ],
          hasNext: true,
          endCursor: "CUR_2",
        })
        .mockResolvedValueOnce({
          items: [
            {
              id: "PVTI_3",
              contentId: "I_2",
              contentType: "Issue",
              issueNumber: 900,
              issueRepository: "acme/issues",
            },
          ],
          hasNext: false,
        });

      const service = new ProjectsV2Service(
        github,
        new ProjectsV2PrismaPersistence(prisma),
        { enabled: true, writesEnabled: true },
        logger(),
      );

      const synced = await service.syncBoard("acme", 1);

      expect(synced).toBe(2);
      expect(github.listProjectItems).toHaveBeenNthCalledWith(2, "acme", 1, "CUR_2", 50);
      expect(prisma.projectBoardItem.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.projectBoardItem.upsert.mock.calls[0][0].create).toMatchObject({
        issueNumber: 856,
        status: "In Progress",
        assignee: "alice",
      });
    });

    it("getIssueProjectStatus reports onBoard:false for an unsynced board", async () => {
      const prisma = fakePrisma();
      const persistence = new ProjectsV2PrismaPersistence(prisma);
      const service = new ProjectsV2Service(
        fakeGithubPort(),
        persistence,
        { enabled: true, writesEnabled: false },
        logger(),
      );

      const status = await service.getIssueProjectStatus(856, "acme/issues", "acme", 1);

      // Indistinguishable from "genuinely not on the board" without consulting
      // lastSyncedAt — which is why the read path needs a freshness check.
      expect(status).toEqual({ onBoard: false, status: null, iteration: null, priority: null });
      await expect(persistence.getBoardLastSyncedAt("acme", 1)).resolves.toBeNull();
    });
  });
});
