import type { AuthorizationResource } from "@lexi/agent";
import { MilestoneStateMachine } from "./milestone-state-machine";
import { ProgrammeStateMachine } from "./programme-state-machine";
import { parseHardeningConcludeClick, parseMilestoneReviewClick } from "./milestone-review-blocks";
import { PROGRAMME_PERMISSIONS } from "./programme-tool-module";
import type { ProgrammePolicy } from "./load-programme-policy";
import type { ProgrammeStore } from "./programme-store";

/** Fail-closed authorization: the caller's RBAC engine, behind a narrow port. */
export interface ProgrammeAuthzPort {
  /** A scoped grant needs `resource`; without it the governance engine refuses. */
  evaluate(ctx: { actorId: string; action: string; resource?: AuthorizationResource }): { allowed: boolean; reason: string };
}

/**
 * Records a human's hardening conclusion. The orchestrator's build service
 * implements it, and throws with a user-facing message when the conclusion
 * cannot be recorded (unknown programme, wrong status).
 */
export interface HardeningConclusionPort {
  recordHardeningConclusion(programmeKey: string, userId: string): Promise<void>;
  /**
   * The programme's repository and team, so a team-scoped approver is checked
   * against the programme's own team. Without it the check carries no
   * resource, which scoped grants refuse.
   */
  programmeResource?(programme: { targetRepoKey: string }): Promise<AuthorizationResource | undefined>;
}

/** The slice of a logger this service uses. */
export interface ReviewLogger {
  log(message: string, context?: string): void;
}

/**
 * The programme human gates — the ONLY routes by which a
 * milestone is ever approved or a hardening concluded. Both tools are
 * withheld from the model payload entirely (`HUMAN_ONLY_PROGRAMME_TOOLS`),
 * so these Block Kit clicks are the whole surface, and this service is the
 * `SpecApprovalService` of the programme world: the Bolt handler is UX and
 * nothing else; feature flag, fail-closed authorization, staleness check and
 * the state-machine write all live here.
 *
 * The staleness analogue of the spec revision check is the head SHA: a
 * reviewer approves the milestone they LOOKED AT, and more tasks can merge
 * between the card rendering and the click, so the SHA in the button value
 * is re-checked against the milestone's current head.
 */

export interface MilestoneReviewResult {
  ok: boolean;
  text: string;
}

const milestoneMachine = new MilestoneStateMachine();
const programmeMachine = new ProgrammeStateMachine();

export interface ProgrammeMilestoneReviewDeps {
  store: ProgrammeStore;
  build: HardeningConclusionPort;
  authz: ProgrammeAuthzPort;
  policy: ProgrammePolicy;
  /** PROGRAMME_ENABLED — the env half. Both halves re-checked per click. */
  programmeEnabled: boolean;
  logger: ReviewLogger;
}

export class ProgrammeMilestoneReviewService {
  constructor(private readonly deps: ProgrammeMilestoneReviewDeps) {}

  /** Single entry for every `programme_milestone_*` action id. */
  async handleAction(actionId: string, value: string, userId: string): Promise<MilestoneReviewResult> {
    if (!this.deps.programmeEnabled || !this.deps.policy.enabled) {
      return {
        ok: false,
        text: "Rebuild programmes are disabled (PROGRAMME_ENABLED / programme-policy.yaml enabled) — nothing was recorded.",
      };
    }

    const conclude = parseHardeningConcludeClick(actionId, value);
    if (conclude) return this.concludeHardening(conclude.programmeKey, userId);

    const click = parseMilestoneReviewClick(actionId, value);
    if (!click) {
      return {
        ok: false,
        text: "That button's data could not be read, so nothing was recorded. Ask Lexi to re-post the milestone review.",
      };
    }
    return this.handleDecision(click.milestoneId, click.decision, click.reviewedSha, userId);
  }

