import {
  applyRefinements,
  deriveMilestonePlan,
  deriveSharedInfraTasks,
  screenSlug,
  sharedInfraTaskId,
  validateMilestonePlanAgainstShared,
  type PlannedTask,
  type PlanRefinement,
} from "../milestone-plan";
import { programmeWorkingBranch, repoSettingsFor } from "../load-programme-policy";
import { validateTaskGraph } from "../task-graph";
import type { BuildTaskRecord, MilestoneRecord, ProgrammeRecord } from "../programme-store";
import type { ProgrammeToolResult } from "./ports";
import {
  API_REFERENCE_MAX_BYTES,
  markdownSection,
  isCriteriaRescoped,
  programmeMachine,
  milestoneMachine,
  technicalSpecPath,
  milestoneTechnicalSpecPath,
  milestoneTechnicalSpecTaskId,
  specPathOf,
  programmeMetadata,
  FROM_SCRATCH_SCREEN_NAME,
  MAX_FROM_SCRATCH_SCREENS,
  type QueuedMilestonePlan,
} from "./helpers";
import { ProgrammeLifecycle } from "./programme-lifecycle";

/**
 * Milestone planning: appending milestones, proposing (or queueing) a
 * milestone's task graph from its approved spec and screen inventory, and
 * assembling the digest a technical spec is drafted from.
 */
export abstract class ProgrammePlanning extends ProgrammeLifecycle {

