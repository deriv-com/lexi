import type { RepoDescriptor } from "@lexi/contracts";
import { evaluateHardeningGate } from "../hardening-gate";
import {
  milestoneReviewBlocks,
  milestoneReviewFallbackText,
  type MilestoneReviewBlockArgs,
} from "../milestone-review-blocks";
import { withoutBenchTasks } from "../model-bench-plan";
import type { BuildTaskRecord, MilestoneRecord, ProgrammeRecord } from "../programme-store";
import { SWEEP_CHECK_NAME, programmeMachine, milestoneMachine } from "./helpers";
import { ProgrammeMerge } from "./programme-merge";

/**
 * Milestone review cards, the exploratory sweep that judges a milestone's
 * head, the hardening pass and the daily digest.
 */
export abstract class ProgrammeReview extends ProgrammeMerge {

  /* ----------------------------------------------------------- milestone */

  /**
   * Posts a card for every milestone of a parked programme that is IN_REVIEW
   * with none. Idempotent: a milestone that gets one records its thread ts and
   * is skipped from then on.
   */
  protected async repostMissingMilestoneCards(programme: ProgrammeRecord): Promise<void> {
    const milestones = (await this.deps.store.listMilestones(programme.id)).filter(
      (milestone) =>
        milestone.ordinal > 0 && milestone.status === "IN_REVIEW" && !milestone.reviewThreadTs,
    );
    if (milestones.length === 0) return;
    const tasks = withoutBenchTasks(await this.deps.store.listBuildTasks(programme.id));
    for (const milestone of milestones) {
      const own = tasks.filter((task) => task.milestoneId === milestone.id);
      if (own.length === 0) continue;
      await this.repostMilestoneReview(programme, milestone, own);
    }
  }


  /**
   * Re-posts the card for a milestone that is already IN_REVIEW and never got
   * one. No state transition: the milestone is where it belongs, the card is
   * simply missing, and without one there is no route to approval at all.
   *
   * Idempotent by construction — the thread ts is recorded on success, and
   * the caller only selects milestones that have none.
   */
  protected async repostMilestoneReview(
    programme: ProgrammeRecord,
    milestone: MilestoneRecord,
    tasks: BuildTaskRecord[],
  ): Promise<void> {
    const channel = this.deps.flags.reviewChannel;
    if (!channel) return;
    const cardArgs = this.milestoneCardArgs(programme, milestone, tasks);
    const sent = await this.deps.notifier.sendMessage({
      channel,
      text: `Milestone review — ${programme.title} / ${milestone.title}`,
      blocks: milestoneReviewBlocks(cardArgs) as Array<Record<string, unknown>>,
    });
    if (!sent.ok) {
      // Warn only. The fallback notice belongs to the original transition:
      // repeating it every ten minutes would turn one missing card into a
      // recurring alarm in the channel a reviewer is meant to trust.
      this.warn(
        `Milestone review card could not be re-posted for ${milestone.id}: ${sent.error ?? "write gate"}`,
      );
      return;
    }
    this.log(`Re-posted the milestone review card for ${milestone.id} — its first one never landed.`);
    await this.deps.store.updateMilestone(milestone.id, {
      reviewChannel: channel,
      ...(sent.ts ? { reviewThreadTs: sent.ts } : {}),
    });
  }


  /** The card's inputs, shared by the first post and any re-post. */
  protected milestoneCardArgs(
    programme: ProgrammeRecord,
    milestone: MilestoneRecord,
    tasks: BuildTaskRecord[],
  ): MilestoneReviewBlockArgs {
    const headSha =
      tasks
        .map((task) => task.mergedSha)
        .filter((sha): sha is string => typeof sha === "string" && sha.length > 0)
        .at(-1) ?? "unknown";
    const merged = tasks.filter((task) => task.status === "MERGED" || task.status === "VERIFIED").length;
    const criteria = new Set(tasks.flatMap((task) => task.acceptanceCriterionIds));
    return {
      programmeKey: programme.key,
      programmeTitle: programme.title,
      milestoneId: milestone.id,
      milestoneOrdinal: milestone.ordinal,
      milestoneTitle: milestone.title,
      tasksMerged: merged,
      tasksTotal: tasks.length,
      headSha,
      acSummary: `${criteria.size} acceptance criteria across ${tasks.length} tasks`,
      evidenceLinks: tasks
        .filter((task) => task.prNumber)
        .map((task) => ({
          label: `PR #${task.prNumber} — ${task.title}`,
          url: `https://github.com/${this.deps.registry.resolveRepo(task.codeRepoKey)?.slug}/pull/${task.prNumber}`,
        })),
    };
  }


