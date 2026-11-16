import type { RepoDescriptor } from "@lexi/contracts";
import { isPreAgentHandback, infrastructureStageOf } from "../attempt-accounting";
import type { BuildTaskRecord, ProgrammeRecord } from "../programme-store";
import { extractJsonObjectsFromZip } from "./zip-json";
import type { ProgrammeBuildResult, RunEvidenceListRow } from "./ports";
import {
  withoutRetryNote,
  RESULT_ARTIFACT_NAME,
  RUN_SCAN_LIMIT,
  RUN_SCAN_FALLBACK_WINDOW_MS,
  taskMachine,
  specPathOf,
  isProgrammeBuildResult,
  type BuildTaskStatusLike,
} from "./helpers";
import { ProgrammeBriefs } from "./programme-briefs";

/**
 * Folding a dispatched task's outcome: reading its evidence and its run's
 * result artifact, finding a run that left no evidence, and handing back or
 * re-arming a task whose run ended without a usable result.
 */
export abstract class ProgrammeFold extends ProgrammeBriefs {

  protected async foldTask(
    programme: ProgrammeRecord,
    owner: string,
    repoName: string,
    task: BuildTaskRecord,
  ): Promise<void> {
    const attemptId = task.currentAttemptId;
    if (!attemptId) {
      // Returning silently here strands the task: every later step of this
      // fold, including handBackStaleDispatch — the one net that frees a slot
      // nothing else can — is downstream of it. A row in a live state with no
      // attempt id is not a normal condition, so say so rather than leaving a
      // stuck programme with no trace of why.
      if (["DISPATCHED", "EVIDENCE_RED", "EVIDENCE_GREEN", "PR_OPEN"].includes(task.status)) {
        this.warn(
          `${task.id} is ${task.status} with no current attempt id, so no run can be attributed to it and it cannot go stale. It will hold a concurrency slot until it is re-armed by hand.`,
        );
      }
      return;
    }
    let evidence = await this.deps.evidence.listByAttempt(attemptId);

    // The structured result (programme-result artifact) carries the PR number and
    // terminal verdict. Any evidence row's run id locates the run.
    //
    // When NO evidence arrived, the run has to be found another way, and this
    // is not a rare corner: a run that refuses its brief hands back before the
    // agent starts, so it never posts a red bundle (an identity-aware proxy
    // refusing the brief fetch is enough), and the task would sit in
    // DISPATCHED indefinitely if `return` here were the whole story.
    // retry_build_task refuses anything that is not HANDBACK or FAILED, so
    // nothing in the tool set could move it either.
    const runId =
      evidence.map((row) => this.normaliseRunId(row.workflowRunId)).find((id) => id !== null) ??
      (await this.findRunForAttempt(owner, repoName, task, attemptId));

    // No evidence rows but a real run: read the bundles off the run itself.
    // The runner uploads them as `programme-evidence` on every phase and calls that
    // artifact "the fallback read path" — it was never actually read, so a
    // stale LEXI_EVIDENCE_WEBHOOK_TOKEN (a 401 the runner only warns about)
    // silently froze every task in DISPATCHED while the run looked green.
    //
    // This is not a second door into evidence: ingest() validates each bundle
    // and correlates it by attempt exactly as the HTTP path does, and the run
    // is one THIS orchestrator dispatched and located for THIS attempt.
    if (evidence.length === 0 && runId !== null && this.deps.evidenceArtifacts) {
      try {
        const summary = await this.deps.evidenceArtifacts.ingestFromWorkflowRun(
          owner,
          repoName,
          runId,
        );
        if (summary.ingested > 0) {
          this.log(
            `Recovered ${summary.ingested} evidence bundle(s) for attempt ${attemptId} from run ${runId}'s artifact — none had arrived by POST`,
          );
          evidence = await this.deps.evidence.listByAttempt(attemptId);
        }
      } catch (error) {
        this.warn(
          `Could not read evidence artifacts on ${owner}/${repoName} run ${runId}: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }

    const phases = new Set(evidence.map((row) => row.phase));
    let status = task.status;

    if (status === "DISPATCHED" && phases.has("red")) {
      taskMachine.assertTransition(status, "EVIDENCE_RED");
      await this.deps.store.updateBuildTask(task.id, { status: "EVIDENCE_RED" });
      status = "EVIDENCE_RED";
    }
    if (status === "EVIDENCE_RED" && phases.has("green")) {
      taskMachine.assertTransition(status, "EVIDENCE_GREEN");
      await this.deps.store.updateBuildTask(task.id, { status: "EVIDENCE_GREEN" });
      status = "EVIDENCE_GREEN";
    }

    if (!runId) {
      // No run could be attributed to this attempt. GitHub's workflow_dispatch
      // returns no run id, so a run is only ever found by reading a result or
      // an evidence row off it — and a run that ended without producing either
      // (cancelled, timed out, runner died) is invisible by construction. The
      // only honest signal left is age.
      await this.handBackStaleDispatch(programme, task, status);
      return;
    }
    const result = await this.readBuildResult(owner, repoName, runId, attemptId);
    if (!result) {
      // No result artifact. That is normal while the run is still going, and
      // permanent once it has ENDED without uploading one — a cancelled run,
      // a job timeout, a runner that died. Before this, those two cases were
      // indistinguishable here and the second stranded the task forever: it
      // sat in DISPATCHED / EVIDENCE_RED / EVIDENCE_GREEN, none of which
      // retry_build_task will touch, holding a concurrency slot for good.
      // Runs cancelled by hand to stop spend would otherwise leave their tasks
      // frozen and, with enough of them, use up every concurrency slot.
      await this.handBackResultlessRun(programme, owner, repoName, task, status, runId);
      return;
    }

    // A document task (the technical spec) posts no evidence: there is no
    // test to fail first and nothing to run. Its result is a PR a person will
    // merge, so it walks the two evidence edges explicitly to reach PR_OPEN.
    // The machine keeps refusing DISPATCHED -> PR_OPEN as a single edge on
    // purpose; this is the one place that walks them, and it says so.
    const isDocumentTask = (((task.metadata ?? {}) as { kind?: string }).kind ?? "") === "technical-spec";
    if (isDocumentTask && result.status === "shipped" && result.prNumber && status === "DISPATCHED") {
      taskMachine.assertTransition(status, "EVIDENCE_RED");
      taskMachine.assertTransition("EVIDENCE_RED", "EVIDENCE_GREEN");
      await this.deps.store.updateBuildTask(task.id, { status: "EVIDENCE_GREEN" });
      status = "EVIDENCE_GREEN";
    }

    if (result.status === "shipped" && status === "EVIDENCE_GREEN" && result.prNumber) {
      taskMachine.assertTransition(status, "PR_OPEN");
      await this.deps.store.updateBuildTask(task.id, {
        status: "PR_OPEN",
        prNumber: result.prNumber,
        metadata: { ...(task.metadata ?? {}), headSha: result.headSha ?? null },
      });
      await this.recordAttemptOutcome(attemptId, "shipped", evidence, result);
      if (isDocumentTask) {
        await this.postTechnicalSpecQuestions(programme, owner, repoName, result.prNumber, result.headSha, specPathOf(programme.key, task));
      }
      return;
    }
    if (result.status === "shipped" && (status === "DISPATCHED" || status === "EVIDENCE_RED")) {
      await this.reArmOnIncompleteEvidence(programme, owner, repoName, task, status, phases, evidence, result);
      return;
    }
    // A run that failed at an infrastructure stage — the push-and-PR step or
    // the UI-source checkout. Both can come back FAILED from a seconds-old App
    // token refused while GitHub propagates it, and FAILED is re-armed by
    // nothing automatic, so the milestone would wait for a person to call
    // retry_build_task. The rebuild resumes the task's branch.
    //
    // Only while the infrastructure budget lasts. Once maxInfraFaults is spent
    // the helper declines and this falls through to the FAILED branch below,
    // exactly as before — so a stage that fails for good (a missing install or
    // permission, a ruleset) stops after three refunded runs instead of also
    // burning every remaining build attempt.
    const infraStage =
      result.status === "handback" || result.status === "failed"
        ? infrastructureStageOf(result.handbackReason)
        : null;
    if (
      infraStage &&
      taskMachine.canTransition(status, "HANDBACK") &&
      (await this.reArmAsInfrastructureFault(programme, task, status, {
        reason: `run ${runId} failed while ${infraStage.label}`,
        consequence: infraStage.consequence,
        whenBudgetSpent: "fall-through",
        evidence,
        result,
      }))
    ) {
      return;
    }
    if (result.status === "handback" || result.status === "failed") {
      const target = result.status === "handback" ? "HANDBACK" : "FAILED";
      if (taskMachine.canTransition(status, target)) {
        // A handback the runner raised BEFORE starting the agent (it could not
        // fetch its brief) tested nothing, so it gives the attempt back — same
        // bounded budget as a failed dispatch. Every other reason means the
        // agent ran, and those spend the build budget as they always have.
        const refund = isPreAgentHandback(result.handbackReason)
          ? this.refundInfraFault(task, task.attempts, result.handbackReason ?? "brief refused")
          : null;
        taskMachine.assertTransition(status, target);
        await this.deps.store.updateBuildTask(task.id, {
          status: target,
          ...(refund ? { attempts: refund.attempts } : {}),
          metadata: {
            ...(task.metadata ?? {}),
            ...(refund?.metadataPatch ?? {}),
            handbackReason: result.handbackReason ?? null,
          },
        });
        await this.recordAttemptOutcome(
          attemptId,
          refund ? "infra_handback" : result.status === "handback" ? "handback" : "failed",
          evidence,
          result,
        );
        const budget = refund
          ? `attempt refunded — ${refund.infraFaults}/${this.deps.policy.dispatch.maxInfraFaults} infrastructure faults, build attempts still ${refund.attempts}/${this.attemptCapFor(task)}`
          : `attempt ${task.attempts}/${this.attemptCapFor(task)}`;
        await this.postToReviewChannel(
          `Build task \`${task.id}\` on ${programme.key} came back ${target}: ${result.handbackReason ?? "no reason given"} (${budget}).`,
        );
        if (!refund) {
          // Infra faults teach nothing about the product; agent handbacks do.
          await this.remember(
            programme,
            "outcome",
            `Task ${task.id} ("${task.title}") came back ${target} on attempt ${task.attempts}: ${result.handbackReason ?? "no reason given"}.`,
            { taskId: task.id, status: target, attempts: task.attempts },
            0.7,
          );
        }
      }
    }
  }


