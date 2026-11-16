import type { RepoDescriptor } from "@lexi/contracts";
import {
  applyCriterionMapping,
  deferredCriteria,
  parseCriteriaByScreen,
  sharedInfraTaskId,
  type PlannedTask,
} from "../milestone-plan";
import { hardeningConcludeBlocks } from "../milestone-review-blocks";
import { repoSettingsFor } from "../load-programme-policy";
import { readyTasks } from "../task-graph";
import { benchArmOf, isBenchTask, withoutBenchTasks } from "../model-bench-plan";
import type { BuildTaskRecord, ProgrammeRecord } from "../programme-store";
import type { ProgrammeBuildDeps, ProgrammeBuildResult, RunEvidenceListRow } from "./ports";
import {
  isCriteriaRescoped,
  OPEN_BENCH_ARM_STATUSES,
  programmeMachine,
  milestoneMachine,
  taskMachine,
  specPathOf,
  isTechnicalSpecTask,
  programmeMetadata,
  sha256,
  attemptSpendFromEvidence,
  type ProgrammeMetadata,
} from "./helpers";
import { ProgrammeReview } from "./programme-review";

/**
 * The rebuild programme engine: all the I/O the pure domain in this package
 * refuses to do — dispatch, evidence folding, PR reconciliation, the
 * auto-merge executor, milestone reviews, the hardening gate and the digest.
 *
 * Two invariants it exists to protect:
 *
 *   1. **The model never merges.** `invokeTool` handles the planning tools;
 *      `tryAutoMerge` is reachable ONLY from `advance()`, the scheduler
 *      entrypoint, behind ordered fail-closed gates.
 *   2. **Every status write is machine-checked.** No transition is persisted
 *      without `assertTransition` on the corresponding pure machine — a
 *      malformed fold is a thrown `Invalid*TransitionError`, never a quietly
 *      corrupted row.
 *
 * This class holds the scheduler tick (`advance`), dispatch and attempt
 * accounting; the other responsibilities live in the layers it extends.
 */
export class ProgrammeBuildService extends ProgrammeReview {

  /* ------------------------------------------------------------ advance */

