import type { RepoDescriptor } from "@lexi/contracts";
import type { AuthorizationResource } from "@lexi/agent";
import {
  PROGRAMME_PERMISSIONS,
  PROGRAMME_TOOL_PERMISSIONS,
  type ProgrammeToolName,
} from "../programme-tool-module";
import { repoSettingsFor } from "../load-programme-policy";
import { readyTasks } from "../task-graph";
import { benchArmOf, isBenchTask, planModelBench, withoutBenchTasks } from "../model-bench-plan";
import type { BuildTaskRecord, ProgrammeRecord } from "../programme-store";
import type { ProgrammeToolResult } from "./ports";
import {
  RESCOPABLE_STATUSES,
  withoutSlackMentions,
  MAX_EXTRA_ATTEMPTS_PER_GRANT,
  MAX_RETRY_REASON_CHARS,
  extraAttemptsOf,
  MAX_TASKS_PER_CANCEL,
  BENCH_HOST_STATUSES,
  taskMachine,
  programmeMetadata,
  resolveBenchSource,
  type BuildTaskStatusLike,
} from "./helpers";
import { ProgrammePlanning } from "./programme-planning";

/**
 * The agent-facing tool entrypoint (`invokeTool`) and the per-task commands:
 * re-scoping criteria, retrying, retiring or restoring tasks, and model
 * benches. Every write is machine-checked and refuses on stale state.
 */
export abstract class ProgrammeTaskCommands extends ProgrammePlanning {

  /* ---------------------------------------------------------------- tools */

  /**
   * The repository (and its team) a programme tool call targets, for scoped
   * authorization: the repository `start_app_rebuild` would land in, or the
   * named programme's target repository. Undefined when the arguments name
   * nothing that resolves, which a scoped grant does not cover.
   */
  async toolResource(name: ProgrammeToolName, args: Record<string, unknown>): Promise<AuthorizationResource | undefined> {
    let repoKey: string | undefined;
    if (name === "start_app_rebuild") {
      repoKey = typeof args.targetRepoKey === "string" ? args.targetRepoKey : undefined;
    } else {
      const programmeKey = typeof args.programmeKey === "string" ? args.programmeKey : "";
      const programme = programmeKey ? await this.deps.store.getProgramme(programmeKey) : null;
      repoKey = programme?.targetRepoKey;
    }
    return repoKey ? this.repoResource(repoKey) : undefined;
  }

  /** The repository and team a programme acts on, for checks that start from a record. */
  async programmeResource(programme: { targetRepoKey: string }): Promise<AuthorizationResource | undefined> {
    return this.repoResource(programme.targetRepoKey);
  }

  private repoResource(repoKey: string): AuthorizationResource | undefined {
    const repo = this.deps.registry.resolveRepo(repoKey);
    if (!repo) return undefined;
    return { repository: repo.slug, ...(repo.team ? { team: repo.team } : {}) };
  }

