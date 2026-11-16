/**
 * Certification tests — Engineering Intelligence & GitHub Projects
 *
 * Verifies:
 * - Projects v2 service (add to board, status update, unboarded queries)
 * - Engineering tools (governed read + write)
 * - Cross-repo issue resolution
 * - Data model integrity
 */
import { describe, expect, it, vi } from "vitest";
import { ProjectsV2Service } from "./projects-v2.service";
import {
  getProjectBoardStatus,
  addToProjectBoard,
  findUnboardedIssues,
  resolveImplementationRepo,
} from "./engineering-tools";

describe("Certification — Engineering Intelligence & GitHub Projects", () => {
  // ==========================================================================
  // D2: GitHub Projects v2
  // ==========================================================================
  describe("D2: GitHub Projects v2", () => {
    it("reports issue not on board when no record exists", async () => {
      const persistence = {
        upsertBoardItem: vi.fn(),
        getBoardItem: vi.fn().mockResolvedValue(null),
        getIssuesNotOnBoard: vi.fn().mockResolvedValue([]),
        getProjectItems: vi.fn().mockResolvedValue([]),
      };
      const service = new ProjectsV2Service(null, persistence, { enabled: true, writesEnabled: false }, { log: vi.fn(), warn: vi.fn() });

      const status = await service.getIssueProjectStatus(856, "acme/issues", "acme", 1);
      expect(status?.onBoard).toBe(false);
    });

    it("returns board status when item exists", async () => {
      const persistence = {
        upsertBoardItem: vi.fn(),
        getBoardItem: vi.fn().mockResolvedValue({
          projectItemId: "item-1",
          status: "In Progress",
          iteration: "Sprint 5",
          priority: "P1",
        }),
        getIssuesNotOnBoard: vi.fn().mockResolvedValue([]),
        getProjectItems: vi.fn().mockResolvedValue([]),
      };
      const service = new ProjectsV2Service(null, persistence, { enabled: true, writesEnabled: false }, { log: vi.fn(), warn: vi.fn() });

      const status = await service.getIssueProjectStatus(856, "acme/issues", "acme", 1);
      expect(status?.onBoard).toBe(true);
      expect(status?.status).toBe("In Progress");
    });

    it("rejects addToBoard when writes disabled (dry-run)", async () => {
      const persistence = {
        upsertBoardItem: vi.fn(),
        getBoardItem: vi.fn(),
        getIssuesNotOnBoard: vi.fn(),
        getProjectItems: vi.fn(),
      };
      const service = new ProjectsV2Service(null, persistence, { enabled: true, writesEnabled: false }, { log: vi.fn(), warn: vi.fn() });

      const result = await service.addToBoard(856, "acme/issues", "acme", 1);
      expect(result.added).toBe(false);
      expect(result.reason).toContain("dry-run");
      // Should still record the intent
      expect(persistence.upsertBoardItem).toHaveBeenCalled();
    });

    it("rejects addToBoard when disabled", async () => {
      const persistence = {
        upsertBoardItem: vi.fn(),
        getBoardItem: vi.fn(),
        getIssuesNotOnBoard: vi.fn(),
        getProjectItems: vi.fn(),
      };
      const service = new ProjectsV2Service(null, persistence, { enabled: false, writesEnabled: true }, { log: vi.fn(), warn: vi.fn() });

      const result = await service.addToBoard(856, "acme/issues", "acme", 1);
      expect(result.added).toBe(false);
      expect(result.reason).toContain("disabled");
    });

    it("finds unboarded issues", async () => {
      const persistence = {
        upsertBoardItem: vi.fn(),
        getBoardItem: vi.fn(),
        getIssuesNotOnBoard: vi.fn().mockResolvedValue([
          { issueNumber: 100, title: "Login broken", labels: ["P1", "auth"] },
          { issueNumber: 200, title: "Deposit fails", labels: ["P1", "cashier"] },
        ]),
        getProjectItems: vi.fn(),
      };
      const service = new ProjectsV2Service(null, persistence, { enabled: true, writesEnabled: false }, { log: vi.fn(), warn: vi.fn() });

      const issues = await service.findUnboardedIssues(
        "acme/issues",
        "acme",
        1,
        { labels: ["P1"] },
      );
      expect(issues).toHaveLength(2);
    });
  });


  // ==========================================================================
  // D3: Engineering Tools
  // ==========================================================================
  describe("D3: Governed Engineering Tools", () => {
    it("getProjectBoardStatus returns status via tool interface", async () => {
      const persistence = {
        upsertBoardItem: vi.fn(),
        getBoardItem: vi.fn().mockResolvedValue({ projectItemId: "x", status: "Done", iteration: null, priority: null }),
        getIssuesNotOnBoard: vi.fn(),
        getProjectItems: vi.fn(),
      };
      const service = new ProjectsV2Service(null, persistence, { enabled: true, writesEnabled: false }, { log: vi.fn(), warn: vi.fn() });

      const result = await getProjectBoardStatus(service, 856, "acme/issues", "acme", 1);
      expect(result.success).toBe(true);
      expect(result.summary).toContain("Done");
    });

    it("addToProjectBoard fails gracefully when disabled", async () => {
      const persistence = {
        upsertBoardItem: vi.fn(),
        getBoardItem: vi.fn(),
        getIssuesNotOnBoard: vi.fn(),
        getProjectItems: vi.fn(),
      };
      const service = new ProjectsV2Service(null, persistence, { enabled: false, writesEnabled: false }, { log: vi.fn(), warn: vi.fn() });

      const result = await addToProjectBoard(service, 856, "acme/issues", "acme", 1);
      expect(result.success).toBe(false);
      expect(result.summary).toContain("disabled");
    });

    it("findUnboardedIssues returns results via tool", async () => {
      const persistence = {
        upsertBoardItem: vi.fn(),
        getBoardItem: vi.fn(),
        getIssuesNotOnBoard: vi.fn().mockResolvedValue([
          { issueNumber: 100, title: "Bug", labels: ["P1"] },
        ]),
        getProjectItems: vi.fn(),
      };
      const service = new ProjectsV2Service(null, persistence, { enabled: true, writesEnabled: false }, { log: vi.fn(), warn: vi.fn() });

      const result = await findUnboardedIssues(service, "acme/issues", "acme", 1, { priority: "P1" });
      expect(result.success).toBe(true);
      expect(result.summary).toContain("1 issue");
    });
  });


  // ==========================================================================
  // D4: Cross-Repo Issue Resolution
  // ==========================================================================
  describe("D4: Cross-Repo Resolution", () => {
    it("resolveImplementationRepo returns operational repos", () => {
      // This test uses the tool function with a mock registry
      const mockRegistry = {
        resolveForTeam: vi.fn().mockReturnValue({
          productKey: "home_web",
          organization: "acme",
          repository: "web-app",
          fullName: "acme/web-app",
          platform: "web",
          team: "home",
          placeholder: false,
        }),
        resolveAllForTeam: vi.fn().mockReturnValue([
          { productKey: "home_web", organization: "acme", repository: "web-app", fullName: "acme/web-app", platform: "web", team: "home", placeholder: false },
          { productKey: "home_mobile", organization: "acme-internal", repository: "mobile-app", fullName: "acme-internal/mobile-app", platform: "mobile", team: "home", placeholder: false },
        ]),
        getSourceRepository: vi.fn(),
        listProducts: vi.fn(),
        getProduct: vi.fn(),
        isRegistered: vi.fn(),
        listOperational: vi.fn(),
      };

      // resolveImplementationRepo is async
      const resultPromise = resolveImplementationRepo(mockRegistry as any, "home");
      return resultPromise.then((result) => {
        expect(result.success).toBe(true);
        expect(result.summary).toContain("acme/web-app");
        expect(result.confidence).toBe("high");
      });
    });

    it("reports no repo for unknown team", async () => {
      const mockRegistry = {
        resolveForTeam: vi.fn().mockReturnValue(null),
        resolveAllForTeam: vi.fn().mockReturnValue([]),
        getSourceRepository: vi.fn(),
        listProducts: vi.fn(),
        getProduct: vi.fn(),
        isRegistered: vi.fn(),
        listOperational: vi.fn(),
      };

      const result = await resolveImplementationRepo(mockRegistry as any, "unknown-team");
      expect(result.success).toBe(true);
      expect(result.summary).toContain("No implementation repository");
    });
  });

  // ==========================================================================
  // D5: Feature Flag Defaults
  // ==========================================================================
  describe("D5: Feature Flags", () => {
    it("PROJECTS_V2_ENABLED defaults to false", async () => {
      const { envSchema } = await import("@lexi/config");
      const result = envSchema.safeParse({
        DATABASE_URL: "postgres://x",
        REDIS_URL: "redis://x",
        GITHUB_TOKEN: "t",
        GITHUB_OWNER: "o",
        GITHUB_REPO: "r",
        SLACK_BOT_TOKEN: "t",
        SLACK_SIGNING_SECRET: "s",
        OPENAI_API_KEY: "k",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PROJECTS_V2_ENABLED).toBe(false);
      }
    });
  });
});