  /**
   * Locate the workflow run for an attempt when no evidence row carries its
   * id, by scanning recent dispatches and asking each one's `programme-result`
   * which attempt it belongs to.
   *
   * Matching is on the artifact's own attemptId, which `readBuildResult`
   * already enforces — so a wrong candidate yields null and costs one API
   * call, never a mis-folded task. The run's display title is just the
   * workflow name, identical for every task, so there is
   * nothing cheaper to filter on.
   *
   * Bounded at SCAN_LIMIT candidates: this runs per stuck task per tick, and
   * an unbounded walk of a busy repo's history would be a slow loop that
   * never terminates usefully.
   */
  protected async findRunForAttempt(
    owner: string,
    repo: string,
    task: BuildTaskRecord,
    attemptId: string,
  ): Promise<number | null> {
    const find = this.deps.github.findDispatchedRun;
    if (!find) return null;

    // Tasks dispatched before dispatchedAt was recorded still need finding —
    // so fall back to a
    // wide window rather than skipping them.
    const stamp = (task.metadata ?? {})["dispatchedAt"];
    const since =
      typeof stamp === "string" && !Number.isNaN(Date.parse(stamp))
        ? new Date(Date.parse(stamp) - 60_000)
        : new Date(this.now().getTime() - RUN_SCAN_FALLBACK_WINDOW_MS);

    const seen: number[] = [];
    for (let i = 0; i < RUN_SCAN_LIMIT; i += 1) {
      const run = await find.call(
        this.deps.github,
        owner,
        repo,
        this.deps.policy.dispatch.workflowFile,
        since,
        seen,
      );
      if (!run) return null;
      // Guard the field rather than trusting it: this port is a structural
      // subset of the provider, reached through a cast, so a renamed field
      // would otherwise loop silently instead of failing.
      if (typeof run.runId !== "number") {
        this.warn(
          `findDispatchedRun returned no numeric runId for attempt ${attemptId} — cannot scan for its run`,
        );
        return null;
      }
      seen.push(run.runId);
      const result = await this.readBuildResult(owner, repo, run.runId, attemptId, true);
      if (result) {
        this.log(`Located run ${run.runId} for attempt ${attemptId} by scan (no evidence carried it)`);
        return run.runId;
      }
    }
    this.warn(
      `No run found for attempt ${attemptId} after scanning ${RUN_SCAN_LIMIT} dispatches of ` +
        `${this.deps.policy.dispatch.workflowFile} in ${owner}/${repo}`,
    );
    return null;
  }


