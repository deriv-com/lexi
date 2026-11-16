import { describe, it, expect, vi, beforeEach } from "vitest";
import { MILESTONE_REVIEW_ACTIONS } from "./milestone-review-blocks";
import { parseProgrammePolicy } from "./load-programme-policy";
import { ProgrammeMilestoneReviewService, type HardeningConclusionPort, type ReviewLogger } from "./programme-milestone-review";
import { InMemoryProgrammeStore } from "./programme-store";

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ReviewLogger;

const POLICY = parseProgrammePolicy(["version: 1", "enabled: true"].join("\n"));

function click(milestoneId: string, headSha: string): string {
  return JSON.stringify({ milestoneId, headSha });
}

describe("ProgrammeMilestoneReviewService", () => {
  let store: InMemoryProgrammeStore;
  let recordConclusion: ReturnType<typeof vi.fn>;
  let service: ProgrammeMilestoneReviewService;
  let allowed: boolean;

  beforeEach(async () => {
    store = new InMemoryProgrammeStore();
    allowed = true;
    recordConclusion = vi.fn(async () => undefined);
    service = new ProgrammeMilestoneReviewService({
      store,
      build: { recordHardeningConclusion: recordConclusion } as unknown as HardeningConclusionPort,
      authz: { evaluate: () => ({ allowed, reason: allowed ? "ok" : "denied by fixture" }) },
      policy: POLICY,
      programmeEnabled: true,
      logger,
    });

    await store.createProgramme({
      id: "prog-1",
      key: "rebuild",
      title: "Rebuild",
      status: "MILESTONE_REVIEW",
      targetRepoKey: "acme_web",
      figmaFileKeys: [],
    });
    await store.createMilestones([
      { id: "m1", programmeId: "prog-1", ordinal: 1, title: "Shell", status: "IN_REVIEW" },
    ]);
    await store.upsertBuildTasks([
      {
        id: "t1",
        programmeId: "prog-1",
        milestoneId: "m1",
        title: "T1",
        status: "MERGED",
        dependsOn: [],
        codeRepoKey: "acme_web",
        acceptanceCriterionIds: [],
        designContextNodeIds: [],
        attempts: 1,
        mergedSha: "sha-current",
      },
    ]);
  });

  it("refuses while either kill-switch half is off — nothing recorded", async () => {
    const dark = new ProgrammeMilestoneReviewService({
      store,
      build: { recordHardeningConclusion: recordConclusion } as unknown as HardeningConclusionPort,
      authz: { evaluate: () => ({ allowed: true, reason: "ok" }) },
      policy: parseProgrammePolicy("version: 1\n"),
      programmeEnabled: true,
      logger,
    });
    const result = await dark.handleAction(MILESTONE_REVIEW_ACTIONS.APPROVE, click("m1", "sha-current"), "U1");
    expect(result.ok).toBe(false);
    expect((await store.getMilestone("m1"))?.status).toBe("IN_REVIEW");
  });

  it("refuses an unauthorized click with the denial reason", async () => {
    allowed = false;
    const result = await service.handleAction(MILESTONE_REVIEW_ACTIONS.APPROVE, click("m1", "sha-current"), "U1");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Not authorized");
    expect((await store.getMilestone("m1"))?.status).toBe("IN_REVIEW");
  });

  it("refuses a STALE card — the reviewer approves what they looked at", async () => {
    const result = await service.handleAction(MILESTONE_REVIEW_ACTIONS.APPROVE, click("m1", "sha-old"), "U1");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("more work merged");
    expect((await store.getMilestone("m1"))?.status).toBe("IN_REVIEW");
  });

  it("approve records the approver and resumes the programme", async () => {
    const result = await service.handleAction(MILESTONE_REVIEW_ACTIONS.APPROVE, click("m1", "sha-current"), "U_LEAD");
    expect(result.ok, result.text).toBe(true);
    const milestone = await store.getMilestone("m1");
    expect(milestone?.status).toBe("APPROVED");
    expect(milestone?.approvedBy).toBe("U_LEAD");
    expect((await store.getProgramme("rebuild"))?.status).toBe("BUILDING");
  });

  it("request_changes reopens work without approving anything", async () => {
    const result = await service.handleAction(
      MILESTONE_REVIEW_ACTIONS.REQUEST_CHANGES,
      click("m1", "sha-current"),
      "U_LEAD",
    );
    expect(result.ok).toBe(true);
    expect((await store.getMilestone("m1"))?.status).toBe("CHANGES_REQUESTED");
    expect((await store.getProgramme("rebuild"))?.status).toBe("BUILDING");
  });

  it("a second approve click is a no-decision, not a double write", async () => {
    await service.handleAction(MILESTONE_REVIEW_ACTIONS.APPROVE, click("m1", "sha-current"), "U_LEAD");
    const again = await service.handleAction(MILESTONE_REVIEW_ACTIONS.APPROVE, click("m1", "sha-current"), "U2");
    expect(again.ok).toBe(false);
    expect(again.text).toContain("not awaiting review");
    expect((await store.getMilestone("m1"))?.approvedBy).toBe("U_LEAD");
  });

  it("conclude_hunt routes to the build service under its own permission", async () => {
    const result = await service.handleAction(
      MILESTONE_REVIEW_ACTIONS.CONCLUDE_HARDENING,
      JSON.stringify({ programmeKey: "rebuild" }),
      "U_LEAD",
    );
    expect(result.ok, result.text).toBe(true);
    expect(recordConclusion).toHaveBeenCalledWith("rebuild", "U_LEAD");
  });

  describe("team-scoped approvers", () => {
    // Mirrors the governance engine: a team-scoped grant needs the resource's team.
    function scopedService(team: string) {
      const evaluate = vi.fn((ctx: { resource?: { team?: string } }) =>
        ctx.resource?.team === team ? { allowed: true, reason: "ok" } : { allowed: false, reason: "outside your team" },
      );
      const scoped = new ProgrammeMilestoneReviewService({
        store,
        build: {
          recordHardeningConclusion: recordConclusion,
          programmeResource: async (programme: { targetRepoKey: string }) =>
            programme.targetRepoKey === "acme_web" ? { repository: "acme/web", team: "home" } : undefined,
        } as unknown as HardeningConclusionPort,
        authz: { evaluate },
        policy: POLICY,
        programmeEnabled: true,
        logger,
      });
      return { scoped, evaluate };
    }

    it("a lead may approve their own team's milestone; the check carries the programme's repository", async () => {
      const { scoped, evaluate } = scopedService("home");
      const result = await scoped.handleAction(MILESTONE_REVIEW_ACTIONS.APPROVE, click("m1", "sha-current"), "U_LEAD");
      expect(result.ok, result.text).toBe(true);
      expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ resource: { repository: "acme/web", team: "home" } }));
    });

    it("a lead of another team is refused, and nothing is recorded", async () => {
      const { scoped } = scopedService("p2p");
      const result = await scoped.handleAction(MILESTONE_REVIEW_ACTIONS.APPROVE, click("m1", "sha-current"), "U_LEAD");
      expect(result.ok).toBe(false);
      expect((await store.getMilestone("m1"))?.status).toBe("IN_REVIEW");
      const conclude = await scoped.handleAction(
        MILESTONE_REVIEW_ACTIONS.CONCLUDE_HARDENING,
        JSON.stringify({ programmeKey: "rebuild" }),
        "U_LEAD",
      );
      expect(conclude.ok).toBe(false);
      expect(recordConclusion).not.toHaveBeenCalled();
    });
  });

  describe("autopilot (milestoneReview.mode: notify)", () => {
    const NOTIFY = parseProgrammePolicy(
      ["version: 1", "enabled: true", "milestoneReview:", "  mode: notify"].join("\n"),
    );

    beforeEach(async () => {
      service = new ProgrammeMilestoneReviewService({
        store,
        build: { recordHardeningConclusion: recordConclusion } as unknown as HardeningConclusionPort,
        authz: { evaluate: () => ({ allowed, reason: allowed ? "ok" : "denied by fixture" }) },
        policy: NOTIFY,
        programmeEnabled: true,
        logger,
      });
      await store.createMilestones([
        { id: "m2", programmeId: "prog-1", ordinal: 2, title: "Trade", status: "IN_REVIEW" },
        { id: "m3", programmeId: "prog-1", ordinal: 3, title: "Wallet", status: "CHANGES_REQUESTED" },
        // Bookkeeping row: never a deliverable, never swept along.
        { id: "rebuild:hardening", programmeId: "prog-1", ordinal: 0, title: "Hardening conclusion", status: "IN_REVIEW" },
      ]);
    });

    it("the FINAL review approves every pending milestone on one click", async () => {
      const result = await service.handleAction(MILESTONE_REVIEW_ACTIONS.APPROVE, click("m1", "sha-current"), "U_LEAD");
      expect(result.ok, result.text).toBe(true);
      expect(result.text).toContain("Final review approved");
      expect(result.text).toContain("m2");
      expect((await store.getMilestone("m1"))?.status).toBe("APPROVED");
      expect((await store.getMilestone("m2"))?.status).toBe("APPROVED");
      expect((await store.getMilestone("m2"))?.approvedBy).toBe("U_LEAD");
      // Only IN_REVIEW siblings ride along: neither the reopened one nor the bookkeeping row.
      expect((await store.getMilestone("m3"))?.status).toBe("CHANGES_REQUESTED");
      expect((await store.getMilestone("rebuild:hardening"))?.status).toBe("IN_REVIEW");
      expect((await store.getProgramme("rebuild"))?.status).toBe("BUILDING");
    });

    it("a notification-card click while the programme is still BUILDING approves only that milestone", async () => {
      await store.updateProgramme("rebuild", { status: "BUILDING" });
      const result = await service.handleAction(MILESTONE_REVIEW_ACTIONS.APPROVE, click("m1", "sha-current"), "U_LEAD");
      expect(result.ok, result.text).toBe(true);
      expect(result.text).not.toContain("Final review");
      expect((await store.getMilestone("m1"))?.status).toBe("APPROVED");
      expect((await store.getMilestone("m2"))?.status).toBe("IN_REVIEW");
    });

    it("the same authorization and staleness rules gate the final click", async () => {
      allowed = false;
      const denied = await service.handleAction(MILESTONE_REVIEW_ACTIONS.APPROVE, click("m1", "sha-current"), "U1");
      expect(denied.ok).toBe(false);
      allowed = true;
      const stale = await service.handleAction(MILESTONE_REVIEW_ACTIONS.APPROVE, click("m1", "sha-old"), "U_LEAD");
      expect(stale.ok).toBe(false);
      expect((await store.getMilestone("m2"))?.status).toBe("IN_REVIEW");
    });
  });

  it("unparseable payloads record nothing", async () => {
    const result = await service.handleAction(MILESTONE_REVIEW_ACTIONS.APPROVE, "not json", "U1");
    expect(result.ok).toBe(false);
    expect((await store.getMilestone("m1"))?.status).toBe("IN_REVIEW");
  });
});