  protected async postMilestoneReview(
    programme: ProgrammeRecord,
    milestone: MilestoneRecord,
    tasks: BuildTaskRecord[],
  ): Promise<void> {
    const cardArgs = this.milestoneCardArgs(programme, milestone, tasks);
    const blocks = milestoneReviewBlocks(cardArgs);

    milestoneMachine.assertTransition("EVIDENCE_COMPLETE", "IN_REVIEW");
    const channel = this.deps.flags.reviewChannel;
    let threadTs: string | undefined;
    if (channel) {
      const sent = await this.deps.notifier.sendMessage({
        channel,
        text: `Milestone review — ${programme.title} / ${milestone.title}`,
        blocks: blocks as Array<Record<string, unknown>>,
      });
      if (sent.ok) threadTs = sent.ts;
      else {
        // A Block Kit failure is all-or-nothing: Slack rejects the message,
        // not just the offending block, so the reviewer is told NOTHING while
        // the milestone parks itself anyway (a large milestone's card can be
        // rejected as `invalid_blocks`). Falling back to plain text keeps the human in the loop
        // even when the card cannot render.
        this.warn(`Milestone review card blocked for ${milestone.id}: ${sent.error ?? "write gate"} — falling back to a plain-text notice.`);
        await this.postToReviewChannel(milestoneReviewFallbackText(cardArgs));
      }
    } else {
      this.warn(`No PROGRAMME_REVIEW_CHANNEL configured — milestone ${milestone.id} parks with no card posted.`);
    }
    await this.deps.store.updateMilestone(milestone.id, {
      status: "IN_REVIEW",
      ...(channel ? { reviewChannel: channel } : {}),
      ...(threadTs ? { reviewThreadTs: threadTs } : {}),
    });
  }


  /* --------------------------------------------------- exploratory sweep */

  /** The milestone's head: the last merged task SHA, exactly as the review card derives it. */
  protected milestoneHead(own: BuildTaskRecord[]): string {
    return (
      own
        .map((task) => task.mergedSha)
        .filter((sha): sha is string => typeof sha === "string" && sha.length > 0)
        .at(-1) ?? "unknown"
    );
  }


  /**
   * What the stored sweep says about `headSha`:
   *   absent  — no sweep dispatched for this head (or the head moved since);
   *   pending — dispatched, no `exploratory-sweep` check received yet;
   *   passed  — the sweep drove the preview at this SHA and found nothing;
   *   failed  — findings exist (filed as issues by the sweep itself).
   * A bundle for a DIFFERENT commit is ignored: the gate is per head SHA.
   */
  protected async sweepVerdict(
    milestone: MilestoneRecord,
    headSha: string,
  ): Promise<"absent" | "pending" | "passed" | "failed"> {
    if (!milestone.sweepAttemptId || milestone.sweepHeadSha !== headSha) return "absent";
    const rows = await this.deps.evidence.listByAttempt(milestone.sweepAttemptId);
    for (const row of rows) {
      if (row.commitSha && row.commitSha !== headSha) continue;
      const checks = Array.isArray(row.checks) ? (row.checks as Array<Record<string, unknown>>) : [];
      const sweep = checks.find((check) => check && check.name === SWEEP_CHECK_NAME);
      if (!sweep) continue;
      return sweep.status === "passed" ? "passed" : "failed";
    }
    return "pending";
  }