  /**
   * Hands a task back when its run ended without a result artifact, so it can
   * be retried. Silent while the run is still in progress.
   *
   * Refunded as an infrastructure fault: a run that produced no result taught
   * nothing about the build, which is exactly the test `maxInfraFaults` exists
   * for. A cancelled run may have done real work, but none of it was judged.
   */
  /**
   * Hands back a task whose dispatch is older than any run could legitimately
   * be, so it stops holding a concurrency slot no result will ever free.
   *
   * This is the catch-all for the case nothing else can see: a run that ended
   * without posting evidence OR a result cannot be attributed to its attempt
   * at all, because `workflow_dispatch` returns no run id and both of the
   * other identifiers come off artifacts that run never uploaded.
   */
  /**
   * The number of a merged pull request opened from this task's own branch, or
   * null if there is none.
   *
   * `prNumber` records only the LATEST pull request, so it is not a reliable
   * answer to "did this task's work ever land" — a re-dispatch overwrites it.
   * The branch is the stable identity: the runner derives it from the task id
   * and reuses it across attempts.
   *
   * Excludes `ignore`, so the caller's own current PR is never mistaken for a
   * historical one.
   */
  protected async findMergedPrForTaskBranch(
    repo: RepoDescriptor,
    task: BuildTaskRecord,
    ignore: number | null,
  ): Promise<number | null> {
    const list = this.deps.github.listPullRequests;
    if (!list) return null;
    const branch = `lexi/${task.id.replace(/:/g, "-")}`;
    let candidates: Array<{ number: number }> | null = null;
    try {
      candidates = await list.call(this.deps.github, repo.organization, repo.repository, {
        state: "closed",
        head: branch,
        perPage: 20,
      });
    } catch (error) {
      this.warn(
        `Could not list pull requests for ${branch}: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return null;
    }
    if (!candidates) return null;
    for (const candidate of candidates) {
      if (candidate.number === ignore) continue;
      // The list payload carries no merged flag — only `closed`, which covers
      // both merged and abandoned — so each candidate has to be read.
      try {
        const full = await this.deps.github.getPullRequest(
          repo.organization,
          repo.repository,
          candidate.number,
        );
        if (full.merged) return candidate.number;
      } catch {
        continue;
      }
    }
    return null;
  }


  protected async handBackStaleDispatch(
    programme: ProgrammeRecord,
    task: BuildTaskRecord,
    status: BuildTaskStatusLike,
  ): Promise<void> {
    const stamp = (task.metadata ?? {})["dispatchedAt"];
    if (typeof stamp !== "string" || Number.isNaN(Date.parse(stamp))) {
      // Age is the only signal left at this point, and without a stamp there
      // is none — so the task can never become stale and never frees its slot.
      // Not handed back automatically: the stamp is written in the same update
      // as the DISPATCHED status, so a missing one means the row was damaged
      // rather than that the dispatch is old, and a task whose run is still
      // going would be re-armed underneath itself.
      this.warn(
        `${task.id} is ${status} with no dispatchedAt, so its age cannot be judged and it will never go stale on its own.`,
      );
      return;
    }
    const ageMs = this.now().getTime() - Date.parse(stamp);
    const limitMs = this.deps.policy.dispatch.staleDispatchMinutes * 60_000;
    if (ageMs <= limitMs) return;

    const minutes = Math.round(ageMs / 60_000);
    const reason = `no run reported back in ${minutes} minutes (limit ${this.deps.policy.dispatch.staleDispatchMinutes}) — the run was cancelled, timed out or never started`;
    await this.applyResultlessHandback(programme, task, status, reason);
  }


  /**
   * Rebuilds a task whose run SHIPPED a PR but whose red or green evidence
   * never reached the store.
   *
   * The result artifact is uploaded last, after every phase has posted, and
   * the artifact fallback has already run by the time a result is read — so a
   * shipped result over DISPATCHED or EVIDENCE_RED means a bundle was lost or
   * refused, not that it is on its way. Before this the fold fell through with
   * no transition and no log: the task sat DISPATCHED for ever, its PR was
   * never judged, and the conflict re-arm (which starts from PR_OPEN) could not
   * reach it. A green run whose RED bundle was refused by ingest (for example
   * over an over-long test name) would otherwise never move.
   *
   * Re-ingesting the lost bundle would not help: the gate orders red before
   * green by the store's receive clock, so red arriving now would read as red
   * AFTER green and be refused. A fresh attempt resumes the task's branch on
   * the current base and posts all three phases again.
   *
   * Refunded as an infrastructure fault: the agent built what it was asked to,
   * and it is the return channel that failed. Once maxInfraFaults is spent it
   * still re-arms, each rebuild charged to the build budget, until the attempt
   * cap; there it is handed back for a person. It does not fall through: there
   * is no older branch for this case, and falling through strands the task in
   * DISPATCHED, which is the defect this exists to fix.
   */
  protected async reArmOnIncompleteEvidence(
    programme: ProgrammeRecord,
    owner: string,
    repoName: string,
    task: BuildTaskRecord,
    status: BuildTaskStatusLike,
    phases: ReadonlySet<string>,
    evidence: RunEvidenceListRow[],
    result: ProgrammeBuildResult,
  ): Promise<void> {
    const missing = (["red", "green"] as const).filter((phase) => !phases.has(phase));
    const pr = result.prNumber ? `${owner}/${repoName}#${result.prNumber}` : "its PR";
    await this.reArmAsInfrastructureFault(programme, task, status, {
      reason: `${pr} shipped but its ${missing.join(" and ")} evidence never arrived`,
      consequence: "so its PR could not be judged",
      whenBudgetSpent: "rearm",
      prNumber: result.prNumber,
      evidence,
      result,
    });
  }


  /**
   * HANDBACK -> READY for a fault in the channel around the agent rather than
   * in its build, refunded from the infrastructure budget while it lasts.
   *
   * With that budget spent, `whenBudgetSpent` decides: `fall-through` writes
   * nothing and returns false, so the caller takes its own pre-existing path;
   * `rearm` re-arms anyway, charging the build budget, and at the attempt cap
   * hands back for a person. Returns true whenever it moved the task.
   *
   * The run's own evidence and result are recorded with the outcome: the
   * agent ran in full on both paths that reach here, and `result.tokenUsage`
   * is the only meter for phases no evidence bundle carries — dropping it
   * under-counted what these attempts cost.
   */
  protected async reArmAsInfrastructureFault(
    programme: ProgrammeRecord,
    task: BuildTaskRecord,
    status: BuildTaskStatusLike,
    options: {
      reason: string;
      consequence: string;
      whenBudgetSpent: "rearm" | "fall-through";
      prNumber?: number;
      evidence?: RunEvidenceListRow[];
      result?: ProgrammeBuildResult;
    },
  ): Promise<boolean> {
    const { reason, consequence, prNumber } = options;
    const refund = this.refundInfraFault(task, task.attempts, reason);
    if (!refund && options.whenBudgetSpent === "fall-through") return false;
    const cap = this.attemptCapFor(task);
    const rearm = refund !== null || task.attempts < cap;

    taskMachine.assertTransition(status, "HANDBACK");
    await this.deps.store.updateBuildTask(task.id, {
      status: "HANDBACK",
      ...(prNumber ? { prNumber } : {}),
      ...(refund ? { attempts: refund.attempts } : {}),
      metadata: {
        ...withoutRetryNote(task.metadata),
        ...(refund?.metadataPatch ?? {}),
        handbackReason: reason,
      },
    });
    if (task.currentAttemptId) {
      await this.recordAttemptOutcome(task.currentAttemptId, "infra_handback", options.evidence, options.result);
    }

    if (!rearm) {
      this.warn(`${task.id}: ${reason}, and it is at the attempt cap (${task.attempts}/${cap}) — a person retries this one.`);
      await this.postToReviewChannel(
        `Build task \`${task.id}\` on ${programme.key}: ${reason}. It is at its attempt cap, so it is handed back for a person to retry.`,
      );
      return true;
    }

    taskMachine.assertTransition("HANDBACK", "READY");
    await this.deps.store.updateBuildTask(task.id, { status: "READY" });
    const budget = refund
      ? `attempt refunded — ${refund.infraFaults}/${this.deps.policy.dispatch.maxInfraFaults} infrastructure faults, build attempts still ${refund.attempts}/${cap}`
      : `attempt ${task.attempts}/${cap} spent — no infrastructure budget left`;
    this.log(`Re-armed ${task.id}: ${reason}, so the next dispatch rebuilds it on the current base (${budget}).`);
    await this.postToReviewChannel(
      `Build task \`${task.id}\` on ${programme.key}: ${reason}, ${consequence}. Re-armed to rebuild on the current base — no action needed.`,
    );
    return true;
  }


  protected async applyResultlessHandback(
    programme: ProgrammeRecord,
    task: BuildTaskRecord,
    status: BuildTaskStatusLike,
    reason: string,
  ): Promise<void> {
    if (!taskMachine.canTransition(status, "HANDBACK")) {
      this.warn(`${task.id} is ${status} and ${reason}, but HANDBACK is not reachable from there.`);
      return;
    }
    // Refunded: a run that produced no result taught nothing about the build,
    // which is exactly what the infrastructure budget exists for.
    const refund = this.refundInfraFault(task, task.attempts, reason);
    taskMachine.assertTransition(status, "HANDBACK");
    await this.deps.store.updateBuildTask(task.id, {
      status: "HANDBACK",
      ...(refund ? { attempts: refund.attempts } : {}),
      metadata: {
        ...(task.metadata ?? {}),
        ...(refund?.metadataPatch ?? {}),
        handbackReason: reason,
      },
    });
    if (task.currentAttemptId) await this.recordAttemptOutcome(task.currentAttemptId, "no_result");
    this.log(`Handed ${task.id} back: ${reason}.`);
    await this.postToReviewChannel(
      `Build task \`${task.id}\` on ${programme.key}: ${reason}. Handed back so it can be retried.`,
    );
  }


  protected async handBackResultlessRun(
    programme: ProgrammeRecord,
    owner: string,
    repoName: string,
    task: BuildTaskRecord,
    status: BuildTaskStatusLike,
    runId: number,
  ): Promise<void> {
    const read = this.deps.github.getWorkflowRun;
    if (!read) return;
    let run: { status: string; conclusion: string | null } | null = null;
    try {
      run = await read.call(this.deps.github, owner, repoName, runId);
    } catch (error) {
      this.warn(
        `Run ${runId} for ${task.id} could not be read: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return;
    }
    // Still running, or unreadable — leave it alone and look again next tick.
    if (!run || run.status !== "completed") return;

    await this.applyResultlessHandback(
      programme,
      task,
      status,
      `run ${runId} ended without posting a result (conclusion: ${run.conclusion ?? "unknown"})`,
    );
  }


  protected async readBuildResult(
    owner: string,
    repo: string,
    runId: number,
    attemptId: string,
    /** Suppress the mismatch warning while scanning: a miss is expected there. */
    quiet = false,
  ): Promise<ProgrammeBuildResult | null> {
    try {
      const artifacts = await this.deps.github.listWorkflowRunArtifacts(owner, repo, runId);
      const artifact = artifacts.find((candidate) => candidate.name === RESULT_ARTIFACT_NAME);
      if (!artifact) return null;
      const zip = await this.deps.github.downloadWorkflowRunArtifact(owner, repo, artifact.id);
      const payloads = extractJsonObjectsFromZip(zip);
      const result = payloads.find(isProgrammeBuildResult);
      // A result claiming a different attempt is a correlation error, not a
      // result — refuse it loudly rather than fold the wrong task.
      if (result && result.attemptId !== attemptId) {
        if (!quiet) {
          this.warn(
            `lexi-result on run ${runId} claims attempt ${result.attemptId}, expected ${attemptId} — ignored`,
          );
        }
        return null;
      }
      return result ?? null;
    } catch (error) {
      this.warn(
        `Could not read ${RESULT_ARTIFACT_NAME} on ${owner}/${repo} run ${runId}: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return null;
    }
  }
}