  async invokeTool(
    name: ProgrammeToolName,
    args: Record<string, unknown>,
    ctx: { userId: string; channel?: string; threadTs?: string },
  ): Promise<ProgrammeToolResult> {
    // Both kill-switch halves, re-checked at invoke time: the module is
    // withheld while the flag is off, but a tool name can reach here by
    // other routes and must meet the same refusal.
    if (!this.deps.flags.programmeEnabled || !this.deps.policy.enabled) {
      return {
        ok: false,
        text: "Rebuild programmes are disabled (PROGRAMME_ENABLED / programme-policy.yaml enabled).",
        executed: false,
      };
    }

    const permission = PROGRAMME_TOOL_PERMISSIONS[name];
    let resource: AuthorizationResource | undefined;
    try {
      resource = await this.toolResource(name, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, text: `Not authorized: the programme's repository could not be resolved (${message}).`, executed: false };
    }
    const decision = this.deps.authz.evaluate({
      actorId: ctx.userId,
      action: permission,
      ...(resource ? { resource } : {}),
    });
    if (!decision.allowed) {
      return { ok: false, text: `Not authorized: ${decision.reason}`, executed: false };
    }

    try {
      switch (name) {
        case "start_app_rebuild":
          return await this.startProgramme(args, ctx.userId, ctx);
        case "get_programme_status":
          return await this.programmeStatus(args);
        case "propose_milestone_plan":
          return args.deferred === true
            ? await this.queueMilestonePlan(args, ctx.userId)
            : await this.proposeMilestonePlan(args);
        case "add_milestones":
          return await this.addMilestones(args);
        case "pause_programme":
          return await this.pauseProgramme(args, ctx.userId);
        case "resume_programme":
          return await this.resumeProgramme(args, ctx.userId);
        case "cancel_programme":
          return await this.cancelProgramme(args, ctx.userId);
        case "retry_build_task":
          return await this.retryBuildTask(args, ctx.userId);
        case "cancel_build_tasks":
          return await this.cancelBuildTasks(args, ctx.userId);
        case "record_programme_decision":
          return await this.recordDecision(args, ctx.userId);
        case "set_task_criteria":
          return await this.setTaskCriteria(args, ctx.userId);
        case "prepare_technical_spec":
          return await this.prepareTechnicalSpec(args);
        case "start_model_bench":
          return await this.startModelBench(args, ctx.userId);
        default:
          return { ok: false, text: `Unknown programme tool: ${name as string}`, executed: false };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Programme tool failed";
      return { ok: false, text: message, executed: false };
    }
  }


  /**
   * Replaces the criteria a task owns. The plan spreads EVERY spec criterion
   * round-robin across a milestone's screens when no criteria map re-owns
   * them (deriveMilestonePlan), so a one-screen milestone — M1 "empty home
   * with logout" — can own every login and signup criterion, bind the one it
   * built, and have the gate refuse its PR every tick for ever.
   * Removed ids are kept on the programme as deferred, never dropped, and a
   * task in flight is refused: its brief already carries the old contract.
   */
  protected async setTaskCriteria(args: Record<string, unknown>, actor: string): Promise<ProgrammeToolResult> {
    const programmeKey = typeof args.programmeKey === "string" ? args.programmeKey : "";
    const buildTaskId = typeof args.buildTaskId === "string" ? args.buildTaskId : "";
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    const raw = Array.isArray(args.criterionIds) ? args.criterionIds : [];
    const requested = [
      ...new Set(
        raw
          .filter((id): id is string => typeof id === "string")
          .map((id) => id.trim())
          .filter(Boolean)
          .map((id) => (/^AC-[0-9a-f]{8}$/i.test(id) ? `AC-${id.slice(3).toLowerCase()}` : id)),
      ),
    ];

    const programme = await this.deps.store.getProgramme(programmeKey);
    if (!programme) return { ok: false, text: `No programme named ${programmeKey}.`, executed: false };
    if (programme.status === "CANCELLED" || programme.status === "COMPLETE") {
      return { ok: false, text: `Programme ${programmeKey} is ${programme.status}; its tasks' criteria are closed.`, executed: false };
    }
    const task = await this.deps.store.getBuildTask(buildTaskId);
    if (!task || task.programmeId !== programme.id) {
      return { ok: false, text: `No build task ${buildTaskId} on ${programmeKey}.`, executed: false };
    }
    if (benchArmOf(task)) {
      return {
        ok: false,
        text: `Task ${buildTaskId} is a model-bench arm: its criteria stay as copied so the arms remain directly comparable.`,
        executed: false,
      };
    }
    if (!reason) {
      return { ok: false, text: "Say why these criteria, and where the removed ones belong.", executed: false };
    }
    if (requested.length === 0) {
      return { ok: false, text: "Pass at least one criterion id; a task that owns none has nothing for the gate to prove.", executed: false };
    }
    const malformed = requested.filter((id) => !/^AC-[0-9a-f]{8}$/.test(id));
    if (malformed.length > 0) {
      return { ok: false, text: `Not criterion ids: ${malformed.join(", ")}. Nothing was changed.`, executed: false };
    }
    if (!(RESCOPABLE_STATUSES as readonly string[]).includes(task.status)) {
      return {
        ok: false,
        text: `Task ${buildTaskId} is ${task.status}. Criteria can change only while it is not in flight or finished (PENDING, READY, PR_OPEN, HANDBACK, FAILED) — a running attempt was briefed against the current set.`,
        executed: false,
      };
    }

    const milestone = await this.deps.store.getMilestone(task.milestoneId);
    const specId = milestone?.specId ?? programme.specId;
    const spec = specId ? await this.deps.specs.loadApprovedSpec(specId) : null;
    if (!spec) {
      return { ok: false, text: `Could not load the approved spec for ${buildTaskId}; nothing was changed.`, executed: false };
    }
    const known = new Set(spec.acceptanceCriteria.map((criterion) => criterion.id));
    const unknown = requested.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      return {
        ok: false,
        text: `Not in the task's approved spec (${spec.specId}): ${unknown.join(", ")}. Nothing was changed.`,
        executed: false,
      };
    }

    const before = task.acceptanceCriterionIds;
    const removed = before.filter((id) => !requested.includes(id));
    const added = requested.filter((id) => !before.includes(id));
    // One criterion, one owner: an added id another live task still owns is
    // refused, naming the owner, rather than silently duplicated.
    if (added.length > 0) {
      const siblings = (await this.deps.store.listBuildTasks(programme.id)).filter(
        (other) => other.id !== buildTaskId && other.status !== "CANCELLED" && !benchArmOf(other),
      );
      const clashes = added
        .map((id) => ({ id, owner: siblings.find((other) => other.acceptanceCriterionIds.includes(id)) }))
        .filter((clash): clash is { id: string; owner: BuildTaskRecord } => clash.owner !== undefined);
      if (clashes.length > 0) {
        return {
          ok: false,
          text: `Already owned by another task: ${clashes
            .slice(0, 6)
            .map((clash) => `${clash.id} → \`${clash.owner.id}\` (${clash.owner.status})`)
            .join(", ")}${clashes.length > 6 ? ", …" : ""}. Remove them from that task first with set_task_criteria, so no criterion has two owners. Nothing was changed.`,
          executed: false,
        };
      }
    }
    if (removed.length === 0 && added.length === 0) {
      return { ok: true, text: `Task ${buildTaskId} already owns exactly those ${requested.length} criteria.`, executed: false };
    }

    // Deferred list first, re-read immediately before the write: a crash
    // between the two writes then leaves at worst an extra deferred entry,
    // never a removed id recorded nowhere, and a tick or decision written to
    // programme metadata while the spec loaded is not overwritten.
    const deferred = await this.addDeferredCriteria(programmeKey, removed, added);

    // Re-read right before the write: the advance tick may have dispatched
    // the task, or written runtime metadata (headSha, dispatchedAt, …), while
    // the spec loaded. The status check runs again on the fresh row, and the
    // metadata spread starts from it, so what the tick wrote before this
    // point survives (a metadata-only write in the last instant can still be
    // lost — the status-conditional write below only guards the status).
    // The stale verdict is left in place: gateRefusalLine already hides
    // criteria the task no longer owns, and the next tick rewrites it.
    const current = await this.deps.store.getBuildTask(buildTaskId);
    if (!current || !(RESCOPABLE_STATUSES as readonly string[]).includes(current.status)) {
      return {
        ok: false,
        text: `Task ${buildTaskId} changed to ${current?.status ?? "missing"} while this ran; criteria were not changed (the removed ids were already noted as deferred — harmless, and cleared if you add them back).`,
        executed: false,
      };
    }
    const priorRescopes = ((current.metadata ?? {}) as { criteriaRescopes?: unknown }).criteriaRescopes;
    const entry = { by: actor, reason: reason.slice(0, 500), at: this.now().toISOString(), removed, added };
    const patch = {
      acceptanceCriterionIds: [...requested].sort((a, b) => a.localeCompare(b)),
      metadata: {
        ...(current.metadata ?? {}),
        // Append-only: this lowers what a PR must prove, so who and why stays.
        criteriaRescopes: [...(Array.isArray(priorRescopes) ? priorRescopes : []), entry].slice(-20),
      },
    };
    // Conditional on status in one write where the store supports it, so a
    // dispatch that lands between the re-read and the write cannot be
    // re-scoped underneath its brief. A store without it falls back to the
    // re-read above, which narrows the window but does not close it.
    if (typeof this.deps.store.updateBuildTaskIfStatus === "function") {
      const written = await this.deps.store.updateBuildTaskIfStatus(buildTaskId, [...RESCOPABLE_STATUSES], patch);
      if (!written) {
        return {
          ok: false,
          text: `Task ${buildTaskId} left a re-scopable state while this ran; criteria were not changed (the removed ids were already noted as deferred — harmless, and cleared if you add them back).`,
          executed: false,
        };
      }
    } else {
      this.warn(`set_task_criteria on ${buildTaskId}: store has no updateBuildTaskIfStatus, so the write is not status-guarded.`);
      await this.deps.store.updateBuildTask(buildTaskId, patch);
    }

    // A removed id that no other live task owns has no owner until a later
    // milestone plans it. Said out loud rather than implied by "deferred".
    const others = (await this.deps.store.listBuildTasks(programme.id)).filter(
      (other) => other.id !== buildTaskId && other.status !== "CANCELLED",
    );
    const ownedElsewhere = new Set(others.flatMap((other) => other.acceptanceCriterionIds));
    const unowned = removed.filter((id) => !ownedElsewhere.has(id));

    const summary = `${before.length} → ${requested.length} criteria (${removed.length} deferred, ${added.length} added)`;
    this.log(`Task ${buildTaskId} on ${programmeKey} re-scoped by ${actor}: ${summary}. Reason: ${reason.slice(0, 200)}`);
    await this.postToReviewChannel(
      `Build task \`${buildTaskId}\` on ${programmeKey}: <@${actor}> re-scoped its criteria, ${summary}. Reason: ${withoutSlackMentions(reason.slice(0, 300))}`,
    );
    return {
      ok: true,
      text:
        `Task ${buildTaskId} now owns ${requested.length} criteria (${requested.slice(0, 10).join(", ")}${requested.length > 10 ? ", …" : ""}); ${removed.length} removed and recorded on the programme as deferred (${deferred.length} deferred in total).` +
        (unowned.length > 0
          ? ` ${unowned.length} of them are now owned by no task (${unowned.slice(0, 6).join(", ")}${unowned.length > 6 ? ", …" : ""}) until a later milestone plans them.`
          : "") +
        (task.status === "PR_OPEN" ? " Its PR is re-judged against the new set on the next advance tick, with no rebuild." : ""),
      executed: true,
    };
  }