  /**
   * Dispatches `programme-explore.yml` against the rebuild repo's preview at the
   * milestone head. Fails closed — a missing preview URL, base URL or
   * dispatch error leaves the milestone IN_PROGRESS with a named warning
   * rather than skipping the sweep.
   */
  protected async dispatchSweep(
    programme: ProgrammeRecord,
    repo: RepoDescriptor,
    ref: string,
    milestone: MilestoneRecord,
    headSha: string,
  ): Promise<boolean> {
    const { organization: owner, repository: repoName } = repo;
    if (!this.deps.flags.dispatchEnabled) {
      this.warn(`Sweep for ${milestone.id} withheld: PROGRAMME_DISPATCH_ENABLED is off.`);
      return false;
    }
    if (headSha === "unknown") {
      this.warn(`Sweep for ${milestone.id} refused: no merged SHA recorded on its tasks (fail closed).`);
      return false;
    }
    const baseUrl = this.deps.flags.publicBaseUrl.replace(/\/$/, "");
    if (!baseUrl) {
      this.warn(`Sweep for ${milestone.id} refused: PROGRAMME_PUBLIC_BASE_URL is empty (fail closed).`);
      return false;
    }
    const previewUrl = await this.previewUrl(repo, ref);
    if (!previewUrl) {
      const manifestPath = repo.workdir ? `${repo.workdir}/.lexi/repo.json` : ".lexi/repo.json";
      const message = `Milestone \`${milestone.id}\` on \`${programme.key}\` is built but CANNOT complete: ${owner}/${repoName} has no \`previewUrl\` in \`${manifestPath}\`, so the exploratory sweep has nothing to drive. Set it (the deployed preview of the default branch) and the sweep dispatches on the next tick.`;
      this.warn(message);
      if (milestone.sweepHeadSha !== headSha) {
        // Say it once per head, not every ten minutes.
        await this.postToReviewChannel(message);
        await this.deps.store.updateMilestone(milestone.id, { sweepHeadSha: headSha });
      }
      return false;
    }

    // Set but not serving is its own failure, and it used to be invisible.
    // The sweep would dispatch, the agent would find nothing at the host, and
    // the run would come back with findings describing a missing DNS record
    // as though the product were broken — at the cost of a full agent run.
    // Refused by name instead, on the same once-per-head cadence as an empty
    // value, so it self-heals the moment the host starts serving without
    // anyone editing the manifest again.
    if (this.deps.previewProbe) {
      const probe = await this.deps.previewProbe.reachable(previewUrl).catch((error: unknown) => ({
        ok: false,
        detail: error instanceof Error ? error.message : "probe threw",
      }));
      if (!probe.ok) {
        const message = `Milestone \`${milestone.id}\` on \`${programme.key}\` is built but CANNOT complete: its preview \`${previewUrl}\` is not serving (${probe.detail}). The sweep is withheld rather than dispatched, because an agent sent at an unreachable host reports the outage as product findings. Nothing to change in the manifest — the sweep dispatches on the next tick once that URL responds.`;
        this.warn(message);
        if (milestone.sweepHeadSha !== headSha) {
          await this.postToReviewChannel(message);
          await this.deps.store.updateMilestone(milestone.id, { sweepHeadSha: headSha });
        }
        return false;
      }
    }

    const attemptId = this.mintId();
    await this.deps.attempts.quickFixAttempt.create({
      data: {
        id: attemptId,
        githubNumber: 0,
        repository: `${owner}/${repoName}`,
        resultStatus: "dispatched",
        status: "eligible",
        eligible: true,
        reasons: [`programme-sweep:${programme.key}`],
        dispatchedAt: this.now(),
        buildTaskId: `${milestone.id}:sweep`,
      },
    });
    await this.deps.store.updateMilestone(milestone.id, { sweepAttemptId: attemptId, sweepHeadSha: headSha });

    // No parity floor: never feed a production parity inventory to
    // the exploratory sweep — even when an older programme still carries
    // referenceRepoKey. Briefs already omit it; the sweep must match.
    try {
      await this.deps.github.dispatchWorkflow(owner, repoName, this.deps.policy.dispatch.exploreWorkflowFile, ref, {
        attempt_id: attemptId,
        preview_url: previewUrl,
        commit_sha: headSha,
      });
      this.log(`Sweep dispatched for ${milestone.id} at ${headSha.slice(0, 12)} → ${previewUrl}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "dispatch failed";
      this.warn(`Sweep dispatch failed for ${milestone.id}: ${message}`);
      await this.deps.attempts.quickFixAttempt.update({
        where: { id: attemptId },
        data: { resultStatus: "failed", resultText: message },
      });
      // Clear the pointer so the next tick retries rather than waiting on a
      // run that never started.
      await this.deps.store.updateMilestone(milestone.id, { sweepAttemptId: null, sweepHeadSha: null });
      return false;
    }
  }


  /* ------------------------------------------------------------ hardening pass */

  protected async advanceHardening(programme: ProgrammeRecord): Promise<void> {
    const label = `${this.deps.policy.hardening.labelPrefix}${programme.key}`;

    // Findings are read from the programme's OWN repo as well as the shared
    // findings repo, when one is configured. Findings belong with the thing
    // being rebuilt, and a shared repo is not always reachable by the App, so
    // the programme's own repo must count on its own.
    //
    // A source that throws is NOT read as "no findings". The gate is allowed
    // to pass only when at least one source answered — otherwise an
    // unreadable list would complete a programme by looking clean, which is
    // the opposite of what this gate is for.
    const target = this.deps.registry.resolveRepo(programme.targetRepoKey);
    const sources = [
      ...(target ? [[target.organization, target.repository] as const] : []),
      ...(this.deps.findingsRepoSlug
        ? [this.deps.findingsRepoSlug.split("/") as unknown as readonly [string, string]]
        : []),
    ];
    const findings: Array<{ githubNumber: number; title: string }> = [];
    const seen = new Set<number>();
    let answered = 0;
    for (const [owner, repoName] of sources) {
      if (!owner || !repoName) continue;
      try {
        const rows = await this.deps.github.listBugHuntIssues({
          owner,
          repo: repoName,
          label,
          state: "open",
        });
        answered += 1;
        for (const row of rows) {
          if (seen.has(row.githubNumber)) continue;
          seen.add(row.githubNumber);
          findings.push({ githubNumber: row.githubNumber, title: row.title });
        }
      } catch (error) {
        this.warn(
          `Hardening findings on ${owner}/${repoName} for ${programme.key} could not be read: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
    if (answered === 0) {
      this.warn(
        `No hardening findings source could be read for ${programme.key} — the gate is not evaluated rather than passed on an unreadable list.`,
      );
      return;
    }

    const verdict = evaluateHardeningGate({
      openFindings: findings.map((finding) => ({
        issueNumber: finding.githubNumber,
        title: finding.title,
      })),
      concludedBy: await this.hardeningConclusion(programme),
      policy: this.deps.policy.hardening,
    });
    if (verdict.passed) {
      programmeMachine.assertTransition("HARDENING", "COMPLETE");
      await this.deps.store.updateProgramme(programme.key, { status: "COMPLETE" });
      await this.postToReviewChannel(
        `Programme \`${programme.key}\` is COMPLETE: hardening pass concluded with zero open \`${label}\` findings.`,
      );
      // Completion is precisely when the human-facing checklist must be right.
      await this.syncTrackingIssue(programme);
    }
  }


  /**
   * The hardening conclusion, recorded by `recordHardeningConclusion` as a synthetic
   * ordinal-0 milestone row — bookkeeping, never plannable. Null until a
   * human with `programme.hardening.conclude` has clicked, which is the leg
   * `evaluateHardeningGate` refuses on until then.
   */
  protected async hardeningConclusion(programme: ProgrammeRecord): Promise<string | null> {
    const conclusion = await this.deps.store.getMilestone(`${programme.key}:hardening`);
    return conclusion?.approvedBy ?? null;
  }


  /** Called by the milestone-review service when a human concludes the hardening. */
  async recordHardeningConclusion(programmeKey: string, userId: string): Promise<void> {
    const programme = await this.deps.store.getProgramme(programmeKey);
    if (!programme) throw new Error(`No programme named ${programmeKey}`);
    if (programme.status !== "HARDENING") {
      throw new Error(`Programme ${programmeKey} is ${programme.status}, not HARDENING`);
    }
    // A synthetic milestone row holds the conclusion so the schema needs no
    // extra column: ordinal 0 marks it as bookkeeping, never plannable.
    await this.deps.store.createMilestones([
      {
        id: `${programmeKey}:hardening`,
        programmeId: programme.id,
        ordinal: 0,
        title: "Hardening pass conclusion",
        status: "APPROVED",
        approvedBy: userId,
      },
    ]);
  }


  /* -------------------------------------------------------------- digest */

  async digest(): Promise<void> {
    const active = await this.deps.store.listProgrammesByStatus([
      "SEEDED",
      "PLANNED",
      "BUILDING",
      "MILESTONE_REVIEW",
      "HARDENING",
    ]);
    if (active.length === 0) return;
    const lines: string[] = ["*Rebuild programmes*"];
    for (const programme of active) {
      const tasks = await this.deps.store.listBuildTasks(programme.id);
      const merged = tasks.filter((task) => task.status === "MERGED" || task.status === "VERIFIED").length;
      lines.push(
        `• \`${programme.key}\` — ${programme.status}; ${merged}/${tasks.length || 0} tasks merged`,
      );
      const usage = await this.usageSummaryLine(programme.id);
      if (usage) lines.push(usage);
    }
    await this.postToReviewChannel(lines.join("\n"));
  }
}
