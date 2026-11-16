import type { AutoMergeVerdict, RepoDescriptor } from "@lexi/contracts";
import { classifyBranch } from "@lexi/governance";
import { sharedInfraTaskId } from "../milestone-plan";
import { deriveAcStatuses } from "../ac-matrix-evaluate";
import { evaluateAutoMergeGate } from "../auto-merge-gate";
import { refundForMergeConflict } from "../attempt-accounting";
import type { BuildTaskRecord, ProgrammeRecord } from "../programme-store";
import { withoutRetryNote, taskMachine, specPathOf, parseBindings, MERGE_CONFLICT_REASON } from "./helpers";
import { ProgrammeFold } from "./programme-fold";

/**
 * The auto-merge executor and its re-arms. Reachable only from the advance
 * tick, never from a tool: the model has no merge tool. Every gate fails
 * closed with a persisted, named reason.
 */
export abstract class ProgrammeMerge extends ProgrammeFold {

  /* ---------------------------------------------------------- auto-merge */

  /**
   * The auto-merge executor. Ordered gates, each
   * failing closed with a persisted named reason. NEVER reachable from
   * `invokeTool` — the model has no merge tool.
   */
  protected async tryAutoMerge(
    programme: ProgrammeRecord,
    owner: string,
    repoName: string,
    task: BuildTaskRecord,
  ): Promise<boolean> {
    const refusals = this.autoMergeRefusals(task);

    if (refusals.length > 0) {
      // Say it out loud. The verdict is persisted, but nothing reads that row:
      // there is no tool for it and no endpoint, so a refusing gate was
      // indistinguishable from a gate that never ran, and green PRs could sit
      // unmerged with not one line in the log to say why.
      this.warn(
        `Auto-merge of ${owner}/${repoName}#${task.prNumber ?? "?"} (task ${task.id}) refused before the evidence gate: ${refusals.join("; ")}`,
      );
      // Verdicts are computed and persisted even when merging is off — that
      // is how phase 3 shakes the gate out with humans still merging.
      await this.persistVerdict(task, {
        allowed: false,
        reasons: refusals,
        requiredChecks: [],
        acMatrix: [],
        redBeforeGreen: false,
      });
      return false;
    }
    return this.tryAutoMergeWithEvidence(programme, owner, repoName, task);
  }


  /**
   * Gates 1–4 of every executor merge: the env and policy switches, the
   * repo's programme tier and allowlist, and the repo-scoped action
   * classification. Shared by task PRs and milestone technical specs, so a
   * document never merges where a task could not.
   */
  protected autoMergeRefusals(task: BuildTaskRecord): string[] {
    const refusals: string[] = [];

    // Gate 1+2: both env halves and both YAML halves.
    if (!this.deps.flags.programmeEnabled || !this.deps.flags.autoMergeEnabled) {
      refusals.push("env flags off (PROGRAMME_ENABLED / PROGRAMME_AUTO_MERGE_ENABLED)");
    }
    if (!this.deps.policy.enabled || !this.deps.policy.autoMerge.enabled) {
      refusals.push("policy off (programme-policy.yaml enabled / autoMerge.enabled)");
    }
    // Gate 3: tier + allowlist.
    if (!this.deps.registry.isAutonomous(task.codeRepoKey)) {
      refusals.push(`repo ${task.codeRepoKey} is not autonomyTier: autonomous`);
    }
    if (!this.deps.policy.programmes.allowedRepoKeys.includes(task.codeRepoKey)) {
      refusals.push(`repo ${task.codeRepoKey} is not in programmes.allowedRepoKeys`);
    }
    return refusals;
  }