  protected async retryBuildTask(args: Record<string, unknown>, actor: string): Promise<ProgrammeToolResult> {
    const programmeKey = typeof args.programmeKey === "string" ? args.programmeKey : "";
    const buildTaskId = typeof args.buildTaskId === "string" ? args.buildTaskId : "";
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    const programme = await this.deps.store.getProgramme(programmeKey);
    if (!programme) return { ok: false, text: `No programme named ${programmeKey}.`, executed: false };
    const task = await this.deps.store.getBuildTask(buildTaskId);
    if (!task || task.programmeId !== programme.id) {
      return { ok: false, text: `No build task ${buildTaskId} on ${programmeKey}.`, executed: false };
    }
    // PR_OPEN is re-workable too: a task whose PR is open but refused (a
    // review's findings, a wrong title, checks the gate will not pass) goes
    // back through HANDBACK exactly as the conflict and failed-checks re-arms
    // do, and the next dispatch resumes its branch and updates the same PR.
    if (task.status !== "HANDBACK" && task.status !== "FAILED" && task.status !== "PR_OPEN") {
      return { ok: false, text: `Task ${buildTaskId} is ${task.status}, not HANDBACK/FAILED/PR_OPEN.`, executed: false };
    }
    if (!reason) {
      return { ok: false, text: "Say why the task is being retried — the reason is what the next attempt is told to fix.", executed: false };
    }

    // Extra attempts: a human-requested allowance on THIS task only, when the
    // cap was spent on something that was not the task's fault (e.g. every
    // attempt judged by a check the runner hardcoded wrong). Bounded twice:
    // per call, and in total at the policy cap itself, so a task can never run
    // more than twice the configured budget.
    const policyCap = this.deps.policy.dispatch.maxTaskAttempts;
    const currentExtra = extraAttemptsOf(task);
    const requestedExtra = args.extraAttempts === undefined ? 0 : Number(args.extraAttempts);
    if (!Number.isInteger(requestedExtra) || requestedExtra < 0 || requestedExtra > MAX_EXTRA_ATTEMPTS_PER_GRANT) {
      return {
        ok: false,
        text: `extraAttempts must be a whole number from 0 to ${MAX_EXTRA_ATTEMPTS_PER_GRANT}.`,
        executed: false,
      };
    }
    if (requestedExtra > 0) {
      // A separate, higher rung than the retry: checked against the Slack
      // requester, so the model passing extraAttempts is not enough.
      const repoResource = this.repoResource(programme.targetRepoKey);
      const grant = this.deps.authz.evaluate({
        actorId: actor,
        action: PROGRAMME_PERMISSIONS.TASK_EXTEND_ATTEMPTS,
        ...(repoResource ? { resource: repoResource } : {}),
      });
      if (!grant.allowed) {
        return {
          ok: false,
          text: `Granting extra attempts needs ${PROGRAMME_PERMISSIONS.TASK_EXTEND_ATTEMPTS} (team lead): ${grant.reason}. Nothing was changed; a retry without extraAttempts is still available below the cap.`,
          executed: false,
        };
      }
      if (task.attempts < policyCap + currentExtra) {
        return {
          ok: false,
          text: `Task ${buildTaskId} has ${policyCap + currentExtra - task.attempts} attempt(s) left (${task.attempts}/${policyCap + currentExtra}); extra attempts are granted only at the cap. Retry without extraAttempts.`,
          executed: false,
        };
      }
    }
    if (currentExtra + requestedExtra > policyCap) {
      return {
        ok: false,
        text: `Task ${buildTaskId} already has ${currentExtra} extra attempt(s); granting ${requestedExtra} more would exceed ${policyCap} extra (the policy cap), so a person raises maxTaskAttempts or re-plans instead.`,
        executed: false,
      };
    }
    const extraAttempts = currentExtra + requestedExtra;
    const cap = policyCap + extraAttempts;
    if (task.attempts >= cap) {
      return {
        ok: false,
        text: `Task ${buildTaskId} has used ${task.attempts}/${cap} attempts — the cap refuses another retry. Pass extraAttempts (up to ${MAX_EXTRA_ATTEMPTS_PER_GRANT}) with a reason if the attempts were spent on something that was not the task's fault.`,
        executed: false,
      };
    }

    // `retryNote` is its own key, tied to the ONE attempt it was written for:
    // the brief shows it only on that attempt, so a later automatic re-arm
    // (failed checks, conflict) never replays a stale note, and bench
    // auto-retries (which write `lastRetryReason`) never produce one.
    const metadata = {
      ...(task.metadata ?? {}),
      lastRetryReason: `${reason.slice(0, MAX_RETRY_REASON_CHARS)} (by ${actor})`,
      retryNote: { text: reason.slice(0, MAX_RETRY_REASON_CHARS), by: actor, forAttempt: task.attempts + 1 },
      ...(extraAttempts > 0 ? { extraAttempts } : {}),
    };
    if (task.status === "PR_OPEN") {
      taskMachine.assertTransition("PR_OPEN", "HANDBACK");
      await this.deps.store.updateBuildTask(buildTaskId, { status: "HANDBACK", metadata });
    }
    taskMachine.assertTransition("HANDBACK", "READY");
    await this.deps.store.updateBuildTask(buildTaskId, { status: "READY", metadata });
    this.log(
      `Task ${buildTaskId} re-armed from ${task.status} by ${actor} (attempt ${task.attempts + 1}/${cap}${requestedExtra > 0 ? `, +${requestedExtra} extra granted` : ""}).`,
    );
    if (requestedExtra > 0) {
      await this.postToReviewChannel(
        `Build task \`${buildTaskId}\` on ${programmeKey}: <@${actor}> granted ${requestedExtra} extra attempt(s) past the policy cap (now ${cap}; ${extraAttempts} extra in total). Reason: ${withoutSlackMentions(reason.slice(0, 300))}`,
      );
    }
    return {
      ok: true,
      text: `Task ${buildTaskId} re-armed from ${task.status} (attempt ${task.attempts + 1}/${cap}${requestedExtra > 0 ? `; ${requestedExtra} extra attempt(s) granted` : ""}). The next dispatch resumes its branch${task.prNumber ? ` and updates PR #${task.prNumber}` : ""}, and its brief carries your reason as what to fix.`,
      executed: true,
    };
  }