  private async handleDecision(
    milestoneId: string,
    decision: "approve" | "request_changes",
    reviewedSha: string,
    userId: string,
  ): Promise<MilestoneReviewResult> {
    const milestoneForAuthz = await this.deps.store.getMilestone(milestoneId);
    const owning = milestoneForAuthz ? await this.deps.store.getProgrammeById(milestoneForAuthz.programmeId) : null;
    const resource = await this.resourceOf(owning);
    const authz = this.deps.authz.evaluate({
      actorId: userId,
      action: this.deps.policy.milestoneReview.approverPermission,
      ...(resource ? { resource } : {}),
    });
    this.deps.logger.log(
      `Milestone review authz: ${userId} → ${this.deps.policy.milestoneReview.approverPermission} → ${authz.allowed ? "ALLOWED" : "DENIED"} (${authz.reason})`,
      "ProgrammeMilestoneReviewService",
    );
    if (!authz.allowed) return { ok: false, text: `Not authorized: ${authz.reason}` };

    const milestone = await this.deps.store.getMilestone(milestoneId);
    if (!milestone) return { ok: false, text: `Milestone ${milestoneId} was not found.` };
    if (milestone.status !== "IN_REVIEW") {
      return {
        ok: false,
        text: `Milestone ${milestoneId} is ${milestone.status}, not awaiting review — there is no decision to record.`,
      };
    }

    // Staleness: the card's SHA must still be the milestone's head. Re-derive
    // it from the tasks exactly as the card did.
    const tasks = (await this.deps.store.listBuildTasks(milestone.programmeId)).filter(
      (task) => task.milestoneId === milestoneId,
    );
    const currentHead =
      tasks
        .map((task) => task.mergedSha)
        .filter((sha): sha is string => typeof sha === "string" && sha.length > 0)
        .at(-1) ?? "unknown";
    if (reviewedSha !== currentHead) {
      return {
        ok: false,
        text: `That card shows head \`${reviewedSha.slice(0, 12)}\`, but the milestone is now at \`${currentHead.slice(0, 12)}\` — more work merged since you read it. Nothing was recorded; review the fresh card.`,
      };
    }

    const programmes = await this.deps.store.listProgrammesByStatus([
      "MILESTONE_REVIEW",
      "BUILDING",
      "PLANNED",
      "PAUSED",
    ]);
    const programme = programmes.find((candidate) => candidate.id === milestone.programmeId);

    if (decision === "approve") {
      milestoneMachine.assertTransition("IN_REVIEW", "APPROVED");
      await this.deps.store.updateMilestone(milestoneId, { status: "APPROVED", approvedBy: userId });

      // Autopilot's single gate: while the programme is parked for its FINAL
      // review, one approval approves every milestone still in review. Each
      // is machine-checked individually; the click is the same authorization
      // the card asked for, made once instead of N times.
      let alsoApproved: string[] = [];
      if (
        this.deps.policy.milestoneReview.mode === "notify" &&
        programme &&
        programme.status === "MILESTONE_REVIEW"
      ) {
        const siblings = (await this.deps.store.listMilestones(programme.id)).filter(
          (candidate) =>
            candidate.id !== milestoneId && candidate.ordinal > 0 && candidate.status === "IN_REVIEW",
        );
        for (const sibling of siblings) {
          milestoneMachine.assertTransition("IN_REVIEW", "APPROVED");
          await this.deps.store.updateMilestone(sibling.id, { status: "APPROVED", approvedBy: userId });
        }
        alsoApproved = siblings.map((sibling) => sibling.id);
      }

      if (programme && programme.status === "MILESTONE_REVIEW") {
        programmeMachine.assertTransition("MILESTONE_REVIEW", "BUILDING");
        await this.deps.store.updateProgramme(programme.key, { status: "BUILDING" });
      }
      return {
        ok: true,
        text:
          alsoApproved.length > 0
            ? `Final review approved by <@${userId}>: ${milestoneId} at \`${currentHead.slice(0, 12)}\` plus ${alsoApproved.length} pending milestone${alsoApproved.length === 1 ? "" : "s"} (${alsoApproved.join(", ")}). The hardening pass opens on the next advance tick.`
            : `Milestone ${milestoneId} approved at \`${currentHead.slice(0, 12)}\` by <@${userId}>. The programme resumes on the next advance tick.`,
      };
    }

    milestoneMachine.assertTransition("IN_REVIEW", "CHANGES_REQUESTED");
    await this.deps.store.updateMilestone(milestoneId, { status: "CHANGES_REQUESTED" });
    if (programme && programme.status === "MILESTONE_REVIEW") {
      programmeMachine.assertTransition("MILESTONE_REVIEW", "BUILDING");
      await this.deps.store.updateProgramme(programme.key, { status: "BUILDING" });
    }
    return {
      ok: true,
      text: `Changes requested on ${milestoneId} by <@${userId}>. Revise the milestone spec and re-run propose_milestone_plan to resume work.`,
    };
  }

  private async resourceOf(programme: { targetRepoKey: string } | null): Promise<AuthorizationResource | undefined> {
    if (!programme || !this.deps.build.programmeResource) return undefined;
    try {
      return await this.deps.build.programmeResource(programme);
    } catch {
      return undefined;
    }
  }

  private async concludeHardening(programmeKey: string, userId: string): Promise<MilestoneReviewResult> {
    const resource = await this.resourceOf(await this.deps.store.getProgramme(programmeKey));
    const authz = this.deps.authz.evaluate({
      actorId: userId,
      action: PROGRAMME_PERMISSIONS.HARDENING_CONCLUDE,
      ...(resource ? { resource } : {}),
    });
    if (!authz.allowed) return { ok: false, text: `Not authorized: ${authz.reason}` };
    try {
      await this.deps.build.recordHardeningConclusion(programmeKey, userId);
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : "Could not record the conclusion." };
    }
    return {
      ok: true,
      text: `Hardening on \`${programmeKey}\` concluded by <@${userId}>. The programme completes on the next advance tick if — and only if — zero hardening findings remain open.`,
    };
  }
}