  protected async tryAutoMergeWithEvidence(
    programme: ProgrammeRecord,
    owner: string,
    repoName: string,
    task: BuildTaskRecord,
  ): Promise<boolean> {
    const prNumber = task.prNumber;
    if (!prNumber || !task.currentAttemptId) {
      this.warn(
        `Auto-merge of task ${task.id} skipped: ${!prNumber ? "no PR number on the row" : "no current attempt on the row"}.`,
      );
      return false;
    }

    const pr = await this.deps.github.getPullRequest(owner, repoName, prNumber);

    const evidence = await this.deps.evidence.listByAttempt(task.currentAttemptId);
    // Per app. The bindings file is the app's own, so in a repo holding
    // several it is `<workdir>/.lexi/ac-bindings.json`. Reading the root path
    // there returns null, which parses to no bindings, which fails
    // requireAcMatrixGreen — so this fails CLOSED rather than open, and the
    // symptom would have been auto-merge never firing for either app with a
    // verdict blaming the acceptance criteria. Resolved from
    // `task.codeRepoKey`, deliberately: the key identifies the app, and the
    // slug no longer does.
    //
    // The per-task shard first; the shared file is the fallback so every PR
    // opened before sharding still reads, and a task that writes both is
    // read from the shard.
    let bindingsRaw: string | null = null;
    if (pr.headSha) {
      bindingsRaw = await this.deps.github.getFileContents(
        owner,
        repoName,
        this.bindingsShardPath(task.codeRepoKey, task.id),
        pr.headSha,
      );
      if (!bindingsRaw) {
        bindingsRaw = await this.deps.github.getFileContents(
          owner,
          repoName,
          this.lexiPath(task.codeRepoKey, "ac-bindings.json"),
          pr.headSha,
        );
      }
    }
    const bindings = parseBindings(bindingsRaw);

    // Gate 5: the pure evidence gate.
    const verdict = evaluateAutoMergeGate({
      evidence: evidence.map((row) => ({
        phase: row.phase as "red" | "green" | "refactor" | "checks",
        checks: row.checks as never,
        failingTests: row.failingTests as never,
        ...(row.commitSha ? { commitSha: row.commitSha } : {}),
        receivedAt: row.receivedAt,
      })),
      acceptanceCriterionIds: task.acceptanceCriterionIds,
      acStatuses: deriveAcStatuses(task.acceptanceCriterionIds, bindings),
      policy: this.deps.policy.autoMerge,
      pr: {
        headSha: pr.headSha ?? "",
        open: pr.state === "open" && !pr.merged,
        ...(pr.mergeable != null ? { mergeable: pr.mergeable } : {}),
      },
    });
    await this.persistVerdict(task, verdict);
    if (!verdict.allowed) {
      this.warn(
        `Auto-merge of ${owner}/${repoName}#${prNumber} (task ${task.id}) refused by the evidence gate: ${verdict.reasons.join("; ")}`,
      );
      await this.reArmOnMergeConflict(programme, task, verdict, owner, repoName, prNumber);
      await this.reArmOnFailedChecks(programme, task, verdict, owner, repoName, prNumber);
      return false;
    }

    // Gate 6a: the standing rule that Lexi does not land code on a default
    // branch. A programme PR is opened against its repo's default branch, so
    // in practice this refuses every auto-merge — which is the intent.
    //
    // Placed HERE, after the evidence gate rather than before it, on purpose.
    // The gate's verdict is still computed and persisted exactly as it was, so
    // it keeps being exercised while humans do the merging — the property the
    // comment above `persistVerdict` already asks for. Refusing earlier would
    // have skipped the AC-bindings read and left the gate untested.
    //
    // A CODE gate, not another flag: this capability was previously reached
    // through PROGRAMME_AUTO_MERGE_ENABLED, and a capability whose only revoke
    // is an env var comes back the moment somebody flips it chasing an
    // unrelated problem. Re-enabling it means changing this rule on purpose, in
    // a diff a reviewer can see.
    //
    // Fails closed on an unreadable base, matching `merge_pull_request`.
    const baseRef = typeof pr.baseRef === "string" ? pr.baseRef.trim() : "";
    const baseVerdict = baseRef
      ? classifyBranch(baseRef, this.deps.registry.resolveRepo(task.codeRepoKey)?.defaultBranch)
      : null;
    if (!baseRef || baseVerdict?.protected) {
      this.warn(
        baseRef
          ? `Auto-merge of ${owner}/${repoName}#${prNumber} refused: "${baseRef}" is a default or trunk branch. A person merges it.`
          : `Auto-merge of ${owner}/${repoName}#${prNumber} refused: its base branch could not be confirmed.`,
      );
      return false;
    }

    // Gate 6 happened inside the verdict's PR sanity; Gate 7: merge pinned
    // to the SHA the evidence described — GitHub 409s if the head moved.
    try {
      const result = await this.deps.github.mergePullRequest(owner, repoName, prNumber, {
        sha: pr.headSha ?? undefined,
        commitTitle: `${task.title} (programme auto-merge, task ${task.id})`,
      });
      if (!result.merged) {
        this.warn(`Auto-merge of ${owner}/${repoName}#${prNumber} did not merge: ${result.message}`);
        return false;
      }
      taskMachine.assertTransition("PR_OPEN", "MERGED");
      await this.deps.store.updateBuildTask(task.id, {
        status: "MERGED",
        mergedSha: result.sha ?? pr.headSha ?? null,
      });
      await this.postToReviewChannel(
        `Auto-merged ${owner}/${repoName}#${prNumber} (task \`${task.id}\`, programme \`${programme.key}\`) — gate verdict: all checks green, AC matrix green, red-before-green proven.`,
      );
      await this.remember(
        programme,
        "outcome",
        `Task ${task.id} ("${task.title}") shipped as ${owner}/${repoName}#${prNumber} on attempt ${task.attempts}; all checks and the AC matrix were green.`,
        { taskId: task.id, prNumber, attempts: task.attempts },
        0.5,
      );
      return true;
    } catch (error) {
      this.warn(
        `Auto-merge of ${owner}/${repoName}#${prNumber} failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return false;
    }
  }


  /**
   * A later milestone's technical spec, merged by the executor where the repo
   * opts in (repoSettings `autoMergeMilestoneTechnicalSpecs`). A document has
   * no evidence, so the evidence gate cannot judge it; what stands in for it
   * is that the business spec behind it is approved, the programme's own
   * technical spec (the architecture) was merged by a person, and the PR is
   * open, mergeable and aimed at the working branch. Gates 1–4 and the
   * trunk-branch rule are the same ones every task merge passes, and the
   * merge is pinned to the head SHA read here.
   */
  protected async tryAutoMergeMilestoneSpec(
    programme: ProgrammeRecord,
    repo: RepoDescriptor,
    task: BuildTaskRecord,
  ): Promise<boolean> {
    const prNumber = task.prNumber;
    if (!prNumber) return false;
    const refusals = this.autoMergeRefusals(task);
    if (refusals.length > 0) {
      this.warn(`Auto-merge of milestone technical spec ${repo.slug}#${prNumber} (task ${task.id}) refused: ${refusals.join("; ")}`);
      return false;
    }
    const programmeSpec = (await this.deps.store.listBuildTasks(programme.id)).find(
      (candidate) => candidate.id === sharedInfraTaskId(programme.key, "technical-spec"),
    );
    if (programmeSpec && programmeSpec.status !== "MERGED" && programmeSpec.status !== "VERIFIED" && programmeSpec.status !== "CANCELLED") {
      return false;
    }
    const milestone = await this.deps.store.getMilestone(task.milestoneId);
    if (!milestone?.specId || !(await this.deps.specs.loadApprovedSpec(milestone.specId))) {
      this.warn(`Milestone technical spec ${repo.slug}#${prNumber} (task ${task.id}) not merged: its milestone has no approved spec.`);
      return false;
    }

    const pr = await this.deps.github.getPullRequest(repo.organization, repo.repository, prNumber);
    if (pr.state !== "open" || pr.merged) return false;
    if (pr.mergeable !== true) {
      // null is GitHub still computing; false is a conflict. Both wait: the
      // spec is a single new document, so a conflict is rare and a person
      // resolving it is cheaper than a rebuild.
      if (pr.mergeable === false) this.warn(`Milestone technical spec ${repo.slug}#${prNumber} (task ${task.id}) is not mergeable; waiting.`);
      return false;
    }
    const baseRef = typeof pr.baseRef === "string" ? pr.baseRef.trim() : "";
    if (!baseRef || classifyBranch(baseRef, repo.defaultBranch).protected) {
      this.warn(
        baseRef
          ? `Milestone technical spec ${repo.slug}#${prNumber} targets "${baseRef}", a default or trunk branch. A person merges it.`
          : `Milestone technical spec ${repo.slug}#${prNumber}: its base branch could not be confirmed. A person merges it.`,
      );
      return false;
    }

    try {
      const result = await this.deps.github.mergePullRequest(repo.organization, repo.repository, prNumber, {
        sha: pr.headSha ?? undefined,
        commitTitle: `${task.title} (programme auto-merge, milestone technical spec, task ${task.id})`,
      });
      if (!result.merged) {
        this.warn(`Auto-merge of milestone technical spec ${repo.slug}#${prNumber} did not merge: ${result.message}`);
        return false;
      }
      taskMachine.assertTransition("PR_OPEN", "MERGED");
      await this.deps.store.updateBuildTask(task.id, { status: "MERGED", mergedSha: result.sha ?? pr.headSha ?? null });
      await this.postToReviewChannel(
        `Auto-merged milestone technical spec \`${specPathOf(programme.key, task)}\` (${repo.slug}#${prNumber}, programme \`${programme.key}\`): its business spec is approved and the programme's technical spec was merged by a person. Its criteria are re-assigned from its table on the next tick, and its screens dispatch after that.`,
      );
      await this.remember(
        programme,
        "outcome",
        `Milestone technical spec ${task.id} merged as ${repo.slug}#${prNumber} by the executor — the technical spec at ${specPathOf(programme.key, task)} is approved and binding.`,
        { taskId: task.id, prNumber, mergedBy: "executor" },
        0.9,
      );
      return true;
    } catch (error) {
      this.warn(
        `Auto-merge of milestone technical spec ${repo.slug}#${prNumber} failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return false;
    }
  }


  protected async persistVerdict(task: BuildTaskRecord, verdict: AutoMergeVerdict): Promise<void> {
    await this.deps.store.updateBuildTask(task.id, { lastMergeVerdict: verdict });
  }


  /**
   * A task PR that conflicts with its base is merge ORDER, not a build
   * failure. Programme dispatches shared and screen tasks in parallel from
   * ONE base, and every task writes `.lexi/ac-bindings.json`, `.lexi/
   * testids.json` and `BUILD_LOG.md` — so whichever merges second always
   * collides. The gate then refuses it ("not mergeable") and the task sits in
   * PR_OPEN forever: `retry_build_task` refuses anything that is not
   * HANDBACK/FAILED, and nothing else in the tool set moves it.
   *
   * Re-arming is the whole repair, because the runner already does the work:
   * `Derive task branch` resumes `lexi/<task>` and merges the dispatch base
   * into it (falling back to a clean base when that conflicts), and the PR
   * step EDITS an existing open PR rather than opening a second one. So a
   * re-dispatch rebuilds on the current base and the new result carries a
   * head SHA the gate can match.
   *
   * Only when non-mergeability is the ONLY complaint. A PR that also has a
   * failing check has a real problem, and silently re-running it would bury
   * that behind a rebuild.
   */
  /**
   * Re-arms a task whose PR is refused ONLY because a required check reported
   * `failed`, so the agent gets another pass at making its own checks pass.
   *
   * Without this such a task is stranded exactly as a conflicting one used to
   * be: the gate refuses it every tick and logs the same line for ever, and
   * `retry_build_task` refuses anything that is not HANDBACK or FAILED, so no
   * tool can move it either: it would be refused with "required check unit:
   * failed" on every advance, going nowhere.
   *
   * Unlike a merge conflict this DOES spend an attempt. A failing unit check
   * is the task's own build being wrong, which is precisely what the build
   * budget is for — so a task that cannot make its checks pass terminates
   * rather than rebuilding for ever.
   *
   * Restricted to `failed` and not `missing`: a missing check means the
   * evidence never arrived, which is the symptom of an ingest defect rather
   * than of bad code, and rebuilding on it would hide the defect.
   */
  protected async reArmOnFailedChecks(
    programme: ProgrammeRecord,
    task: BuildTaskRecord,
    verdict: AutoMergeVerdict,
    owner: string,
    repoName: string,
    prNumber: number,
  ): Promise<void> {
    if (task.status !== "PR_OPEN") return;
    if (verdict.reasons.length === 0) return;
    if (!verdict.reasons.every((reason) => /^required check .+: failed$/.test(reason))) return;

    const cap = this.attemptCapFor(task);
    if (task.attempts >= cap) {
      this.warn(
        `${owner}/${repoName}#${prNumber} (task ${task.id}) still fails its own checks at the attempt cap (${task.attempts}/${cap}) — a person takes this one.`,
      );
      return;
    }

    const failing = verdict.reasons.join("; ");
    taskMachine.assertTransition("PR_OPEN", "HANDBACK");
    await this.deps.store.updateBuildTask(task.id, {
      status: "HANDBACK",
      metadata: { ...withoutRetryNote(task.metadata), handbackReason: failing },
    });
    taskMachine.assertTransition("HANDBACK", "READY");
    await this.deps.store.updateBuildTask(task.id, { status: "READY" });

    this.log(
      `Re-armed ${task.id}: ${owner}/${repoName}#${prNumber} fails its own checks (${failing}), so the next dispatch resumes its branch and fixes them (attempt ${task.attempts}/${cap} spent).`,
    );
    await this.postToReviewChannel(
      `Build task \`${task.id}\` on ${programme.key}: ${owner}/${repoName}#${prNumber} is refused because ${failing}. Re-armed so the agent can fix it — no action needed.`,
    );
  }


  protected async reArmOnMergeConflict(
    programme: ProgrammeRecord,
    task: BuildTaskRecord,
    verdict: AutoMergeVerdict,
    owner: string,
    repoName: string,
    prNumber: number,
  ): Promise<void> {
    if (task.status !== "PR_OPEN") return;
    if (verdict.reasons.length !== 1 || verdict.reasons[0] !== MERGE_CONFLICT_REASON) return;

    const cap = this.attemptCapFor(task);
    const conflictCap = this.deps.policy.dispatch.maxConflictRearms;

    // A conflict tests nothing about the build. The task built correctly and
    // went green; a SIBLING merged first and moved the base underneath it. So
    // the re-arm refunds its attempt, out of its own bounded budget — without
    // that, a programme that is merging well spends every task's build budget
    // on its neighbours' success, and the last PR in a wide milestone strands
    // at the cap having never once failed.
    const conflictMetadata = (task.metadata ?? {}) as Record<string, unknown>;
    const priorRearms =
      typeof conflictMetadata.conflictRearms === "number" ? conflictMetadata.conflictRearms : 0;
    const refund = refundForMergeConflict({
      storedAttempts: task.attempts,
      priorConflictRearms: priorRearms,
      maxConflictRearms: conflictCap,
    });

    if (!refund && task.attempts >= cap) {
      this.warn(
        `${owner}/${repoName}#${prNumber} (task ${task.id}) conflicts with its base, has spent its ${conflictCap} conflict re-arms and is at the attempt cap (${task.attempts}/${cap}) — a person resolves this one.`,
      );
      return;
    }

    taskMachine.assertTransition("PR_OPEN", "HANDBACK");
    await this.deps.store.updateBuildTask(task.id, {
      status: "HANDBACK",
      ...(refund ? { attempts: refund.attempts } : {}),
      metadata: {
        ...withoutRetryNote(task.metadata),
        ...(refund ? { conflictRearms: refund.conflictRearms } : {}),
        handbackReason: "merge conflict with the base branch",
      },
    });
    taskMachine.assertTransition("HANDBACK", "READY");
    await this.deps.store.updateBuildTask(task.id, { status: "READY" });

    const budget = refund
      ? `attempt refunded — ${refund.conflictRearms}/${conflictCap} conflict re-arms, build attempts still ${refund.attempts}/${cap}`
      : `attempt ${task.attempts}/${cap} spent — no conflict budget left`;
    this.log(
      `Re-armed ${task.id}: ${owner}/${repoName}#${prNumber} conflicts with its base, so the next dispatch resumes its branch on the current base (${budget}).`,
    );
    await this.postToReviewChannel(
      `Build task \`${task.id}\` on ${programme.key}: ${owner}/${repoName}#${prNumber} conflicts with \`${task.codeRepoKey}\`'s working branch after another task merged first. Re-armed to rebuild on the current base — no action needed.`,
    );
  }
}