  /**
   * The scheduler entrypoint. Fully idempotent: every step re-derives its
   * facts from the store and the evidence rows, so a re-run after a crash
   * folds the same reality to the same states.
   */
  async advance(): Promise<{ programmes: number; dispatched: number; merged: number }> {
    const summary = { programmes: 0, dispatched: 0, merged: 0 };
    if (!this.deps.flags.programmeEnabled || !this.deps.policy.enabled) return summary;

    const building = await this.deps.store.listProgrammesByStatus(["BUILDING", "PLANNED"]);
    for (const programme of building) {
      summary.programmes += 1;
      try {
        const result = await this.advanceProgramme(programme);
        summary.dispatched += result.dispatched;
        summary.merged += result.merged;
      } catch (error) {
        this.warn(
          `advance(${programme.key}) failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }

    // Paused programmes still FOLD, they just do not dispatch or merge.
    //
    // pause_programme's own promise is that "in-flight workflow runs are not
    // cancelled" — which is worthless if their results are never read. They
    // were not: the tick above walks BUILDING and PLANNED only, so pausing
    // would freeze in-flight tasks in DISPATCHED for good: a task that handed
    // back just before its programme was paused would sit DISPATCHED,
    // retry_build_task refuses anything that is not HANDBACK or FAILED, and
    // the attempt could not even be accounted for.
    //
    // Folding is read-then-record: it reads evidence and run results and moves
    // task states. It never dispatches, so a paused programme stays stopped in
    // the sense that matters while still learning what already happened.
    const paused = await this.deps.store.listProgrammesByStatus(["PAUSED"]);
    for (const programme of paused) {
      try {
        await this.foldProgrammeResults(programme);
      } catch (error) {
        this.warn(
          `fold(${programme.key}, paused) failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }

    // A milestone parked IN_REVIEW whose card never posted is un-approvable.
    // `approve_milestone` is human-only — Block Kit clicks are its only route,
    // the card is the only place those buttons exist, and it is posted once,
    // on the EVIDENCE_COMPLETE -> IN_REVIEW edge, which has already been
    // taken. A null reviewThreadTs on an IN_REVIEW milestone says exactly that.
    //
    // This runs HERE rather than inside advanceProgramme because a programme
    // parked for review is MILESTONE_REVIEW, and the pass above walks only
    // BUILDING and PLANNED — a repair living there could never reach the state
    // it exists to repair. A card Slack rejects (for example `invalid_blocks`)
    // would otherwise leave a parked programme with no card at all, and
    // nothing in the tool set can produce another one.
    const reviewing = await this.deps.store.listProgrammesByStatus(["MILESTONE_REVIEW"]);
    for (const programme of reviewing) {
      // Bench arms take no part in the review, so a programme parked for one
      // must not strand them. The case is the normal one, not a corner: a
      // bench on a programme whose own tasks are all retired parks for its
      // final review on the same tick that dispatches the arms, and nothing
      // else would ever fold or re-arm them.
      try {
        summary.dispatched += await this.advanceBenchArms(programme);
      } catch (error) {
        this.warn(
          `bench advance(${programme.key}, in review) failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
      try {
        await this.repostMissingMilestoneCards(programme);
      } catch (error) {
        this.warn(
          `milestone-card repair(${programme.key}) failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }

    // Benches on finished or cancelled programmes. Nothing else of such a
    // programme runs; only its bench arms fold, re-arm and dispatch, and only
    // while one is still open.
    const settled = await this.deps.store.listProgrammesByStatus(["COMPLETE", "CANCELLED"]);
    for (const programme of settled) {
      try {
        const tasks = await this.deps.store.listBuildTasks(programme.id);
        const open = tasks.some(
          (task) =>
            benchArmOf(task)?.standalone === true &&
            OPEN_BENCH_ARM_STATUSES.has(task.status) &&
            !(["HANDBACK", "FAILED"].includes(task.status) && task.attempts >= this.deps.policy.dispatch.maxTaskAttempts),
        );
        if (open) summary.dispatched += await this.advanceBenchArms(programme, true);
      } catch (error) {
        this.warn(
          `bench advance(${programme.key}, ${programme.status}) failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }

    const hunting = await this.deps.store.listProgrammesByStatus(["HARDENING"]);
    for (const programme of hunting) {
      summary.programmes += 1;
      try {
        await this.advanceHardening(programme);
      } catch (error) {
        this.warn(
          `hardening advance(${programme.key}) failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
    return summary;
  }


  /**
   * Read-only-then-record half of the tick: fold evidence and run results into
   * task states. Separated from `advanceProgramme` so a PAUSED programme can
   * run this without the dispatch and merge that follow it.
   */
  protected async foldProgrammeResults(programme: ProgrammeRecord): Promise<void> {
    const repo = this.deps.registry.resolveRepo(programme.targetRepoKey);
    if (!repo) return;
    const tasks = await this.deps.store.listBuildTasks(programme.id);
    for (const task of tasks) {
      if (!task.currentAttemptId) continue;
      if (!["DISPATCHED", "EVIDENCE_RED", "EVIDENCE_GREEN", "PR_OPEN"].includes(task.status)) continue;
      // A bench arm is scored the moment its PR opens (outcome `shipped`);
      // there is nothing left to fold, and re-reading its run every tick only
      // spends API calls. A human merging one is still seen by
      // foldExternalMerges.
      if (task.status === "PR_OPEN" && isBenchTask(task)) continue;
      await this.foldTask(programme, repo.organization, repo.repository, task);
    }
  }


  /**
   * Wraps the tick's per-programme work so the tracking issue is synced on
   * EVERY exit. It used to be synced only on the final return, and three of
   * the four earlier returns are the normal, successful ends of a programme —
   * parked for milestone review, parked for final review, entered hardening pass.
   * So the checklist a human reads was guaranteed to be stale exactly when
   * the programme finished well: the tick that merges the last task is the
   * same tick that parks the programme for review, and it would return before
   * the sync with that task still shown as dispatched.
   *
   * syncTrackingIssue re-reads the programme and its rows itself and owns its
   * error handling, so the stale local `programme` here is only a key and the
   * finally cannot mask a real failure.
   */
  protected async advanceProgramme(
    programme: ProgrammeRecord,
  ): Promise<{ dispatched: number; merged: number }> {
    try {
      return await this.advanceProgrammeSteps(programme);
    } finally {
      await this.syncTrackingIssue(programme);
    }
  }


  protected async advanceProgrammeSteps(
    programme: ProgrammeRecord,
  ): Promise<{ dispatched: number; merged: number }> {
    const repo = this.deps.registry.resolveRepo(programme.targetRepoKey);
    if (!repo) {
      this.warn(`Programme ${programme.key} targets unregistered repo ${programme.targetRepoKey} — skipping`);
      return { dispatched: 0, merged: 0 };
    }

    let merged = 0;
    const settings = repoSettingsFor(this.deps.policy, programme.targetRepoKey);
    const baseRef = programmeMetadata(programme).baseBranch ?? settings.baseBranch ?? repo.defaultBranch ?? "main";

    // 1. Fold evidence + results into task states.
    await this.foldProgrammeResults(programme);

    // 1b. PRs a HUMAN merged (the technical spec, or any task a person landed
    // by hand) — the executor is not the only way a PR closes, and a task
    // whose PR is merged but whose row still says PR_OPEN blocks everything
    // that depends on it forever.
    const afterFold = await this.deps.store.listBuildTasks(programme.id);
    merged += await this.foldExternalMerges(programme, repo, afterFold);

    // 1c. The technical spec merged → re-assign criteria to screens from its
    // table, before any screen dispatches against the round-robin spread.
    if (settings.requireTechnicalSpec) {
      await this.applyTechnicalSpecMapping(programme, repo, baseRef);
    }

    // 1d. A queued milestone whose predecessors have all built gets planned
    // (repoSettings autoPlanQueuedMilestones). Before dispatch, so its first
    // task can go out on this same tick.
    await this.planQueuedMilestone(programme);

    // 2. Auto-merge pass over PR_OPEN tasks (re-listed: folding moved states).
    const afterExternal = await this.deps.store.listBuildTasks(programme.id);
    for (const task of afterExternal) {
      if (task.status !== "PR_OPEN" || !task.prNumber) continue;
      // The programme's technical spec is approved by a PERSON merging its PR
      // — the executor never touches it, and a gate verdict on a document with
      // no evidence would only be a refusal posted every tick. A later
      // milestone's spec merges itself where the repo opts in.
      if ((((task.metadata ?? {}) as { kind?: string }).kind ?? "") === "technical-spec") {
        if (
          settings.autoMergeMilestoneTechnicalSpecs &&
          task.id !== sharedInfraTaskId(programme.key, "technical-spec") &&
          (await this.tryAutoMergeMilestoneSpec(programme, repo, task))
        ) {
          merged += 1;
        }
        continue;
      }
      // A bench arm is one of N implementations of the same screen, built to
      // be compared, not landed. Skipping it here also skips the conflict and
      // failed-check re-arms, which would otherwise rebuild a scored arm
      // every time a sibling merge moved the base.
      if (isBenchTask(task)) continue;
      const didMerge = await this.tryAutoMerge(programme, repo.organization, repo.repository, task);
      if (didMerge) merged += 1;
    }

    // 2b. Model-bench arms dispatch on their own budget, BEFORE the milestone
    // steps below: those can park the programme and return, and a bench run
    // must not wait behind a review it takes no part in.
    let dispatched = await this.dispatchBenchArms(programme, repo, baseRef);

    // 3. Milestone completion → exploratory sweep → review card.
    //
    // `gate` mode (the original): the card is a gate and the programme parks
    // in MILESTONE_REVIEW until a human clicks. `notify` mode (autopilot):
    // the card is a notification, the programme keeps BUILDING, and ONE
    // final review parks it once every milestone is in review (3a).
    const notifyMode = this.deps.policy.milestoneReview.mode === "notify";
    // Every gate below is about the programme's own work; bench arms never
    // merge, so counting them would hold every milestone open for ever.
    const current = withoutBenchTasks(await this.deps.store.listBuildTasks(programme.id));
    const milestones = (await this.deps.store.listMilestones(programme.id)).filter(
      // ordinal 0 is bookkeeping (hardening conclusion), never a deliverable.
      (milestone) => milestone.ordinal > 0,
    );
    for (const milestone of milestones) {
      if (milestone.status !== "IN_PROGRESS" && milestone.status !== "READY") continue;
      const own = current.filter((task) => task.milestoneId === milestone.id);
      if (own.length === 0) continue;
      // A retired task counts as done here. Without this one cancelled row
      // keeps its milestone IN_PROGRESS for ever.
      const allDone = own.every(
        (task) => task.status === "MERGED" || task.status === "VERIFIED" || task.status === "CANCELLED",
      );
      if (!allDone) continue;
      if (milestone.status === "READY") {
        // Tasks completed without the milestone ever recording IN_PROGRESS
        // (e.g. re-run after a crash between writes) — walk both edges.
        milestoneMachine.assertTransition("READY", "IN_PROGRESS");
        await this.deps.store.updateMilestone(milestone.id, { status: "IN_PROGRESS" });
        milestone.status = "IN_PROGRESS";
      }

      // The sweep gate: a milestone is complete only once programme-explore.yml
      // has driven the preview at the milestone's head SHA and found nothing.
      // Per repo: a repo with no preview yet completes on
      // merged tasks alone and the owner verifies the working branch locally.
      if (settings.requireExploratorySweep) {
        const headSha = this.milestoneHead(own);
        const sweep = await this.sweepVerdict(milestone, headSha);
        if (sweep === "pending") continue;
        if (sweep === "absent") {
          await this.dispatchSweep(programme, repo, baseRef, milestone, headSha);
          continue;
        }
        if (sweep === "failed") {
          // Findings exist. They are filed as issues by the sweep; the
          // milestone stays IN_PROGRESS and is re-swept only when its head
          // moves (a fix merges), so this does not loop on the same SHA.
          continue;
        }
      }

      milestoneMachine.assertTransition("IN_PROGRESS", "EVIDENCE_COMPLETE");
      await this.deps.store.updateMilestone(milestone.id, { status: "EVIDENCE_COMPLETE" });
      await this.postMilestoneReview(programme, milestone, own);
      // A PLANNED programme whose tasks all merged (humans merging in phase 3
      // faster than the tick that would have recorded BUILDING) walks both
      // legal edges rather than asserting an edge the machine refuses.
      if (programme.status === "PLANNED") {
        programmeMachine.assertTransition("PLANNED", "BUILDING");
        await this.deps.store.updateProgramme(programme.key, { status: "BUILDING" });
        programme = { ...programme, status: "BUILDING" };
      }
      if (notifyMode) {
        this.log(`Milestone ${milestone.id} in review (notification only — autopilot keeps building)`);
        continue;
      }
      programmeMachine.assertTransition(programme.status, "MILESTONE_REVIEW");
      await this.deps.store.updateProgramme(programme.key, { status: "MILESTONE_REVIEW" });
      this.log(`Programme ${programme.key} parked for review of ${milestone.id}`);
      return { dispatched, merged };
    }

    // 3a. Autopilot's ONE human gate: every milestone is IN_REVIEW or
    // APPROVED and every task merged → park for the final review. The
    // milestone-review service approves every pending milestone on that one
    // click (notify mode), after which 3b takes the programme to HARDENING.
    const refreshed = await this.deps.store.listMilestones(programme.id);
    const deliverables = refreshed.filter((milestone) => milestone.ordinal > 0);
    if (
      notifyMode &&
      deliverables.length > 0 &&
      deliverables.every((milestone) => milestone.status === "IN_REVIEW" || milestone.status === "APPROVED") &&
      deliverables.some((milestone) => milestone.status === "IN_REVIEW") &&
      current.length > 0 &&
      current.every(
        (task) => task.status === "MERGED" || task.status === "VERIFIED" || task.status === "CANCELLED",
      ) &&
      programme.status !== "MILESTONE_REVIEW"
    ) {
      if (programme.status === "PLANNED") {
        programmeMachine.assertTransition("PLANNED", "BUILDING");
        await this.deps.store.updateProgramme(programme.key, { status: "BUILDING" });
        programme = { ...programme, status: "BUILDING" };
      }
      programmeMachine.assertTransition(programme.status, "MILESTONE_REVIEW");
      await this.deps.store.updateProgramme(programme.key, { status: "MILESTONE_REVIEW" });
      const pending = deliverables.filter((milestone) => milestone.status === "IN_REVIEW");
      const usage = await this.usageSummaryLine(programme.id);
      await this.postToReviewChannel(
        [
          `*Final review — ${programme.title}* (\`${programme.key}\`)`,
          `Every milestone is built, merged and swept clean (${deliverables.length} milestones, ${current.length} tasks). Approve ANY of the ${pending.length} pending milestone cards above to approve them all and start the hardening pass; request changes on one to send it back.`,
          `Pending: ${pending.map((milestone) => `\`${milestone.id}\``).join(", ")}.`,
          usage,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      this.log(`Programme ${programme.key} parked for its final review (${pending.length} milestones pending)`);
      return { dispatched, merged };
    }

    // 3b. Every milestone approved and every task merged → hardening pass.
    if (
      deliverables.length > 0 &&
      deliverables.every((milestone) => milestone.status === "APPROVED") &&
      current.length > 0 &&
      current.every(
        (task) => task.status === "MERGED" || task.status === "VERIFIED" || task.status === "CANCELLED",
      )
    ) {
      if (programme.status === "PLANNED") {
        programmeMachine.assertTransition("PLANNED", "BUILDING");
        await this.deps.store.updateProgramme(programme.key, { status: "BUILDING" });
        programme = { ...programme, status: "BUILDING" };
      }
      programmeMachine.assertTransition(programme.status, "HARDENING");
      await this.deps.store.updateProgramme(programme.key, { status: "HARDENING" });
      const findingsLabel = `${this.deps.policy.hardening.labelPrefix}${programme.key}`;
      const findingsWhere = [repo?.slug, this.deps.findingsRepoSlug].filter((slug): slug is string => Boolean(slug)).join(" and ");
      await this.postBlocksToReviewChannel(
        `Programme ${programme.key} entered HARDENING (findings label ${findingsLabel}${findingsWhere ? ` on ${findingsWhere}` : ""}).`,
        hardeningConcludeBlocks({
          programmeKey: programme.key,
          programmeTitle: programme.title,
          findingsLabel,
          openFindings: 0,
        }),
      );
      return { dispatched, merged };
    }

    // 4. Dispatch ready tasks up to the concurrency budget.
    if (this.deps.flags.dispatchEnabled) {
      const nodes = current.map((task) => ({
        id: task.id,
        dependsOn: task.dependsOn,
        status: task.status,
      }));
      const inflight = current.filter((task) =>
        ["DISPATCHED", "EVIDENCE_RED", "EVIDENCE_GREEN", "PR_OPEN"].includes(task.status),
      ).length;
      const budget = Math.max(0, this.deps.policy.dispatch.maxConcurrentTasksPerProgramme - inflight);
      const ready = readyTasks(nodes).slice(0, budget);
      for (const node of ready) {
        const task = current.find((candidate) => candidate.id === node.id);
        if (!task) continue;
        const ok = await this.dispatchTask(programme, repo, baseRef, task);
        if (ok) dispatched += 1;
      }
      if (dispatched > 0 && programme.status === "PLANNED") {
        programmeMachine.assertTransition("PLANNED", "BUILDING");
        await this.deps.store.updateProgramme(programme.key, { status: "BUILDING" });
        for (const milestone of milestones) {
          if (milestone.status === "READY") {
            milestoneMachine.assertTransition("READY", "IN_PROGRESS");
            await this.deps.store.updateMilestone(milestone.id, { status: "IN_PROGRESS" });
          }
        }
      }
    }

    return { dispatched, merged };
  }


  /**
   * Marks PR_OPEN tasks whose PR GitHub reports as merged — by a person, not
   * the executor — as MERGED, and remembers the outcome. The technical-spec
   * task ALWAYS lands this way: the runner posts no evidence for it, so the
   * auto-merge gate can never pass, which is the design.
   */
  protected async foldExternalMerges(
    programme: ProgrammeRecord,
    repo: RepoDescriptor,
    tasks: BuildTaskRecord[],
  ): Promise<number> {
    let merged = 0;
    for (const task of tasks) {
      // Any state that can still hold a PR number from an earlier attempt, not
      // just PR_OPEN. A conflict re-arm walks a task out of PR_OPEN
      // and back round to DISPATCHED while its PR stays open behind it, so
      // checking PR_OPEN alone missed every PR that merged during that window
      // — and the task then rebuilt work already in the base and opened a
      // SECOND PR for it.
      if (
        task.status === "MERGED" ||
        task.status === "VERIFIED" ||
        task.status === "PENDING" ||
        task.status === "CANCELLED"
      )
        continue;
      if (!task.prNumber) {
        // No PR number on the row does NOT mean no pull request. The number is
        // only ever learned from an evidence bundle or a result artifact, so a
        // run that ended without posting either — the 401 webhook token, a
        // cancelled run, a dead runner — opens a PR the orchestrator never
        // hears about. The branch is the stable identity, as the comment on
        // findMergedPrForTaskBranch says; gating that lookup behind the very
        // field the broken case is missing made it unreachable exactly when it
        // was needed.
        //
        // Otherwise such a task sits in DISPATCHED with its work already merged
        // in the base. It holds a concurrency slot, and because `integration`
        // and `e2e` depend on it, neither could ever become READY — the
        // programme would stall no matter what else finished.
        const landed = await this.findMergedPrForTaskBranch(repo, task, null);
        if (landed === null) continue;
        taskMachine.assertTransition(task.status, "MERGED");
        await this.deps.store.updateBuildTask(task.id, { status: "MERGED", prNumber: landed });
        merged += 1;
        this.log(
          `${repo.slug}#${landed} (task ${task.id}) was merged from this task's branch while the task record carried no pull request; recorded as MERGED rather than rebuilt.`,
        );
        await this.postToReviewChannel(
          `Build task \`${task.id}\` on ${programme.key}: its work already landed in ${repo.slug}#${landed} and the task record carried no pull request of its own, so it is recorded as MERGED.`,
        );
        continue;
      }
      let pr: Awaited<ReturnType<ProgrammeBuildDeps["github"]["getPullRequest"]>>;
      try {
        pr = await this.deps.github.getPullRequest(repo.organization, repo.repository, task.prNumber);
      } catch (error) {
        this.warn(`PR ${repo.slug}#${task.prNumber} for ${task.id} could not be read: ${error instanceof Error ? error.message : "unknown"}`);
        continue;
      }
      if (!pr.merged) {
        // The task's CURRENT pull request is not merged — but an earlier one
        // from the same branch may have been, and then the task re-dispatched
        // and overwrote prNumber with the new PR. Screens that land through a
        // hand-merged integration PR would otherwise re-open PRs rebuilding work
        // already in the base, because the record of the merged PR was
        // overwritten.
        const landed = await this.findMergedPrForTaskBranch(repo, task, task.prNumber);
        if (landed === null) continue;
        taskMachine.assertTransition(task.status, "MERGED");
        await this.deps.store.updateBuildTask(task.id, { status: "MERGED", prNumber: landed });
        merged += 1;
        this.log(
          `${repo.slug}#${landed} (task ${task.id}) was already merged from this task's branch; recorded as MERGED rather than rebuilt.`,
        );
        await this.postToReviewChannel(
          `Build task \`${task.id}\` on ${programme.key}: its work already landed in ${repo.slug}#${landed}, so it is recorded as MERGED. ${repo.slug}#${task.prNumber} rebuilds work that is in the base and can be closed.`,
        );
        continue;
      }
      taskMachine.assertTransition(task.status, "MERGED");
      await this.deps.store.updateBuildTask(task.id, {
        status: "MERGED",
        mergedSha: pr.mergeCommitSha ?? pr.headSha ?? null,
      });
      merged += 1;
      const kind = ((task.metadata ?? {}) as { kind?: string }).kind ?? "task";
      await this.postToReviewChannel(
        kind === "technical-spec"
          ? task.id === sharedInfraTaskId(programme.key, "technical-spec")
            ? `Technical spec for \`${programme.key}\` approved: ${repo.slug}#${task.prNumber} was merged by a person. Criteria are re-assigned to screens from its table on this tick; the scaffold dispatches next.`
            : `Technical spec \`${specPathOf(programme.key, task)}\` for \`${programme.key}\` approved: ${repo.slug}#${task.prNumber} was merged by a person. This milestone's criteria are re-assigned from its table on this tick; its screens dispatch next.`
          : task.status === "PR_OPEN"
            ? `${repo.slug}#${task.prNumber} (task \`${task.id}\`, programme \`${programme.key}\`) was merged by a person; recorded as MERGED.`
            : `${repo.slug}#${task.prNumber} (task \`${task.id}\`, programme \`${programme.key}\`) was merged while the task had already been re-armed to ${task.status}; recorded as MERGED rather than rebuilt.`,
      );
      await this.remember(
        programme,
        "outcome",
        `${kind} task ${task.id} ("${task.title}") merged as ${repo.slug}#${task.prNumber}${kind === "technical-spec" ? " — the technical spec at " + specPathOf(programme.key, task) + " is approved and binding." : ", merged by a person after " + task.attempts + " attempt(s)."}`,
        { taskId: task.id, prNumber: task.prNumber, mergedBy: "human" },
        kind === "technical-spec" ? 0.9 : 0.6,
      );
    }
    return merged;
  }


  /**
   * Reads the merged technical spec from the working branch and re-assigns
   * criteria to screen tasks from its "Acceptance criteria by screen" table.
   * Idempotent per file sha: the sha is recorded on the programme, so the
   * table is applied once per revision and a re-merged spec re-applies.
   * Only tasks that have not been dispatched change owners — moving a
   * criterion off a task mid-build would orphan its RED test.
   */
  protected async applyTechnicalSpecMapping(
    programme: ProgrammeRecord,
    repo: RepoDescriptor,
    baseRef: string,
  ): Promise<void> {
    const tasks = await this.deps.store.listBuildTasks(programme.id);
    const programmeSpecId = sharedInfraTaskId(programme.key, "technical-spec");
    // Each merged spec maps its own screens: a milestone's spec its
    // milestone's, the programme's every milestone that has none of its own.
    const specTasks = withoutBenchTasks(tasks).filter(
      (task) => isTechnicalSpecTask(task) && (task.status === "MERGED" || task.status === "VERIFIED"),
    );
    const ownSpecMilestones = new Set(
      tasks.filter((task) => isTechnicalSpecTask(task) && task.id !== programmeSpecId).map((task) => task.milestoneId),
    );
    for (const specTask of specTasks) {
      const isProgrammeSpec = specTask.id === programmeSpecId;
      await this.applyOneTechnicalSpecMapping(programme, repo, baseRef, tasks, specTask, (task) =>
        isProgrammeSpec ? !ownSpecMilestones.has(task.milestoneId) : task.milestoneId === specTask.milestoneId,
      );
    }
  }


  protected async applyOneTechnicalSpecMapping(
    programme: ProgrammeRecord,
    repo: RepoDescriptor,
    baseRef: string,
    tasks: BuildTaskRecord[],
    specTask: BuildTaskRecord,
    governs: (task: BuildTaskRecord) => boolean,
  ): Promise<void> {
    const isProgrammeSpec = specTask.id === sharedInfraTaskId(programme.key, "technical-spec");
    const path = specPathOf(programme.key, specTask);
    let markdown: string | null;
    try {
      markdown = await this.deps.github.getFileContents(repo.organization, repo.repository, path, baseRef);
    } catch (error) {
      this.warn(`Technical spec ${path} on ${repo.slug}@${baseRef} could not be read: ${error instanceof Error ? error.message : "unknown"}`);
      return;
    }
    if (!markdown) {
      this.warn(`Technical spec task ${specTask.id} is merged but ${path} is not on ${repo.slug}@${baseRef}; criteria stay round-robin.`);
      return;
    }
    const sha = sha256(markdown);
    const meta = programmeMetadata(programme);
    const applied = meta.technicalSpecMappingShas?.[specTask.id] ?? (isProgrammeSpec ? meta.technicalSpecMappingSha : undefined);
    if (applied === sha) return;

    const parsedMapping = parseCriteriaByScreen(markdown);
    // Bench arms keep the criteria they were copied with: re-mapping them
    // would change the work mid-run and break the like-for-like comparison.
    const allScreenTasks = withoutBenchTasks(tasks).filter(
      (task) => (((task.metadata ?? {}) as { kind?: string }).kind ?? "") === "screen" && governs(task),
    );
    // Re-scoped tasks (set_task_criteria) are PINNED before the mapping runs,
    // not filtered after it: their ids cannot be moved to another task (no
    // criterion gets two owners), and a table row for a re-scoped screen whose
    // id that task does not own is deferred rather than left owned by nobody.
    const rescopedTasks = allScreenTasks.filter((task) => task.status !== "CANCELLED" && isCriteriaRescoped(task));
    const pinned = new Set(rescopedTasks.flatMap((task) => task.acceptanceCriterionIds));
    const rescopedScreens = new Set(
      rescopedTasks.flatMap((task) =>
        (((task.metadata ?? {}) as { screenStates?: string[] }).screenStates ?? []).map((state) => state.toLowerCase()),
      ),
    );
    const lostToRescoped = new Set<string>();
    // `mapping` drives the re-ownership: a re-scoped screen's leftover ids stay
    // in it so applyCriterionMapping strips them from siblings (the screen is
    // unknown to `planned`, so they are deferred, not re-spread).
    // `reportMapping` drops those rows, so the "screens outside this
    // milestone" report does not count ids already recorded as deferred here.
    const mapping: Record<string, string[]> = {};
    const reportMapping: Record<string, string[]> = {};
    for (const [screen, ids] of Object.entries(parsedMapping)) {
      const free = ids.filter((id) => !pinned.has(id));
      if (free.length === 0) continue;
      mapping[screen] = free;
      if (rescopedScreens.has(screen.trim().toLowerCase())) {
        for (const id of free) lostToRescoped.add(id);
      } else {
        reportMapping[screen] = free;
      }
    }
    if (rescopedTasks.length > 0) {
      this.log(
        `Technical spec mapping for ${programme.key} pinned re-scoped task(s) ${rescopedTasks.map((task) => task.id).join(", ")}; ${lostToRescoped.size} mapped criteria for their screens deferred.`,
      );
    }
    const screenTasks = allScreenTasks.filter((task) => !isCriteriaRescoped(task));
    const planned: PlannedTask[] = screenTasks.map((task) => ({
      id: task.id,
      dependsOn: task.dependsOn,
      status: task.status,
      title: task.title,
      kind: "screen",
      acceptanceCriterionIds: task.acceptanceCriterionIds,
      screenStates: ((task.metadata ?? {}) as { screenStates?: string[] }).screenStates ?? [],
      testKinds: (((task.metadata ?? {}) as { testKinds?: PlannedTask["testKinds"] }).testKinds ?? ["unit"]),
    }));
    // Only PENDING/READY tasks can be re-owned: a task that is already building
    // has its criteria in a brief on a runner, and rewriting them underneath it
    // would judge the build against a contract it never received.
    const reowned = applyCriterionMapping(planned, mapping);
    const writable = reowned.filter((task) => ["PENDING", "READY"].includes(task.status));
    // A task that cannot be written YET but is not finished either — building,
    // in review, handed back. It will reach PENDING/READY again, and when it
    // does this mapping still has to reach it. MERGED/VERIFIED are excluded:
    // their criteria are already proven, re-owning them would change nothing,
    // and counting them here would re-read the spec on every tick for ever.
    const deferredTasks = reowned.filter(
      (task) => !["PENDING", "READY", "MERGED", "VERIFIED", "CANCELLED"].includes(task.status),
    );
    for (const task of writable) {
      await this.deps.store.updateBuildTask(task.id, { acceptanceCriterionIds: task.acceptanceCriterionIds });
    }
    // The sha marks this spec version as APPLIED, and the guard above makes
    // that one-way. Recording it after a pass that reached no task is how a
    // spec change gets computed, discarded and marked done in one tick — which
    // is what happens when a row is edited while its task is DISPATCHED: the
    // tick logs "0 task(s) re-owned", records the sha, and the edit is silently
    // undone until a second edit to the document changes the sha again. So the sha is recorded only once nothing is left to reach.
    if (deferredTasks.length === 0) {
      const next: ProgrammeMetadata = {
        ...meta,
        ...(isProgrammeSpec ? { technicalSpecMappingSha: sha } : {}),
        technicalSpecMappingShas: { ...(meta.technicalSpecMappingShas ?? {}), [specTask.id]: sha },
      };
      await this.deps.store.updateProgramme(programme.key, { metadata: next as Record<string, unknown> });
      programme.metadata = next as Record<string, unknown>;
    } else {
      this.log(
        `Technical spec mapping for ${programme.key} (${path}) is not complete: ${deferredTasks.length} task(s) still to re-own once they leave their current state (${deferredTasks
          .map((task) => `${task.id.split(":").pop()}=${task.status}`)
          .join(", ")}). It will be re-applied on a later tick.`,
      );
    }
    if (lostToRescoped.size > 0) await this.addDeferredCriteria(programme.key, [...lostToRescoped]);
    const mappedCount = Object.values(mapping).reduce((total, ids) => total + ids.length, 0);
    const deferred = deferredCriteria(planned, reportMapping);
    this.log(
      `Technical spec mapping applied for ${programme.key} (${path}): ${Object.keys(mapping).length} screen row(s), ${mappedCount} criteria, ${writable.length} task(s) re-owned, ${deferred.length} criteria deferred to screens outside this milestone.`,
    );
    if (deferred.length > 0) {
      await this.postToReviewChannel(
        `Technical spec \`${path}\` for \`${programme.key}\`: ${deferred.length} criteria sit on screens this milestone does not build, so they are removed from its tasks and wait for a later milestone (${deferred.slice(0, 12).join(", ")}${deferred.length > 12 ? ", …" : ""}).`,
      );
    }
    if (Object.keys(mapping).length === 0) {
      await this.postToReviewChannel(
        `The merged technical spec \`${path}\` for \`${programme.key}\` has no readable "Acceptance criteria by screen" table, so criteria stay spread round-robin across screens. Add the table (| Screen | Criteria |) and merge again to fix the assignment.`,
      );
    }
  }


  protected async dispatchTask(
    programme: ProgrammeRecord,
    // The whole descriptor, not owner/repository apart: `workdir` has to
    // travel with them, and two rebuild repo KEYS now share one slug, so a
    // pair of strings no longer identifies the app being built.
    repo: RepoDescriptor,
    ref: string,
    task: BuildTaskRecord,
  ): Promise<boolean> {
    const { organization: owner, repository: repoName } = repo;
    if (task.attempts >= this.attemptCapFor(task)) {
      return false;
    }
    const baseUrl = this.deps.flags.publicBaseUrl.replace(/\/$/, "");
    if (!baseUrl) {
      this.warn(
        `Dispatch refused for ${task.id}: PROGRAMME_PUBLIC_BASE_URL is empty, so no brief URL can be composed (fail closed).`,
      );
      return false;
    }

    // Row FIRST, dispatch second — the runner fetches the brief by attemptId
    // the moment it starts, so the row must exist before the run can.
    const attemptId = this.mintId();
    // `attempts` is incremented below, so the brief will see this value.
    const dispatchAttempt = task.attempts + 1;
    const dispatchTaskKind = ((task.metadata ?? {}) as { kind?: string }).kind ?? "screen";
    await this.deps.attempts.quickFixAttempt.create({
      data: {
        id: attemptId,
        githubNumber: 0,
        repository: `${owner}/${repoName}`,
        resultStatus: "dispatched",
        status: "eligible",
        eligible: true,
        reasons: [`programme:${programme.key}`],
        dispatchedAt: this.now(),
        buildTaskId: task.id,
        // Rebuild benchmark: the same resolution the brief will serve for
        // this attempt, recorded so model choice is read from history.
        taskKind: dispatchTaskKind,
        attemptNumber: dispatchAttempt,
        model: this.modelForTask(dispatchTaskKind, dispatchAttempt, task) ?? null,
      },
    });
    // A plan row is born PENDING; the machine's edge to DISPATCHED runs
    // through READY, so both legs are walked (and persisted) explicitly.
    if (task.status === "PENDING") {
      taskMachine.assertTransition("PENDING", "READY");
      await this.deps.store.updateBuildTask(task.id, { status: "READY" });
      task = { ...task, status: "READY" };
    }
    taskMachine.assertTransition(task.status, "DISPATCHED");
    await this.deps.store.updateBuildTask(task.id, {
      status: "DISPATCHED",
      currentAttemptId: attemptId,
      attempts: task.attempts + 1,
      // Recorded so the fold can find the run when no evidence arrives to
      // carry its id. Metadata is Json, so this needs no migration.
      metadata: { ...(task.metadata ?? {}), dispatchedAt: this.now().toISOString() },
    });

    try {
      await this.deps.github.dispatchWorkflow(owner, repoName, this.deps.policy.dispatch.workflowFile, ref, {
        attempt_id: attemptId,
        build_task_id: task.id,
        brief_url: `${baseUrl}/api/programme/briefs/${attemptId}`,
        // Omitted for a root repo — programme-build.yml defaults it to "".
        // Sent when the repo
        // holds several apps, where the runner would otherwise look for a
        // manifest at the root, find none, and record all four required
        // checks as "skipped — skeleton repo". A skipped check is present,
        // and the auto-merge gate only asks for presence.
        ...(repo.workdir ? { workdir: repo.workdir } : {}),
        // Only for working-branch programmes: the thin caller on the default
        // branch may not declare the input, and GitHub rejects a dispatch
        // carrying an undeclared one. The caller on the working branch does.
        ...(ref !== (repo.defaultBranch ?? "main") ? { base_branch: ref } : {}),
      });
      this.log(`Dispatched ${task.id} (attempt ${attemptId}) to ${owner}/${repoName}@${ref}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "dispatch failed";
      this.warn(`Dispatch failed for ${task.id}: ${message}`);
      // Roll the task back to FAILED. The attempt is refunded: GitHub refused
      // the dispatch, so no runner started and nothing about the build was
      // tested. Bounded by maxInfraFaults, which is what keeps the original
      // concern honest — a permanently broken repo still terminates, it just
      // does so on its own budget instead of eating the build's.
      const refund = this.refundInfraFault(task, task.attempts + 1, `dispatch failed: ${message}`);
      taskMachine.assertTransition("DISPATCHED", "FAILED");
      await this.deps.store.updateBuildTask(task.id, {
        status: "FAILED",
        ...(refund ? { attempts: refund.attempts } : {}),
        metadata: {
          ...(task.metadata ?? {}),
          ...(refund?.metadataPatch ?? {}),
          handbackReason: `dispatch failed: ${message}`,
        },
      });
      await this.deps.attempts.quickFixAttempt.update({
        where: { id: attemptId },
        data: { resultStatus: "failed", resultText: message, outcome: "dispatch_failed", completedAt: this.now() },
      });
      return false;
    }
  }


  /**
   * Rebuild benchmark: stamp an attempt's terminal outcome, completion time
   * and token spend on its row. Observe-only — a failure here is logged and
   * never changes what the fold does.
   *
   * Written to `outcome`, never `resultStatus`: other readers of the attempt
   * ledger (fix-outcome reports, stale-PR sweeps) read `resultStatus` without
   * excluding programme rows, and a programme "shipped" there would be
   * counted as one of theirs.
   */
  protected async recordAttemptOutcome(
    attemptId: string,
    outcome: "shipped" | "handback" | "failed" | "infra_handback" | "no_result",
    evidence?: RunEvidenceListRow[],
    result?: ProgrammeBuildResult,
  ): Promise<void> {
    try {
      const rows = evidence ?? (await this.deps.evidence.listByAttempt(attemptId));
      // The result's usage covers every phase that ran, including the ones
      // no evidence bundle meters (a hand-back, the technical-spec DRAFT). It
      // goes last so it wins the (model, phase) de-duplication.
      const usageRows: Array<Pick<RunEvidenceListRow, "checks">> = result?.tokenUsage
        ? [...rows, { checks: [{ name: "token-usage", status: "passed", detail: result.tokenUsage }] }]
        : rows;
      const spend = attemptSpendFromEvidence(usageRows, this.deps.pricing ?? {});
      const latest = rows.reduce<number | null>((max, row) => {
        const ms = row.receivedAt instanceof Date ? row.receivedAt.getTime() : Date.parse(String(row.receivedAt));
        return Number.isFinite(ms) && (max === null || ms > max) ? ms : max;
      }, null);
      if (spend.unpricedModels.length > 0) {
        this.warn(
          `Attempt ${attemptId} used unpriced model(s) ${spend.unpricedModels.join(", ")} — cost left empty; add them to the deployment's model pricing.`,
        );
      }
      await this.deps.attempts.quickFixAttempt.update({
        where: { id: attemptId },
        data: {
          outcome,
          completedAt: latest === null ? this.now() : new Date(latest),
          ...spend.columns,
        },
      });
    } catch (error) {
      this.warn(
        `Could not record benchmark outcome for attempt ${attemptId}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
}