  /**
   * Model bench: one arm per named model, each a copy of one planned screen
   * task pinned to its model (`planModelBench`). The arms dispatch on their own
   * budget in `dispatchBenchArms`, go through the same evidence gate as every
   * task, and are scored by the rebuild bench from their attempt rows. They
   * never merge and never count toward the programme's gates.
   */
  protected async startModelBench(args: Record<string, unknown>, actor: string): Promise<ProgrammeToolResult> {
    const programmeKey = typeof args.programmeKey === "string" ? args.programmeKey : "";
    const screen = typeof args.screen === "string" ? args.screen.trim() : "";
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    const models = Array.isArray(args.models)
      ? args.models.filter((model): model is string => typeof model === "string")
      : [];
    const programme = await this.deps.store.getProgramme(programmeKey);
    if (!programme) return { ok: false, text: `No programme named ${programmeKey}.`, executed: false };
    if (!BENCH_HOST_STATUSES.includes(programme.status)) {
      return {
        ok: false,
        text: `Programme ${programmeKey} is ${programme.status}; a bench run needs a programme that has planned the screen to bench.`,
        executed: false,
      };
    }
    if (!screen) return { ok: false, text: "Name the screen to bench, e.g. '(auth)/login'.", executed: false };

    const all = await this.deps.store.listBuildTasks(programme.id);
    const screens = withoutBenchTasks(all).filter(
      (task) => (((task.metadata ?? {}) as { kind?: string }).kind ?? "") === "screen",
    );
    const source = resolveBenchSource(screens, screen);
    if (!source.task) return { ok: false, text: source.refusal, executed: false };

    const runId = this.now().toISOString().replace(/\D/g, "").slice(2, 12);
    const effort = typeof args.effort === "string" && args.effort.trim() ? args.effort.trim() : undefined;
    const baseRef = typeof args.baseRef === "string" && args.baseRef.trim() ? args.baseRef.trim() : undefined;
    const standalone = programme.status === "COMPLETE" || programme.status === "CANCELLED";
    const plan = planModelBench({
      source: source.task,
      models,
      runId,
      startedBy: actor,
      now: this.now(),
      effort,
      baseRef,
      standalone,
    });
    if (!plan.ok) return { ok: false, text: plan.reason, executed: false };
    const existing = new Set(all.map((task) => task.id));
    const clash = plan.arms.find((arm) => existing.has(arm.id));
    if (clash) {
      return { ok: false, text: `Bench arm ${clash.id} already exists; start the run again in a minute.`, executed: false };
    }
    await this.deps.store.upsertBuildTasks(
      plan.arms.map((arm) => ({ ...arm, metadata: { ...arm.metadata, benchReason: `${reason || "no reason given"} (by ${actor})` } })),
    );

    const armModels = plan.arms.map((arm) => String((arm.metadata.bench as { model: string }).model));
    const unpriced = armModels.filter((model) => !(this.deps.pricing ?? {})[model]);
    const blocked = source.task.dependsOn.filter((dependencyId) => {
      const dependency = all.find((task) => task.id === dependencyId);
      return !dependency || !["MERGED", "VERIFIED", "CANCELLED"].includes(dependency.status);
    });
    const lines = [
      `Model bench \`${plan.runId}\` on ${programme.key}: ${plan.arms.length} arms of \`${source.task.id}\` — ${armModels.join(", ")}${effort ? `, every arm at ${effort} effort` : ""}${baseRef ? `, built from \`${baseRef}\`` : ""}.`,
      `Each arm is pinned to its model (retries re-run it, up to ${this.deps.policy.dispatch.maxTaskAttempts} attempts), dispatches on its own budget of ${this.deps.policy.dispatch.maxConcurrentBenchTasksPerProgramme} in flight, and opens a PR that is scored and never merged.`,
      blocked.length > 0
        ? `Waiting on ${blocked.join(", ")} to merge first — every arm builds on the same shared infrastructure.`
        : programme.status === "PAUSED"
          ? "The programme is PAUSED; arms dispatch once it is resumed."
          : programme.status === "COMPLETE" || programme.status === "CANCELLED"
            ? `Dispatching on the next advance tick. ${programme.key} is ${programme.status}, so the bench runs on its own: it takes no live-programme slot and nothing of the programme restarts.`
            : "Dispatching on the next advance tick.",
      unpriced.length > 0
        ? `No price configured for ${unpriced.join(", ")}: their tokens are recorded and the cost shows as unknown until a price row is added (priced on read, no backfill).`
        : "",
      `Score it with \`/lexi diag rebuild-bench ${programme.key}\`.`,
    ].filter(Boolean);
    this.log(`Model bench ${plan.runId} planned on ${programme.key}: ${plan.arms.map((arm) => arm.id).join(", ")}`);
    return { ok: true, text: lines.join("\n"), executed: true };
  }


  /**
   * Dispatches ready bench arms up to `maxConcurrentBenchTasksPerProgramme`,
   * counted apart from the programme's own in-flight tasks. A scored arm
   * (PR_OPEN) no longer holds a slot.
   *
   * Arms that came back HANDBACK or FAILED are re-armed here, on the same
   * pinned model, until the attempt cap: a bench run is only a comparison if
   * every model gets the same number of tries without a human choosing which
   * ones to retry.
   */
  /**
   * Fold and dispatch bench arms only, for a programme parked in review. The
   * programme's own tasks are left exactly as the review left them.
   */
  protected async advanceBenchArms(programme: ProgrammeRecord, onlyStandalone = false): Promise<number> {
    const repo = this.deps.registry.resolveRepo(programme.targetRepoKey);
    if (!repo) return 0;
    const inScope = (task: BuildTaskRecord) => isBenchTask(task) && (!onlyStandalone || benchArmOf(task)?.standalone === true);
    const arms = (await this.deps.store.listBuildTasks(programme.id)).filter(inScope);
    if (arms.length === 0) return 0;
    for (const arm of arms) {
      if (!arm.currentAttemptId) continue;
      if (!["DISPATCHED", "EVIDENCE_RED", "EVIDENCE_GREEN"].includes(arm.status)) continue;
      await this.foldTask(programme, repo.organization, repo.repository, arm);
    }
    const settings = repoSettingsFor(this.deps.policy, programme.targetRepoKey);
    const baseRef = programmeMetadata(programme).baseBranch ?? settings.baseBranch ?? repo.defaultBranch ?? "main";
    return this.dispatchBenchArms(programme, repo, baseRef, inScope);
  }


  protected async dispatchBenchArms(
    programme: ProgrammeRecord,
    repo: RepoDescriptor,
    baseRef: string,
    inScope: (task: BuildTaskRecord) => boolean = isBenchTask,
  ): Promise<number> {
    if (!this.deps.flags.dispatchEnabled) return 0;
    const all = await this.deps.store.listBuildTasks(programme.id);
    const arms = all.filter(inScope);
    if (arms.length === 0) return 0;

    for (const arm of arms) {
      if (arm.status !== "HANDBACK" && arm.status !== "FAILED") continue;
      if (arm.attempts >= this.deps.policy.dispatch.maxTaskAttempts) continue;
      taskMachine.assertTransition(arm.status, "READY");
      await this.deps.store.updateBuildTask(arm.id, {
        status: "READY",
        metadata: { ...(arm.metadata ?? {}), lastRetryReason: `bench auto-retry on ${benchArmOf(arm)!.model}` },
      });
      arm.status = "READY";
    }

    const inflight = arms.filter((task) =>
      ["DISPATCHED", "EVIDENCE_RED", "EVIDENCE_GREEN"].includes(task.status),
    ).length;
    const budget = Math.max(0, this.deps.policy.dispatch.maxConcurrentBenchTasksPerProgramme - inflight);
    const armIds = new Set(arms.map((task) => task.id));
    const ready = readyTasks(all.map((task) => ({ id: task.id, dependsOn: task.dependsOn, status: task.status })))
      .filter((node) => armIds.has(node.id))
      .slice(0, budget);
    let dispatched = 0;
    for (const node of ready) {
      const arm = arms.find((candidate) => candidate.id === node.id);
      if (!arm) continue;
      const ref = benchArmOf(arm)?.baseRef ?? baseRef;
      if (await this.dispatchTask(programme, repo, ref, arm)) dispatched += 1;
    }
    return dispatched;
  }


  /**
   * Retire build tasks that should never run, or restore ones already retired.
   *
   * The case this exists for: a repo that already carries a finished
   * programme's work gets a second programme, and the planner re-derives the
   * shared infra — scaffold, design bindings, data layer — that the first one
   * landed. Those tasks would rebuild files that already exist on the branch
   * and collide with them. Before this tool the only levers were a re-plan
   * (which regenerates the same rows) or letting them run, because
   * `propose_milestone_plan` cannot address programme-level tasks at all and
   * nothing else removed a task from a graph.
   *
   * Per-task outcomes are reported individually and a refusal never aborts the
   * batch: naming 76 ids and being told only that one of them was DISPATCHED
   * would make the tool unusable for the situation it was built for.
   */
  protected async cancelBuildTasks(
    args: Record<string, unknown>,
    actor: string,
  ): Promise<ProgrammeToolResult> {
    const programmeKey = typeof args.programmeKey === "string" ? args.programmeKey : "";
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    const restore = args.restore === true;
    const ids = Array.isArray(args.buildTaskIds)
      ? args.buildTaskIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : [];

    if (ids.length === 0) {
      return { ok: false, text: "buildTaskIds is empty — name the tasks explicitly.", executed: false };
    }
    if (ids.length > MAX_TASKS_PER_CANCEL) {
      return {
        ok: false,
        text: `${ids.length} ids exceeds the ${MAX_TASKS_PER_CANCEL} per call cap. Split the batch.`,
        executed: false,
      };
    }
    if (!reason) {
      return { ok: false, text: "A reason is required — it is recorded on every row.", executed: false };
    }

    const programme = await this.deps.store.getProgramme(programmeKey);
    if (!programme) return { ok: false, text: `No programme named ${programmeKey}.`, executed: false };

    const target: BuildTaskStatusLike = restore ? "PENDING" : "CANCELLED";
    const changed: string[] = [];
    const refused: string[] = [];

    for (const id of new Set(ids)) {
      const task = await this.deps.store.getBuildTask(id);
      if (!task || task.programmeId !== programme.id) {
        refused.push(`${id}: not a task on ${programmeKey}`);
        continue;
      }
      if (task.status === target) {
        refused.push(`${id}: already ${target}`);
        continue;
      }
      if (!taskMachine.canTransition(task.status, target)) {
        refused.push(`${id}: ${task.status} cannot become ${target}`);
        continue;
      }
      taskMachine.assertTransition(task.status, target);
      await this.deps.store.updateBuildTask(id, {
        status: target,
        metadata: {
          ...(task.metadata ?? {}),
          ...(restore
            ? { restoredReason: `${reason} (by ${actor})` }
            : { cancelledReason: `${reason} (by ${actor})` }),
        },
      });
      changed.push(id);
    }

    const verb = restore ? "restored" : "retired";
    if (changed.length > 0) {
      await this.postToReviewChannel(
        `${changed.length} build task(s) ${verb} on \`${programmeKey}\` by <@${actor}>: ${reason}` +
          (restore
            ? ""
            : " — retired tasks never dispatch, and count as satisfied for anything that depended on them."),
      );
      await this.remember(
        programme,
        "decision",
        `${changed.length} build task(s) ${verb} on ${programmeKey}: ${reason}. Tasks: ${changed.join(", ")}.`,
        { actor, tasks: changed, restore },
        0.7,
      );
      await this.syncTrackingIssue(programme);
    }

    const lines = [`${changed.length} task(s) ${verb}${changed.length > 0 ? `: ${changed.join(", ")}` : "."}`];
    if (refused.length > 0) lines.push(`${refused.length} refused — ${refused.join("; ")}`);
    return { ok: changed.length > 0, text: lines.join("\n"), executed: changed.length > 0 };
  }
}