  /**
   * Append requester-named milestones to an existing programme.
   *
   * Milestones used to exist only as a side effect of commissioning, shaped
   * by Figma keys or a uiSource. A programme created without either had none,
   * and there was no path to add one, so `propose_milestone_plan` refused it
   * for ever and new scope could not land on a live programme either.
   */
  protected async addMilestones(args: Record<string, unknown>): Promise<ProgrammeToolResult> {
    const key = typeof args.programmeKey === "string" ? args.programmeKey : "";
    const titles = this.parseMilestoneTitles(args.milestones);
    const programme = await this.deps.store.getProgramme(key);
    if (!programme) return { ok: false, text: `No programme named ${key || "(missing key)"}.`, executed: false };
    if (titles.length === 0) {
      return { ok: false, text: "add_milestones needs at least one milestone with a title.", executed: false };
    }
    if (programmeMachine.isTerminal(programme.status)) {
      return {
        ok: false,
        text: `Programme ${key} is ${programme.status}; milestones are not added to a finished or cancelled programme.`,
        executed: false,
      };
    }
    // The hardening conclude gate checks findings, not milestones, so a
    // milestone added mid-hardening would stay PENDING while the programme
    // completed over it.
    if (programme.status === "HARDENING") {
      return {
        ok: false,
        text: `Programme ${key} is in HARDENING, which concludes to COMPLETE without looking at milestones — a milestone added now would never be built. Conclude the hardening and start new scope as a new programme, or file the work as hardening findings.`,
        executed: false,
      };
    }

    const existing = await this.deps.store.listMilestones(programme.id);
    // ordinal 0 is bookkeeping (hardening conclusion), never a deliverable.
    const lastOrdinal = existing.reduce((max, milestone) => Math.max(max, milestone.ordinal), 0);
    const takenIds = new Set(existing.map((milestone) => milestone.id));
    const added: MilestoneRecord[] = titles.map((milestoneTitle, index) => {
      const ordinal = lastOrdinal + index + 1;
      return {
        id: `${key}:m${ordinal}`,
        programmeId: programme.id,
        ordinal,
        title: milestoneTitle,
        status: "PENDING" as const,
        ...(programme.specId ? { specId: programme.specId } : {}),
      };
    });
    const clash = added.find((milestone) => takenIds.has(milestone.id));
    if (clash) {
      return { ok: false, text: `Milestone id ${clash.id} already exists on ${key}; nothing was added.`, executed: false };
    }
    await this.deps.store.createMilestones(added);

    // The id check above is check-then-write, and the Prisma store's
    // createMilestones is an upsert that keeps the existing row's title: two
    // concurrent calls mint the same ids and the second's titles vanish while
    // it reports success. Read back and report what actually landed.
    const after = await this.deps.store.listMilestones(programme.id);
    const titleById = new Map(after.map((milestone) => [milestone.id, milestone.title]));
    const lost = added.filter((milestone) => titleById.get(milestone.id) !== milestone.title);
    if (lost.length > 0) {
      return {
        ok: false,
        text:
          `Another change to ${key}'s milestones landed at the same time, so ${lost.length} of these were NOT added: ` +
          `${lost.map((m) => `"${m.title}"`).join(", ")}. Run get_programme_status to see what exists, then add only what is missing.`,
        executed: false,
      };
    }

    // A programme with no Figma keys has nothing to snapshot, so its
    // milestones are what makes it plannable. Figma-seeded programmes still
    // wait for a capture, exactly as before.
    let seededNote = "";
    if (programme.status === "PROPOSED" && programme.figmaFileKeys.length === 0) {
      programmeMachine.assertTransition("PROPOSED", "SEEDED");
      await this.deps.store.updateProgramme(key, { status: "SEEDED" });
      seededNote = " Programme is now SEEDED, ready to plan.";
    }
    // A working branch configured after commissioning is read live by dispatch, but was only
    // ever CREATED by start_app_rebuild — so dispatch would target a branch
    // that does not exist. Ensure it here and record it on the programme.
    // Until this runs, dispatch falls back to settings.baseBranch — or, under
    // a workingBranchPrefix (whose settings.baseBranch is null), to the
    // default branch. That is safe only because a programme cannot plan (so
    // cannot dispatch) before it has milestones, and this is where a
    // milestone-less programme gets them. A prefixed name is dated when this
    // runs, not when the programme was created. Recorded ONLY once the branch is
    // known to exist, so a failed creation is retried on the next call.
    const settings = repoSettingsFor(this.deps.policy, programme.targetRepoKey);
    const meta = programmeMetadata(programme);
    const targetRepo = this.deps.registry.resolveRepo(programme.targetRepoKey);
    let branchNote = "";
    // A `workingBranchPrefix` names this programme's own branch, dated today.
    const workingBranch = programmeWorkingBranch(settings, programme.key, this.now());
    if (workingBranch && !meta.baseBranch && targetRepo) {
      const branch = await this.ensureWorkingBranch(targetRepo, workingBranch);
      branchNote = ` ${branch.line}`;
      if (branch.ok) {
        await this.deps.store.updateProgramme(key, {
          metadata: { ...meta, baseBranch: workingBranch } as Record<string, unknown>,
        });
      }
    }
    await this.syncTrackingIssue(programme);

    // The next one to plan is the earliest milestone nobody has planned yet,
    // which on a live programme is not necessarily one of these.
    const nextToPlan = after
      .filter((milestone) => milestone.ordinal > 0 && milestone.status === "PENDING")
      .sort((a, b) => a.ordinal - b.ordinal)[0];
    return {
      ok: true,
      text:
        `Added ${added.length} milestone(s) to ${key}: ${added.map((m) => `\`${m.id}\` ${m.title}`).join("; ")}.${seededNote}${branchNote}` +
        ` Nothing is dispatched yet${nextToPlan ? ` — plan ${nextToPlan.id} next with propose_milestone_plan` : ""}.`,
      executed: true,
    };
  }


  /**
   * `propose_milestone_plan` with `deferred: true`: record the plan instead of
   * making it. The advance job makes it later (`planQueuedMilestone`), once the
   * spec is approved and every earlier milestone's build is complete, so the
   * requester queues every milestone once and nobody has to come back and ask
   * for the next. Checked now only for what cannot change by then: the
   * milestone exists and is unplanned, and names a spec and its screens.
   */
  protected async queueMilestonePlan(args: Record<string, unknown>, actor: string): Promise<ProgrammeToolResult> {
    const programmeKey = typeof args.programmeKey === "string" ? args.programmeKey : "";
    const milestoneId = typeof args.milestoneId === "string" ? args.milestoneId : "";
    const screenStates = Array.isArray(args.screenStates)
      ? args.screenStates
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : [];
    const programme = await this.deps.store.getProgramme(programmeKey);
    if (!programme) return { ok: false, text: `No programme named ${programmeKey}.`, executed: false };
    if (!repoSettingsFor(this.deps.policy, programme.targetRepoKey).autoPlanQueuedMilestones) {
      return {
        ok: false,
        text: `${programme.targetRepoKey} does not plan queued milestones (repoSettings autoPlanQueuedMilestones is off). Plan this milestone now instead: propose_milestone_plan without deferred.`,
        executed: false,
      };
    }
    const milestone = await this.deps.store.getMilestone(milestoneId);
    if (!milestone || milestone.programmeId !== programme.id) {
      return { ok: false, text: `No milestone ${milestoneId} on programme ${programmeKey}.`, executed: false };
    }
    const planned = (await this.deps.store.listBuildTasks(programme.id)).some((task) => task.milestoneId === milestone.id);
    if (milestone.status !== "PENDING" || planned) {
      return {
        ok: false,
        text: `${milestone.id} is already planned (${milestone.status}); a queued plan would never run. Re-plan it with propose_milestone_plan without deferred.`,
        executed: false,
      };
    }
    const specId = (typeof args.specId === "string" ? args.specId.trim() : "") || milestone.specId || "";
    if (!specId || specId === programme.specId) {
      return {
        ok: false,
        text: `Queue ${milestone.id} with the specId of its own milestone spec; the programme spec alone carries no criteria for its screens.`,
        executed: false,
      };
    }
    if (screenStates.length === 0) {
      return {
        ok: false,
        text: `Queue ${milestone.id} with its screenStates. Without them the plan would cover every screen the inventory knows, not this milestone's slice.`,
        executed: false,
      };
    }

    const meta = programmeMetadata(programme);
    const queued: QueuedMilestonePlan = { specId, screenStates, queuedBy: actor, queuedAt: this.now().toISOString() };
    await this.deps.store.updateProgramme(programme.key, {
      metadata: { ...meta, queuedPlans: { ...(meta.queuedPlans ?? {}), [milestone.id]: queued } } as Record<string, unknown>,
    });
    if (milestone.specId !== specId) await this.deps.store.updateMilestone(milestone.id, { specId });
    const approved = await this.deps.specs.loadApprovedSpec(specId);
    return {
      ok: true,
      text:
        `Queued ${milestone.id} (spec ${specId}${approved ? ` rev ${approved.revision}` : ", not approved yet"}; ${screenStates.length} screens: ${screenStates.join(", ")}). ` +
        `The advance job plans it once its spec is approved and every earlier milestone's build is complete. Screen names are checked against the inventory then, and a refusal is posted to the review channel. Nothing is dispatched now.`,
      executed: true,
    };
  }


  /**
   * The advance job's half of a queued plan: plan the EARLIEST queued
   * milestone once every earlier deliverable milestone's build is complete
   * and its spec is approved. One per tick, and only in order, because the
   * approved rollout ships milestones one at a time. A refusal is posted once
   * (kept as `lastRefusal`) and retried each tick, so fixing the cause — a
   * spec approved, a screen re-queued — lets it through without a nudge.
   */
  protected async planQueuedMilestone(programme: ProgrammeRecord): Promise<void> {
    const settings = repoSettingsFor(this.deps.policy, programme.targetRepoKey);
    if (!settings.autoPlanQueuedMilestones) return;
    const queuedPlans = programmeMetadata(programme).queuedPlans ?? {};
    if (Object.keys(queuedPlans).length === 0) return;

    const milestones = (await this.deps.store.listMilestones(programme.id))
      .filter((milestone) => milestone.ordinal > 0)
      .sort((a, b) => a.ordinal - b.ordinal);
    const tasks = await this.deps.store.listBuildTasks(programme.id);
    const next = milestones.find(
      (milestone) => milestone.status === "PENDING" && !tasks.some((task) => task.milestoneId === milestone.id),
    );
    if (!next) return;
    const queued = queuedPlans[next.id];
    // The next unplanned milestone has no queued plan: it waits for a person,
    // and so does everything after it — planning past it would break order.
    if (!queued) return;
    const buildComplete: MilestoneRecord["status"][] =
      this.deps.policy.milestoneReview.mode === "notify" ? ["EVIDENCE_COMPLETE", "IN_REVIEW", "APPROVED"] : ["APPROVED"];
    if (!milestones.filter((m) => m.ordinal < next.ordinal).every((m) => buildComplete.includes(m.status))) return;
    // Not approved yet is waiting, not a refusal.
    if (!(await this.deps.specs.loadApprovedSpec(queued.specId))) return;

    const result = await this.proposeMilestonePlan({
      programmeKey: programme.key,
      milestoneId: next.id,
      specId: queued.specId,
      screenStates: queued.screenStates,
    });
    // Planning rewrites the programme (status, tracking-issue hash), so the
    // queue is edited on a fresh read, never on the copy this tick started with.
    const fresh = (await this.deps.store.getProgramme(programme.key)) ?? programme;
    const freshMeta = programmeMetadata(fresh);
    const remaining = { ...(freshMeta.queuedPlans ?? {}) };
    if (result.ok) {
      delete remaining[next.id];
      await this.deps.store.updateProgramme(programme.key, {
        metadata: { ...freshMeta, queuedPlans: remaining } as Record<string, unknown>,
      });
      this.log(`Auto-planned queued milestone ${next.id} on ${programme.key}`);
      await this.postToReviewChannel(`Planned ${next.id} on \`${programme.key}\` from its queued plan: every earlier milestone's build is complete. ${result.text}`);
      return;
    }
    if (remaining[next.id] && remaining[next.id]!.lastRefusal !== result.text) {
      remaining[next.id] = { ...remaining[next.id]!, lastRefusal: result.text };
      await this.deps.store.updateProgramme(programme.key, {
        metadata: { ...freshMeta, queuedPlans: remaining } as Record<string, unknown>,
      });
      this.warn(`Queued plan for ${next.id} on ${programme.key} refused: ${result.text}`);
      await this.postToReviewChannel(
        `Could not plan queued milestone ${next.id} on \`${programme.key}\`: ${result.text} Re-queue it with propose_milestone_plan (deferred: true) once fixed; later milestones wait behind it.`,
      );
    }
  }


  protected async proposeMilestonePlan(args: Record<string, unknown>): Promise<ProgrammeToolResult> {
    const programmeKey = typeof args.programmeKey === "string" ? args.programmeKey : "";
    const milestoneId = typeof args.milestoneId === "string" ? args.milestoneId : "";
    const specId = typeof args.specId === "string" ? args.specId : "";
    const requestedScreens = Array.isArray(args.screenStates)
      ? args.screenStates
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : [];
    // Parsed defensively, the same way screenStates is: the tool schema is a
    // contract with a model, not a guarantee about what arrives.
    const refinements: PlanRefinement[] = Array.isArray(args.refinements)
      ? args.refinements.flatMap((value) => {
          if (typeof value !== "object" || value === null) return [];
          const candidate = value as Record<string, unknown>;
          const op = candidate.op;
          if (op !== "split" && op !== "add_dependency" && op !== "retitle") return [];
          if (typeof candidate.taskId !== "string" || typeof candidate.detail !== "string") return [];
          return [{ op, taskId: candidate.taskId.trim(), detail: candidate.detail }];
        })
      : [];

    const programme = await this.deps.store.getProgramme(programmeKey);
    if (!programme) return { ok: false, text: `No programme named ${programmeKey}.`, executed: false };
    const milestone = await this.deps.store.getMilestone(milestoneId);
    if (!milestone || milestone.programmeId !== programme.id) {
      return { ok: false, text: `No milestone ${milestoneId} on programme ${programmeKey}.`, executed: false };
    }

    // The plan derives from an APPROVED spec — same rule as
    // trigger_code_task(feature): approval is what licenses build work. In
    // autopilot the programme-level spec is the fallback for every milestone.
    const effectiveSpecId = specId || milestone.specId || programme.specId || "";
    if (!effectiveSpecId) {
      return {
        ok: false,
        text: "This milestone has no spec yet. Run a spec session for it, get it approved, then pass specId here.",
        executed: false,
      };
    }
    const spec = await this.deps.specs.loadApprovedSpec(effectiveSpecId);
    if (!spec) {
      return {
        ok: false,
        text: `Spec ${effectiveSpecId} has no APPROVED revision — approval is what licenses build planning.`,
        executed: false,
      };
    }
    if (spec.acceptanceCriteria.length === 0) {
      return {
        ok: false,
        text: `Approved spec ${effectiveSpecId} rev ${spec.revision} carries no AC-… criteria — a plan without provable criteria would make the evidence loop vacuous.`,
        executed: false,
      };
    }

    // Scope comes from design-context screens and/or configured uiSource
    // prototype routes. Scope never comes from a production parity inventory,
    // even if an older programme still carries referenceRepoKey. A thin cover-page design file alone yields that one
    // frame; operators who need a real first milestone pass `screenStates`
    // (or configure uiSources so prototype routes supply the inventory).
    const designContextId = programme.designContextId ?? "";
    const context = designContextId ? await this.deps.store.getDesignContext(designContextId) : null;
    const designScreens = (context?.states ?? []).map((state) => state.state);

    // Always empty (no parity floor) — kept as a named empty list so slice
    // resolution still unions design + uiSource without a special case.
    const parityScreens: string[] = [];

    let screenStates = designScreens;
    let scopeSource = "design-context prototype";

    // Prototype IMPLEMENTATION's routes when the repo has a configured
    // uiSource. Route paths under the prototype's app directory are the
    // screen names — intent/flow reference for the coding agent, not a
    // component port source.
    const uiSourceRepo = this.deps.policy.uiSources?.[programme.targetRepoKey]
      ? this.deps.registry.resolveRepo(this.deps.policy.uiSources[programme.targetRepoKey]!.repoKey)
      : null;
    const uiSourceScreens = await this.uiSourceScreens(programme);
    if (screenStates.length === 0 && uiSourceScreens.length > 0) {
      screenStates = uiSourceScreens;
      scopeSource = `prototype routes of ${uiSourceRepo?.slug ?? "the configured uiSource"} (${uiSourceScreens.length} screens; intent reference only)`;
    }

    // Operator-selected slice.
    //
    // Names are RESOLVED against the inventory, never taken on trust: an
    // unrecognised name is refused with candidates rather than planned as a
    // screen nothing knows about.
    const availableScreens = [...designScreens, ...parityScreens, ...uiSourceScreens];
    // Built from scratch: no design snapshot and no prototype routes, so
    // there is no inventory to resolve names against. The requester's own
    // screen names ARE the scope, taken as given (deduplicated). Resolution
    // below still applies whenever an inventory exists, so a typo against a
    // real prototype is refused exactly as before.
    //
    // Keyed on how the programme is CONFIGURED, not on an empty inventory: a
    // Figma programme whose snapshot came back empty (a cover page) or a
    // uiSources entry naming an unregistered repo also has an
    // empty inventory, and both must keep refusing names nothing backs.
    const fromScratch =
      programme.figmaFileKeys.length === 0 &&
      !programme.designContextId &&
      !this.deps.policy.uiSources?.[programme.targetRepoKey];
    if (fromScratch && requestedScreens.length > 0) {
      // No inventory canonicalises these, and each one lands verbatim in the
      // coding agent's trustedInstruction and in a task id, so they are held
      // to a screen-name shape and deduped on the slug the task id uses.
      const refused: string[] = [];
      const bySlug = new Map<string, string>();
      for (const name of requestedScreens) {
        const slug = screenSlug(name);
        if (!FROM_SCRATCH_SCREEN_NAME.test(name) || slug === "") {
          refused.push(name);
          continue;
        }
        if (!bySlug.has(slug)) bySlug.set(slug, name);
      }
      if (refused.length > 0 || bySlug.size > MAX_FROM_SCRATCH_SCREENS) {
        return {
          ok: false,
          text:
            refused.length > 0
              ? `Screen names must be 1–64 letters, digits, spaces, ( ) / _ or -, so nothing was planned. Refused: ${refused
                  .slice(0, 10)
                  .map((name) => JSON.stringify(name.slice(0, 80)))
                  .join(", ")}.`
              : `${bySlug.size} screens is more than one milestone should carry (max ${MAX_FROM_SCRATCH_SCREENS}); split it across milestones.`,
          executed: false,
        };
      }
      screenStates = [...bySlug.values()];
      scopeSource = `requester-named screens, built from scratch against the spec (no prototype routes or design snapshot for ${programme.targetRepoKey})`;
    } else if (requestedScreens.length > 0) {
      const canonicalByLower = new Map<string, string>();
      for (const name of availableScreens) {
        const key = name.trim().toLowerCase();
        if (!canonicalByLower.has(key)) canonicalByLower.set(key, name);
      }

      const resolved: string[] = [];
      const unknown: string[] = [];
      const seen = new Set<string>();
      for (const requested of requestedScreens) {
        const canonical = canonicalByLower.get(requested.toLowerCase());
        if (!canonical) {
          unknown.push(requested);
          continue;
        }
        if (!seen.has(canonical)) {
          seen.add(canonical);
          resolved.push(canonical);
        }
      }

      if (unknown.length > 0) {
        return {
          ok: false,
          text: this.describeUnknownScreens(unknown, availableScreens, scopeSource),
          executed: false,
        };
      }

      // Measured against what WOULD have been planned, not against the union
      // of both sources. The union is what is selectable — the right
      // denominator for the refusal above — but the obligation is the scope
      // source, and conflating them understates how much of the floor is
      // left out.
      const fullScopeCount = screenStates.length;
      screenStates = resolved;
      scopeSource =
        `operator-selected slice of ${scopeSource}: ${resolved.length} of ${fullScopeCount} screen(s)` +
        (resolved.length < fullScopeCount
          ? `. The other ${fullScopeCount - resolved.length} screens are NOT in this milestone`
          : "");
    }

    if (screenStates.length === 0) {
      return {
        ok: false,
        text:
          "This milestone has nothing to plan from: the design-context snapshot has no screens, and " +
          (uiSourceRepo
            ? `no routes could be read from the prototype ${uiSourceRepo.slug} (the GitHub App may lack Contents:read on it).`
            : "no uiSource is configured for this repo in programme-policy.yaml, so nothing supplies screen names.") +
          (uiSourceRepo
            ? " Configure uiSources (prototype intent reference) or capture design context; production parity floors are not used."
            : " To build this milestone from scratch, pass its screens in screenStates (e.g. \"login\", \"signup\", \"home\"); production parity floors are not used."),
        executed: false,
      };
    }

    const platform = programme.platform ?? "web_ai";
    const settings = repoSettingsFor(this.deps.policy, programme.targetRepoKey);
    const shared = deriveSharedInfraTasks({
      programmeKey: programme.key,
      platform,
      requireTechnicalSpec: settings.requireTechnicalSpec,
    });
    const milestonePlan = deriveMilestonePlan({
      programmeKey: programme.key,
      milestoneId: milestone.id,
      screenStates,
      acceptanceCriterionIds: spec.acceptanceCriteria.map((criterion) => criterion.id),
      platform,
    });
    // Operator refinements to the deterministic skeleton. Advertised on this
    // tool since it was written and never implemented — `refinements` reached
    // the schema and two comments, and nothing read it, so a caller splitting
    // an oversized screen task got a success reply and the unchanged plan.
    // Applied BEFORE validation, so a refinement that would break the graph is
    // refused here rather than persisted.
    const refined = applyRefinements(milestonePlan, refinements);
    if (refined.rejected.length > 0) {
      return {
        ok: false,
        text:
          `Refinement refused, so nothing was planned:\n` +
          refined.rejected.map((line) => `- ${line}`).join("\n"),
        executed: false,
      };
    }
    // A milestone after the one that owns the programme's technical spec
    // writes a spec of its own, and its screens wait for a person to merge
    // it. Without this, M2..Mn would build to a document that never covered
    // their screens: the programme spec is shared infra, written once.
    const priorTasks = await this.deps.store.listBuildTasks(programme.id);
    const programmeSpecTask = priorTasks.find((task) => task.id === sharedInfraTaskId(programme.key, "technical-spec"));
    const milestoneSpecTask: PlannedTask | null =
      settings.requireTechnicalSpec && programmeSpecTask && programmeSpecTask.milestoneId !== milestone.id
        ? {
            id: milestoneTechnicalSpecTaskId(programme.key, milestone.id),
            kind: "technical-spec",
            title: `Technical spec for milestone ${milestone.ordinal}: extends the programme spec for its screens`,
            // After the programme's, so it extends an approved document.
            dependsOn: [programmeSpecTask.id],
            status: "PENDING",
            acceptanceCriterionIds: [],
            screenStates: [],
            testKinds: [],
          }
        : null;
    const milestoneSpecPath = milestoneSpecTask ? milestoneTechnicalSpecPath(programme.key, milestone.ordinal) : null;
    const refinedPlan = milestoneSpecTask
      ? [
          milestoneSpecTask,
          ...refined.plan.map((task) =>
            task.kind === "screen" && !task.dependsOn.includes(milestoneSpecTask.id)
              ? { ...task, dependsOn: [...task.dependsOn, milestoneSpecTask.id] }
              : task,
          ),
        ]
      : refined.plan;

    let combined: PlannedTask[];
    try {
      combined = validateMilestonePlanAgainstShared(shared, refinedPlan);
    } catch (error) {
      return {
        ok: false,
        text: `Derived plan is invalid: ${error instanceof Error ? error.message : "unknown"}`,
        executed: false,
      };
    }
    // The programme graph may already hold shared infra (and other
    // milestones' tasks). Re-validate against the live store so a second
    // milestone's dependsOn resolve to the existing shared ids.
    const existing = await this.deps.store.listBuildTasks(programme.id);
    const existingById = new Map(existing.map((task) => [task.id, task]));
    const graphNodes = [
      ...existing.map((task) => ({ id: task.id, dependsOn: task.dependsOn, status: task.status })),
      ...combined
        .filter((task) => !existingById.has(task.id))
        .map((task) => ({ id: task.id, dependsOn: task.dependsOn, status: task.status })),
    ];
    // Refresh dependsOn for tasks we are about to upsert (re-plan).
    for (const task of combined) {
      const node = graphNodes.find((candidate) => candidate.id === task.id);
      if (node) node.dependsOn = task.dependsOn;
    }
    const validation = validateTaskGraph(graphNodes);
    if (!validation.valid) {
      return { ok: false, text: `Derived plan is invalid: ${validation.problems.join("; ")}`, executed: false };
    }

    const toRecord = (task: PlannedTask, milestoneId: string): BuildTaskRecord => ({
      id: task.id,
      programmeId: programme.id,
      milestoneId,
      title: task.title,
      status: "PENDING",
      dependsOn: task.dependsOn,
      codeRepoKey: programme.targetRepoKey,
      acceptanceCriterionIds: task.acceptanceCriterionIds,
      designContextNodeIds: [],
      attempts: 0,
      metadata: {
        testKinds: task.testKinds,
        screenStates: task.screenStates,
        kind: task.kind,
        ...(milestoneSpecTask && task.id === milestoneSpecTask.id ? { specPath: milestoneSpecPath } : {}),
      },
    });

    // Shared infra is upserted once, attached to the first milestone that
    // needs it. Later milestones only add their screen/integration/e2e rows
    // and depend on the existing shared ids — never re-create scaffold/
    // design-bindings/data-layer (which would multiply cost and drift tokens).
    // Existing shared rows are upserted too: the update path refreshes only
    // structure (title, deps, criteria, structural metadata) and never their
    // status or attempts, so a re-plan is also the repair path for a task
    // whose metadata was never written.
    // A task a person re-scoped (set_task_criteria) keeps that set: the plan
    // re-derives criteria round-robin, and writing it back would silently undo
    // the decision that let its PR merge.
    const keptRescopes: string[] = [];
    const specIds = new Set(spec.acceptanceCriteria.map((criterion) => criterion.id));
    const droppedBySpec = new Set<string>();
    const emptiedRescopes: string[] = [];
    // Ids a re-scoped task owns are pinned to it: the round-robin must not also
    // hand them to a sibling (one criterion, two owners).
    const pinnedToRescoped = new Set(
      [...existingById.values()]
        .filter((task) => task.status !== "CANCELLED" && isCriteriaRescoped(task))
        .flatMap((task) => task.acceptanceCriterionIds),
    );
    const records = [
      ...shared.map((task) => toRecord(task, existingById.get(task.id)?.milestoneId ?? milestone.id)),
      ...refinedPlan.map((task) => toRecord(task, milestone.id)),
    ].map((record) => {
      const prior = existingById.get(record.id);
      const derived = { ...record, acceptanceCriterionIds: record.acceptanceCriterionIds.filter((id) => !pinnedToRescoped.has(id)) };
      if (!prior || prior.status === "CANCELLED" || !isCriteriaRescoped(prior)) return derived;
      // Kept, but only what the spec being planned still has: an id the new
      // spec dropped could never be bound, and would refuse the PR for ever.
      const kept = prior.acceptanceCriterionIds.filter((id) => specIds.has(id));
      for (const id of prior.acceptanceCriterionIds) if (!specIds.has(id)) droppedBySpec.add(id);
      if (kept.length === 0) {
        // Nothing of the re-scope survives the new spec. An empty set would let
        // the gate pass the PR having proved nothing, so the task falls back to
        // the freshly derived set and the requester is told to re-scope.
        emptiedRescopes.push(record.id);
        return derived;
      }
      keptRescopes.push(record.id);
      return { ...record, acceptanceCriterionIds: kept };
    });
    if (droppedBySpec.size > 0) await this.addDeferredCriteria(programme.key, [...droppedBySpec]);
    if (keptRescopes.length > 0) {
      this.log(`Re-plan of ${milestone.id} kept re-scoped criteria on ${keptRescopes.join(", ")}.`);
    }
    await this.deps.store.upsertBuildTasks(records);
    // upsertBuildTasks keeps non-structural metadata, so the marker has to be
    // cleared explicitly: otherwise the fallback (round-robin) set is pinned
    // as a person's choice and the criteria map can never correct it.
    for (const id of emptiedRescopes) {
      const row = await this.deps.store.getBuildTask(id);
      if (!row) continue;
      const rowMeta = (row.metadata ?? {}) as Record<string, unknown>;
      const voided = Array.isArray(rowMeta.criteriaRescopesVoided) ? rowMeta.criteriaRescopesVoided : [];
      await this.deps.store.updateBuildTask(id, {
        metadata: {
          ...rowMeta,
          criteriaRescopes: [],
          criteriaRescopesVoided: [...voided, ...(Array.isArray(rowMeta.criteriaRescopes) ? rowMeta.criteriaRescopes : [])].slice(-20),
        },
      });
    }
    if (milestone.specId !== effectiveSpecId) {
      await this.deps.store.updateMilestone(milestone.id, { specId: effectiveSpecId });
    }
    if (milestone.status === "PENDING") {
      milestoneMachine.assertTransition("PENDING", "READY");
      await this.deps.store.updateMilestone(milestone.id, { status: "READY" });
    } else if (milestone.status === "CHANGES_REQUESTED") {
      // Re-planning after a rejected review is the rework path resuming.
      milestoneMachine.assertTransition("CHANGES_REQUESTED", "IN_PROGRESS");
      await this.deps.store.updateMilestone(milestone.id, { status: "IN_PROGRESS" });
    }
    if (programme.status === "SEEDED") {
      programmeMachine.assertTransition("SEEDED", "PLANNED");
      await this.deps.store.updateProgramme(programme.key, { status: "PLANNED" });
    }

    const sharedToInsert = shared.filter((task) => !existingById.has(task.id));
    const sharedNote =
      sharedToInsert.length > 0
        ? ` (plus ${sharedToInsert.length} programme-level shared infra tasks, done once)`
        : " (reusing programme-level shared infra)";
    const techSpecNote = !settings.requireTechnicalSpec
      ? ""
      : milestoneSpecPath
        ? ` This milestone writes its own technical spec first (${milestoneSpecPath}), extending ${technicalSpecPath(programme.key)} for its screens; its screens wait until a human merges that PR into ${programmeMetadata(programme).baseBranch ?? settings.baseBranch ?? "the default branch"}, after which its criteria are re-assigned from that document's "Acceptance criteria by screen" table.`
        : ` The first task to dispatch is the technical spec (${technicalSpecPath(programme.key)}); every other task waits until a human merges its PR into ${programmeMetadata(programme).baseBranch ?? settings.baseBranch ?? "the default branch"}, after which the criteria are re-assigned to screens from its "Acceptance criteria by screen" table.`;
    await this.syncTrackingIssue(programme);
    return {
      ok: true,
      text:
        `Planned ${refinedPlan.length} tasks for ${milestone.id} from spec ${effectiveSpecId} rev ${spec.revision} (${spec.acceptanceCriteria.length} criteria, ${screenStates.length} screens from ${scopeSource})${sharedNote}. Dispatch starts on the next advance tick${this.deps.flags.dispatchEnabled ? "" : " once PROGRAMME_DISPATCH_ENABLED is on"}.${techSpecNote}` +
        // Named explicitly: this tool accepted refinements and silently
        // ignored them for its whole life, and a success line that does not
        // say what it did is exactly how that survived.
        (refined.applied.length > 0
          ? `\n\nRefinements applied:\n${refined.applied.map((line) => `- ${line}`).join("\n")}`
          : "") +
        (keptRescopes.length > 0
          ? `\n\nKept the criteria a person set with set_task_criteria on ${keptRescopes.join(", ")}; call it again to change them.` +
            (droppedBySpec.size > 0
              ? ` ${droppedBySpec.size} of those ids are not in spec ${effectiveSpecId} and were dropped to the deferred list (${[...droppedBySpec].slice(0, 6).join(", ")}${droppedBySpec.size > 6 ? ", …" : ""}).`
              : "")
          : "") +
        (emptiedRescopes.length > 0
          ? `\n\nNone of the re-scoped criteria on ${emptiedRescopes.join(", ")} are in spec ${effectiveSpecId}, so they took the freshly planned set instead of owning nothing; re-scope them with set_task_criteria.`
          : ""),
      executed: true,
    };
  }


  /**
   * The digest the technical spec is drafted from, for the Slack agent to
   * judge what is genuinely unknown before asking anyone. Reads only; the
   * order is the order of trust the technical-spec brief states.
   */
  protected async prepareTechnicalSpec(args: Record<string, unknown>): Promise<ProgrammeToolResult> {
    const key = typeof args.programmeKey === "string" ? args.programmeKey : "";
    const programme = await this.deps.store.getProgramme(key);
    if (!programme) return { ok: false, text: `No programme named ${key}.`, executed: false };
    const repo = this.deps.registry.resolveRepo(programme.targetRepoKey);
    const settings = repoSettingsFor(this.deps.policy, programme.targetRepoKey);
    const meta = programmeMetadata(programme);
    const baseRef = meta.baseBranch ?? settings.baseBranch ?? repo?.defaultBranch ?? "main";
    const lines: string[] = [`*Technical-spec inputs for ${programme.title}* (\`${key}\`, ${programme.status})`];

    // 1. The approved business spec.
    const spec = programme.specId ? await this.deps.specs.loadApprovedSpec(programme.specId) : null;
    if (spec) {
      lines.push(
        `*Business spec* ${spec.specId} rev ${spec.revision}: ${spec.acceptanceCriteria.length} acceptance criteria. Every one must land on exactly one screen in the technical spec's table.`,
      );
      for (const criterion of spec.acceptanceCriteria) {
        lines.push(`  • ${criterion.id} ${criterion.text.length > 220 ? `${criterion.text.slice(0, 217)}…` : criterion.text}`);
      }
    } else {
      lines.push(`*Business spec*: none approved yet (${programme.specId ? `spec ${programme.specId} has no APPROVED revision` : "no specId on the programme"}). Nothing can be planned or drafted until it is.`);
    }
    // Milestones governed by a spec of their own. The programme spec's rules
    // reach their briefs as context; the milestone spec's criteria are what
    // they build, and each milestone after the first writes its own technical
    // spec extending the programme's.
    const milestones = (await this.deps.store.listMilestones(programme.id)).filter((m) => m.ordinal > 0);
    const allTasks = await this.deps.store.listBuildTasks(programme.id);
    const milestoneLines: string[] = [];
    for (const m of milestones.sort((a, b) => a.ordinal - b.ordinal)) {
      if (!m.specId || m.specId === programme.specId) continue;
      const own = await this.deps.specs.loadApprovedSpec(m.specId);
      const ownSpecTask = allTasks.find((t) => t.id === milestoneTechnicalSpecTaskId(key, m.id));
      milestoneLines.push(
        `  • M${m.ordinal} "${m.title}": spec ${m.specId}${own ? ` rev ${own.revision}, ${own.acceptanceCriteria.length} criteria` : " (not approved yet)"}; technical spec ${ownSpecTask ? `${specPathOf(key, ownSpecTask)} (${ownSpecTask.status.toLowerCase()})` : `the programme's (${technicalSpecPath(key)})`}`,
      );
    }
    if (milestoneLines.length > 0) {
      lines.push(`*Milestone specs* (each governed by the programme spec above):`, ...milestoneLines);
    }

    // 2. The prototype's screens.
    const uiSourceConfig = this.deps.policy.uiSources?.[programme.targetRepoKey];
    const uiSourceRepo = uiSourceConfig ? this.deps.registry.resolveRepo(uiSourceConfig.repoKey) : null;
    const screens = await this.uiSourceScreens(programme);
    if (uiSourceRepo) {
      lines.push(
        screens.length > 0
          ? `*Prototype* ${uiSourceRepo.slug}@${uiSourceConfig!.ref}: ${screens.length} routes (these are the screen names propose_milestone_plan accepts): ${screens.join(", ")}`
          : `*Prototype* ${uiSourceRepo.slug}@${uiSourceConfig!.ref}: its route tree could not be read (GitHub App Contents:read on that repo?), so no screen names are available.`,
      );
    } else {
      lines.push(`*Prototype*: no uiSource configured for ${programme.targetRepoKey} — the UI is built from scratch; name each milestone's screens in propose_milestone_plan screenStates.`);
    }

    // 3. The API contract.
    const contract = this.deps.apiContracts ? await this.deps.apiContracts.latest() : null;
    if (contract) {
      const byTag = new Map<string, number>();
      for (const operation of contract.operations) {
        const tag = operation.tags[0] ?? "(untagged)";
        byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
      }
      const tags = [...byTag.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => `${tag} (${count})`);
      lines.push(
        `*API contract* ${contract.info.title} ${contract.info.version}: ${contract.operations.length} operations after filtering, by tag: ${tags.join(", ")}. Base ${this.deps.policy.apiContract?.baseUrl || "(unset)"}; auth ${this.deps.policy.apiContract?.authBaseUrl || "(unset)"}. Fixture-only: ${(this.deps.policy.apiContract?.fixtureOnlyPatterns ?? []).join(", ") || "none"}.`,
      );
      const authOps = contract.operations.filter((operation) =>
        /auth|login|signup|otp|identity|client\/lookup|session|password|social|oidc|kratos/i.test(`${operation.path} ${operation.tags.join(" ")} ${operation.summary ?? ""}`),
      );
      if (authOps.length > 0) {
        lines.push(`  Identity/registration-looking operations (${authOps.length}): ${authOps.slice(0, 40).map((o) => `${o.method.toUpperCase()} ${o.path}`).join("; ")}${authOps.length > 40 ? "; …" : ""}`);
      }
    } else {
      lines.push(`*API contract*: no snapshot captured. The technical spec would have to stub every backend call.`);
    }

    // 3b. Supplementary API documentation — read fresh, because this is what
    // a person reads before committing to a plan.
    for (const reference of await this.resolveApiReferences(true)) {
      if ("unreadable" in reference) {
        lines.push(`*API reference* "${reference.title}" (${reference.repoSlug}/${reference.path}@${reference.ref}): UNREADABLE — ${reference.unreadable}. Briefs will not carry it until that is fixed.`);
        continue;
      }
      const document = await this.apiReferenceDocument(reference.index, reference.sha);
      if (!document) {
        lines.push(`*API reference* "${reference.title}" (${reference.repoSlug}/${reference.path}@${reference.ref}): blob ${reference.sha.slice(0, 7)} could not be read (over ${API_REFERENCE_MAX_BYTES / 1024 / 1024} MB, or not text). Briefs will cite it but the runner will not get it.`);
        continue;
      }
      const headings = document.markdown
        .split(/\r?\n/)
        .filter((line) => /^##\s/.test(line))
        .map((line) => line.replace(/^##\s*/, "").trim());
      lines.push(
        `*API reference* "${reference.title}" (${reference.repoSlug}/${reference.path}@${reference.ref}, blob ${reference.sha.slice(0, 7)}, ${Math.round(document.markdown.length / 1024)} KB) — attached to every brief; the technical-spec task maps journeys to contract operations with it. Sections: ${headings.slice(0, 20).join(" · ")}`,
      );
      const conflicts = markdownSection(document.markdown, /conflict|limitation/i);
      if (conflicts) {
        lines.push(
          `  Its conflicts register — a conflict on a journey this slice builds is a question for the requester unless a decision already settles it:\n${conflicts.length > 6000 ? `${conflicts.slice(0, 6000)}\n  … (truncated; the full register is in the document)` : conflicts}`,
        );
      }
    }

    // 4. Engineering standards in the rebuild repo.
    if (repo) {
      try {
        const standards = await this.deps.github.getFileContents(repo.organization, repo.repository, "docs/technical-standards/README.md", baseRef);
        const headings = standards ? standards.split(/\r?\n/).filter((line) => /^#{1,3}\s/.test(line)).map((line) => line.replace(/^#+\s*/, "").trim()).slice(0, 30) : [];
        lines.push(
          standards
            ? `*Engineering standards* docs/technical-standards/ on ${repo.slug}@${baseRef}: ${headings.join(" · ")}`
            : `*Engineering standards*: docs/technical-standards/README.md is not on ${repo.slug}@${baseRef} — the technical spec chooses the stack itself and records why.`,
        );
        const existing = await this.deps.github.getFileContents(repo.organization, repo.repository, technicalSpecPath(key), baseRef);
        lines.push(
          existing
            ? `*Technical spec*: ${technicalSpecPath(key)} ALREADY exists on ${baseRef} (${existing.length} chars) — a new technical-spec task would revise it.`
            : `*Technical spec*: not written yet (${technicalSpecPath(key)} absent on ${baseRef}). The technical-spec task writes it; a human merges the PR.`,
        );
      } catch (error) {
        lines.push(`*Rebuild repo* ${repo.slug}@${baseRef} could not be read: ${error instanceof Error ? error.message : "unknown"}.`);
      }
    }

    // 5. What has been decided, and what Lexi remembers.
    const decisions = meta.decisions ?? [];
    lines.push(
      decisions.length > 0
        ? `*Decisions recorded* (${decisions.length}): ${decisions.map((d) => `${d.topic} — ${d.decision}`).join("; ")}`
        : "*Decisions recorded*: none yet. Anything the requester settles now goes in with record_programme_decision.",
    );
    const remembered = await this.recallForTask(
      programme,
      { id: `${key}:technical-spec`, title: "technical spec", status: "PENDING", programmeId: programme.id, milestoneId: "", dependsOn: [], codeRepoKey: programme.targetRepoKey, acceptanceCriterionIds: [], designContextNodeIds: [], attempts: 0 },
      screens,
    );
    lines.push(remembered ? `*Memory*:\n${remembered}` : "*Memory*: nothing recorded yet for this repo (or memory is disabled).");

    lines.push(
      `*Settings*: working branch \`${baseRef}\`; exploratory sweep ${settings.requireExploratorySweep ? "required" : "OFF (no preview; owner verifies locally)"}; technical spec ${settings.requireTechnicalSpec ? "required (first task)" : "not required"}; tracking issue ${meta.trackingIssue?.url ?? (settings.trackingIssue ? "to be opened" : "off")}; parity floor from a reference repo: ${programme.referenceRepoKey ?? "none"}.`,
    );
    lines.push(
      "Ask the requester ONLY what these inputs cannot settle — an operation a journey needs that the contract lacks, a documented API conflict on a journey in scope, a prototype screen the criteria do not describe, a stack choice the standards leave open. Record answers with record_programme_decision, then propose_milestone_plan with the screenStates for the slice.",
    );
    return { ok: true, text: lines.join("\n"), executed: false };
  }
}
