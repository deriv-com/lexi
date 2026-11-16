import type { ProgrammeStatus } from "@lexi/contracts";
import { programmeWorkingBranch, repoSettingsFor } from "../load-programme-policy";
import { benchArmOf, isBenchTask, withoutBenchTasks } from "../model-bench-plan";
import type { MilestoneRecord, ProgrammeRecord } from "../programme-store";
import type { ProgrammeToolResult } from "./ports";
import {
  LIVE_PROGRAMME_STATUSES,
  programmeMachine,
  gateRefusalLine,
  programmeMetadata,
  type ProgrammeDecision,
  type ProgrammeMetadata,
} from "./helpers";
import { ProgrammeEngineBase } from "./engine-base";

/**
 * Programme lifecycle commands: commissioning a programme, reporting its
 * status, pausing, resuming, cancelling, and recording human decisions.
 */
export abstract class ProgrammeLifecycle extends ProgrammeEngineBase {

  protected async startProgramme(
    args: Record<string, unknown>,
    actor: string,
    ctx: { channel?: string; threadTs?: string },
  ): Promise<ProgrammeToolResult> {
    const targetRepoKey = typeof args.targetRepoKey === "string" ? args.targetRepoKey : "";
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const sourceSpecIssue = typeof args.sourceSpecIssue === "string" ? args.sourceSpecIssue : "";
    const figmaFileKeys = Array.isArray(args.figmaFileKeys)
      ? args.figmaFileKeys.filter((key): key is string => typeof key === "string")
      : [];

    const milestoneTitles = this.parseMilestoneTitles(args.milestones);
    if (milestoneTitles.length > 0 && figmaFileKeys.length > 0) {
      return {
        ok: false,
        text: "Pass either figmaFileKeys (one milestone per file) or milestones, not both — each would define the milestone list.",
        executed: false,
      };
    }

    if (!targetRepoKey || !title) {
      return {
        ok: false,
        text: "start_app_rebuild needs targetRepoKey and title.",
        executed: false,
      };
    }
    if (!this.deps.policy.programmes.allowedRepoKeys.includes(targetRepoKey)) {
      return {
        ok: false,
        text: `Repo ${targetRepoKey} is not in programme-policy.yaml programmes.allowedRepoKeys.`,
        executed: false,
      };
    }
    if (!this.deps.registry.isAutonomous(targetRepoKey)) {
      return {
        ok: false,
        text: `Repo ${targetRepoKey} is not registered with autonomyTier: autonomous in config/repos.yaml.`,
        executed: false,
      };
    }

    // OPTIONAL provenance — a pointer for humans, never an input to a build.
    // Nothing reads the issue: the spec a runner actually compiles against
    // reaches it through `specId` (an APPROVED spec session), resolved in
    // briefForAttempt. This value is stored and echoed by get_programme_status
    // so a reader can find the document a programme came from, and that is its
    // whole job.
    //
    // It is optional because a spec can live as files in the target repo, and
    // requiring it would force someone to invent an issue that no code path
    // would ever open.
    let sourceSpecRepoKey: string | null = null;
    let sourceSpecIssueNumber: number | null = null;
    let specIssueLine: string | undefined;
    if (sourceSpecIssue) {
      const specMatch = sourceSpecIssue.match(/^([a-zA-Z0-9_]+)#(\d+)$/);
      if (!specMatch) {
        return {
          ok: false,
          text: `sourceSpecIssue must be '<repoKey>#<issueNumber>', got "${sourceSpecIssue}".`,
          executed: false,
        };
      }
      const [, specRepoKey, issueNumberText] = specMatch;
      const specRepo = this.deps.registry.resolveRepo(specRepoKey);
      if (!specRepo) {
        return {
          ok: false,
          text: `sourceSpecIssue names unregistered repo key ${specRepoKey}.`,
          executed: false,
        };
      }
      sourceSpecRepoKey = specRepoKey;
      sourceSpecIssueNumber = Number(issueNumberText);
      specIssueLine = await this.describeSpecIssue(specRepo.slug, sourceSpecIssueNumber);
    }

    const key = this.slugify(title);
    const existing = await this.deps.store.getProgramme(key);
    if (existing) {
      return {
        ok: false,
        text: `Programme ${key} already exists (status ${existing.status}). Use get_programme_status or pick another title.`,
        executed: false,
      };
    }

    // One live programme per target repository. The check above is keyed on
    // the TITLE, so a differently-worded title for the same rebuild sailed
    // straight past it: two programmes against one repo, each generating its
    // own Phase-0 scaffold into the same workdir and racing to open PRs
    // against one default branch. Terminal programmes never block — see
    // LIVE_PROGRAMME_STATUSES.
    const live = await this.deps.store.listProgrammesByStatus(LIVE_PROGRAMME_STATUSES);
    const occupied = live.find((candidate) => candidate.targetRepoKey === targetRepoKey);
    if (occupied) {
      return {
        ok: false,
        text:
          `Programme \`${occupied.key}\` (${occupied.status}) already targets ${targetRepoKey}. ` +
          `Two programmes on one repo build the same scaffold into the same directory, so this is refused. ` +
          `Run \`get_programme_status ${occupied.key}\` to see where it stands — new scope belongs on it as a ` +
          `milestone. To replace it instead, cancel it first.`,
        executed: false,
      };
    }

    // Autopilot: ONE programme-level APPROVED spec licenses every milestone
    // (milestone specs derive from it by section). Optional in `gate` mode,
    // where each milestone still gets its own human-approved spec.
    const specId = typeof args.specId === "string" ? args.specId.trim() : "";
    if (specId) {
      const approved = await this.deps.specs.loadApprovedSpec(specId);
      if (!approved) {
        return {
          ok: false,
          text: `Spec ${specId} has no APPROVED revision — approval is what licenses a programme-level spec.`,
          executed: false,
        };
      }
    } else if (this.deps.policy.milestoneReview.mode === "notify") {
      return {
        ok: false,
        text: "Autopilot (milestoneReview.mode: notify) needs a programme-level APPROVED spec: run a spec session seeded from the source spec issue, get it approved once, then pass its specId here.",
        executed: false,
      };
    }

    // The engine does not attach a production parity floor: a rebuild is
    // judged against its approved spec and the prototype's intent, not against
    // an existing app's route list. `referenceRepos` in the policy is ignored.
    const referenceRepoKey: string | null = null;
    const targetRepo = this.deps.registry.resolveRepo(targetRepoKey);
    const settings = repoSettingsFor(this.deps.policy, targetRepoKey);
    const uiSourceConfigured = Boolean(this.deps.policy.uiSources?.[targetRepoKey]);
    // Shared (`baseBranch`) or this programme's own dated branch
    // (`workingBranchPrefix`). Stored on the programme, which every later read
    // prefers, so a policy change never moves a running programme.
    const workingBranch = programmeWorkingBranch(settings, key, this.now());
    const metadata: ProgrammeMetadata = {
      ...(workingBranch ? { baseBranch: workingBranch } : {}),
      ...(ctx.channel && ctx.threadTs ? { originThreadKey: `${ctx.channel}:${ctx.threadTs}` } : {}),
      decisions: [],
    };
    const programme: ProgrammeRecord = {
      id: this.mintId(),
      key,
      title,
      status: "PROPOSED",
      targetRepoKey,
      platform: targetRepo?.platform ?? null,
      sourceSpecRepoKey,
      sourceSpecIssueNumber,
      figmaFileKeys,
      ...(specId ? { specId } : {}),
      referenceRepoKey,
      createdBy: actor,
      metadata: metadata as Record<string, unknown>,
    };
    await this.deps.store.createProgramme(programme);

    // Working branch. Created from the default
    // branch once, here, so the first dispatch already has somewhere to check
    // out and open its PR against. Reported, never hidden: a programme whose
    // branch could not be created dispatches against nothing.
    let branchLine: string | undefined;
    if (workingBranch && targetRepo) {
      branchLine = (await this.ensureWorkingBranch(targetRepo, workingBranch)).line;
    }

    // No parity floor (see above): never snapshot a production app.
    const parityLine =
      "No production parity floor — rebuilds are judged against the approved spec and the prototype's intent only.";

    // One milestone per prototype journey — each Figma file is one journey
    // and gets its own milestone-scoped, human-approved spec before any task
    // can be planned against it.
    //
    // With NO Figma keys and a configured uiSource (the prototype
    // implementation is the design source), the programme gets ONE milestone
    // whose screens are chosen at planning time from the prototype's routes.
    // This exists because a design file that is only a cover page plans one
    // screen task for a whole app.
    //
    // Requester-named milestones win over both. Without them a repo with no
    // Figma keys and no uiSource (the UI is built from scratch) would get ZERO
    // milestones, and since nothing else creates one, every
    // propose_milestone_plan on it would be refused for good.
    const milestones: MilestoneRecord[] =
      milestoneTitles.length > 0
        ? milestoneTitles.map((milestoneTitle, index) => ({
            id: `${key}:m${index + 1}`,
            programmeId: programme.id,
            ordinal: index + 1,
            title: milestoneTitle,
            status: "PENDING" as const,
            ...(specId ? { specId } : {}),
          }))
        : figmaFileKeys.length > 0
        ? figmaFileKeys.map((fileKey, index) => ({
            id: `${key}:m${index + 1}`,
            programmeId: programme.id,
            ordinal: index + 1,
            title: `Journey ${index + 1} (${fileKey})`,
            status: "PENDING" as const,
            // Autopilot: every milestone is governed by the programme-level spec.
            ...(specId ? { specId } : {}),
          }))
        : uiSourceConfigured
          ? [
              {
                id: `${key}:m1`,
                programmeId: programme.id,
                ordinal: 1,
                title: `Milestone 1: ${title}`,
                status: "PENDING" as const,
                ...(specId ? { specId } : {}),
              },
            ]
          : [];
    if (milestones.length > 0) {
      await this.deps.store.createMilestones(milestones);
    }
    // Nothing to snapshot when there are no Figma keys: either the prototype
    // checkout is the design source, or the requester named the milestones
    // and the UI is built from the spec. Either way it is ready to plan.
    const seededWithoutSnapshot = figmaFileKeys.length === 0 && (uiSourceConfigured || milestones.length > 0);
    if (seededWithoutSnapshot) {
      programmeMachine.assertTransition("PROPOSED", "SEEDED");
      await this.deps.store.updateProgramme(key, { status: "SEEDED" });
    }

    // The programme's status board: one GitHub issue in the rebuild repo.
    // Its checklist is regenerated by the advance
    // job from the task rows, so it is a VIEW of the programme, never a
    // second source of truth someone has to keep in step by hand.
    let trackingLine: string | undefined;
    if (settings.trackingIssue && targetRepo) {
      trackingLine = await this.openTrackingIssue({ ...programme, status: seededWithoutSnapshot ? "SEEDED" : "PROPOSED" }, milestones);
    }

    // Seed: capture a design-context snapshot per prototype. Best-effort per
    // file — a capture failure is reported, not hidden, and the programme
    // stays PROPOSED until at least one snapshot exists.
    const captured: string[] = [];
    const failed: string[] = [];
    if (this.deps.designContext) {
      for (const fileKey of figmaFileKeys) {
        try {
          const isMobile = (programme.platform ?? "").includes("mobile");
          const document = await this.deps.designContext.snapshotPrototype(fileKey, {
            platform: isMobile ? "mobile" : (programme.platform ?? null),
            programmeKey: key,
            requestedBy: actor,
          });
          captured.push(`${fileKey} (v${document.version}, ${document.states.length} screens)`);
          await this.deps.store.updateProgramme(key, { designContextId: document.id });
        } catch (error) {
          failed.push(`${fileKey}: ${error instanceof Error ? error.message : "capture failed"}`);
        }
      }
    }
    if (captured.length > 0) {
      programmeMachine.assertTransition("PROPOSED", "SEEDED");
      await this.deps.store.updateProgramme(key, { status: "SEEDED" });
    }

    // Best-effort API-contract snapshot: reported, never hidden. A missing
    // contract does not block programme creation — it blocks INVENTING
    // endpoints, via the brief and the rebuild repos' CLAUDE.md rule.
    let apiContractLine: string | undefined;
    if (this.deps.apiContracts) {
      try {
        const contract = await this.deps.apiContracts.snapshot();
        apiContractLine = `API contract captured: ${contract.info.title} ${contract.info.version} — ${contract.operations.length} operations (v${contract.version}, ${contract.excludedOperationCount} archived/admin/internal excluded).`;
      } catch (error) {
        apiContractLine = `API contract UNAVAILABLE: ${error instanceof Error ? error.message : "capture failed"}. Briefs will carry no endpoint allowlist until this is fixed.`;
      }
    }

    const seeded = captured.length > 0 || seededWithoutSnapshot;
    const lines = [
      `Programme *${title}* created as \`${key}\` targeting ${targetRepoKey} (${seeded ? "SEEDED" : "PROPOSED"}).`,
      milestones.length > 0
        ? `Milestones: ${milestones.map((m) => `\`${m.id}\` ${m.title}`).join("; ")}.`
        : "Milestones: none yet — add them with add_milestones before planning.",
      ...(branchLine ? [branchLine] : []),
      ...(trackingLine ? [trackingLine] : []),
      ...(specIssueLine ? [specIssueLine] : []),
      ...(captured.length > 0 ? [`Design context captured: ${captured.join("; ")}.`] : []),
      ...(seededWithoutSnapshot
        ? [
            uiSourceConfigured
              ? `Design source: the prototype implementation named in programme-policy.yaml uiSources — screens are its routes, chosen at planning time.`
              : `Design source: none — the UI is built from scratch against the spec. Name each milestone's screens in propose_milestone_plan screenStates.`,
          ]
        : []),
      ...(failed.length > 0 ? [`Capture failures: ${failed.join("; ")}.`] : []),
      ...(apiContractLine ? [apiContractLine] : []),
      ...(parityLine ? [parityLine] : []),
      ...(settings.requireExploratorySweep
        ? []
        : ["No exploratory sweep for this repo (no preview yet): a milestone completes once its tasks merge, and the owner verifies the working branch locally."]),
      specId
        ? settings.requireTechnicalSpec
          ? `Autopilot: programme spec ${specId} governs every milestone. Next: prepare_technical_spec ${key} — read the digest, ask the requester only what it cannot answer, record the answers with record_programme_decision — then propose_milestone_plan with screenStates. The first task dispatched is the technical spec; a human merges its PR, and the build proceeds from there unattended to the single final review.`
          : `Autopilot: programme spec ${specId} governs every milestone. Next: propose_milestone_plan for each milestone (no per-milestone approval needed); dispatch, evidence and auto-merge then run unattended until the single final review.`
        : "Next: run a spec session per milestone (seeded from the source spec), get it approved, then propose_milestone_plan with the approved specId.",
    ];
    return { ok: true, text: lines.join("\n"), executed: true };
  }


  protected async programmeStatus(args: Record<string, unknown>): Promise<ProgrammeToolResult> {
    const key = typeof args.programmeKey === "string" ? args.programmeKey : "";
    const programme = await this.deps.store.getProgramme(key);
    if (!programme) {
      return { ok: false, text: `No programme named ${key || "(missing key)"}.`, executed: false };
    }
    const milestones = await this.deps.store.listMilestones(programme.id);
    const allTasks = await this.deps.store.listBuildTasks(programme.id);
    const tasks = withoutBenchTasks(allTasks);
    const benchArms = allTasks.filter((task) => isBenchTask(task));
    const counts = new Map<string, number>();
    for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    // Deferred ids that some live task has since picked up are not "deferred".
    const liveOwned = new Set(
      tasks.filter((task) => task.status !== "CANCELLED").flatMap((task) => task.acceptanceCriterionIds),
    );
    const deferredUnowned = (
      (programmeMetadata(programme) as { deferredCriterionIds?: string[] }).deferredCriterionIds ?? []
    ).filter((id) => !liveOwned.has(id));

    const lines = [
      `*${programme.title}* (\`${programme.key}\`) — ${programme.status}${programme.pausedReason ? ` (paused: ${programme.pausedReason})` : ""}`,
      `Target: ${programme.targetRepoKey}` +
        (programme.sourceSpecRepoKey && programme.sourceSpecIssueNumber
          ? ` · source spec ${programme.sourceSpecRepoKey}#${programme.sourceSpecIssueNumber}`
          : ""),
      milestones.length > 0
        ? milestones
            .map((m) => `M${m.ordinal} \`${m.id}\` ${m.title}: ${m.status}${m.specId ? ` (spec ${m.specId})` : " (no spec yet)"}`)
            .join("\n")
        : "No milestones — add_milestones creates them.",
      tasks.length > 0
        ? `Tasks: ${[...counts.entries()].map(([status, n]) => `${status}=${n}`).join(" · ")}`
        : "No build tasks planned yet.",
      benchArms.length > 0
        ? `Model bench (never merged; /lexi diag rebuild-bench ${programme.key} scores it): ${benchArms
            .map((task) => `${benchArmOf(task)!.model}=${task.status}${task.prNumber ? ` #${task.prNumber}` : ""}`)
            .join(" · ")}`
        : "",
      // Why each open task PR is not merging, from the gate's own persisted
      // verdict. Without this the model had no way to read the refusal and
      // guessed ("GitHub CI never ran") while the real reason — 115 unbound
      // criteria — sat in the pod log.
      ...tasks
        .filter((task) => task.status === "PR_OPEN")
        .map((task) => gateRefusalLine(task))
        .filter((line): line is string => line !== null),
      deferredUnowned.length > 0
        ? `Deferred criteria (recorded when removed from a task; the planner does not read this list yet — a later milestone's plan must be re-scoped to pick them up): ${deferredUnowned.length} not owned by any live task (${deferredUnowned.slice(0, 5).join(", ")}${deferredUnowned.length > 5 ? ", …" : ""}).`
        : "",
      this.deps.policy.milestoneReview.mode === "notify"
        ? `Autopilot: milestone cards are notifications; one final review before the hardening pass${programme.specId ? ` (programme spec ${programme.specId})` : ""}.`
        : "",
      programme.referenceRepoKey ? `Parity floor: ${programme.referenceRepoKey}` : "",
      programmeMetadata(programme).baseBranch ? `Working branch: \`${programmeMetadata(programme).baseBranch}\` (task PRs target it; a human promotes it to the default branch).` : "",
      programmeMetadata(programme).trackingIssue
        ? `Tracking issue: ${programmeMetadata(programme).trackingIssue!.url}`
        : "",
      (programmeMetadata(programme).decisions ?? []).length > 0
        ? `Decisions recorded: ${(programmeMetadata(programme).decisions ?? []).length} (in every brief; see the tracking issue).`
        : "",
      await this.usageSummaryLine(programme.id),
    ].filter(Boolean);
    return { ok: true, text: lines.join("\n"), executed: false };
  }


  protected async pauseProgramme(args: Record<string, unknown>, actor: string): Promise<ProgrammeToolResult> {
    const key = typeof args.programmeKey === "string" ? args.programmeKey : "";
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    const programme = await this.deps.store.getProgramme(key);
    if (!programme) return { ok: false, text: `No programme named ${key}.`, executed: false };
    if (!reason) return { ok: false, text: "pause_programme needs a reason.", executed: false };
    programmeMachine.assertTransition(programme.status, "PAUSED");
    await this.deps.store.updateProgramme(key, { status: "PAUSED", pausedReason: `${reason} (by ${actor})` });
    return {
      ok: true,
      text: `Programme ${key} paused: ${reason}. In-flight runs are not cancelled; no further tasks dispatch until a human resumes it.`,
      executed: true,
    };
  }


  /**
   * The counterpart to `pauseProgramme`, without which a pause is one-way.
   *
   * The state machine has always allowed PAUSED to return to work, but nothing
   * performed the transition: there was no tool, no Block Kit action and no
   * scheduled path. A programme paused for a transient blocker stayed paused
   * for good, and the advance tick only walks BUILDING and PLANNED, so it also
   * stopped folding results for work already in flight.
   *
   * The state to return to is DERIVED rather than stored. Recording it would
   * mean a new column, and a migration against a production database is a poor
   * trade for a value the programme's own shape already implies. Deriving is
   * safe because COMPLETE is reachable only from HARDENING: resuming a hardening-time
   * pause into BUILDING cannot skip the hardening, it just makes the programme earn
   * its way back to HARDENING and pass the gate again.
   */
  protected async resumeProgramme(args: Record<string, unknown>, actor: string): Promise<ProgrammeToolResult> {
    const key = typeof args.programmeKey === "string" ? args.programmeKey : "";
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    const programme = await this.deps.store.getProgramme(key);
    if (!programme) return { ok: false, text: `No programme named ${key}.`, executed: false };
    if (!reason) return { ok: false, text: "resume_programme needs a reason — normally what was fixed.", executed: false };
    if (programme.status !== "PAUSED") {
      return {
        ok: false,
        text: `Programme ${key} is ${programme.status}, not PAUSED — nothing to resume.`,
        executed: false,
      };
    }

    const tasks = await this.deps.store.listBuildTasks(programme.id);
    const milestones = await this.deps.store.listMilestones(programme.id);
    const target: ProgrammeStatus =
      tasks.length > 0
        ? "BUILDING"
        : milestones.length > 0
          ? "PLANNED"
          : programme.designContextId
            ? "SEEDED"
            : "PROPOSED";

    programmeMachine.assertTransition("PAUSED", target);
    await this.deps.store.updateProgramme(key, { status: target, pausedReason: null });
    return {
      ok: true,
      text:
        `Programme ${key} resumed to ${target}: ${reason} (by ${actor}). ` +
        (target === "BUILDING" || target === "PLANNED"
          ? "The next advance tick folds any results that landed while it was paused, then dispatch continues."
          : "Plan a milestone to start dispatching."),
      executed: true,
    };
  }


  /**
   * Retires a programme (a clean slate needs a way to end the old one). CANCELLED is terminal for dispatch — the advance
   * tick walks only live statuses — and revivable to PROPOSED by design, so
   * nothing is deleted. Task rows are left as they are for history; the
   * programme's absence from LIVE_PROGRAMME_STATUSES is what frees the repo.
   */
  protected async cancelProgramme(args: Record<string, unknown>, actor: string): Promise<ProgrammeToolResult> {
    const key = typeof args.programmeKey === "string" ? args.programmeKey : "";
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    const programme = await this.deps.store.getProgramme(key);
    if (!programme) return { ok: false, text: `No programme named ${key}.`, executed: false };
    if (!reason) return { ok: false, text: "cancel_programme needs a reason — it is posted to the review channel.", executed: false };
    if (programme.status === "CANCELLED" || programme.status === "COMPLETE") {
      return { ok: false, text: `Programme ${key} is already ${programme.status}.`, executed: false };
    }
    programmeMachine.assertTransition(programme.status, "CANCELLED");
    await this.deps.store.updateProgramme(key, { status: "CANCELLED", pausedReason: `cancelled: ${reason} (by ${actor})` });
    const tasks = await this.deps.store.listBuildTasks(programme.id);
    const open = tasks.filter((task) => !["MERGED", "VERIFIED", "CANCELLED"].includes(task.status)).length;
    await this.postToReviewChannel(
      `Programme \`${key}\` cancelled by <@${actor}>: ${reason}. ${open} open task(s) retired; ${programme.targetRepoKey} is free for a new programme. In-flight runs are not cancelled.`,
    );
    await this.remember(programme, "fact", `Programme ${key} ("${programme.title}") was cancelled: ${reason}.`, { actor }, 0.6);
    await this.syncTrackingIssue({ ...programme, status: "CANCELLED" });
    return {
      ok: true,
      text: `Programme ${key} cancelled (${open} open task(s) retired). ${programme.targetRepoKey} can host a new programme now. The record stays for history and can be revived to PROPOSED.`,
      executed: true,
    };
  }


  /**
   * Records decisions humans took about a programme so every later brief
   * carries them verbatim and Lexi remembers them across threads. Three
   * writes, in order of trust: the programme row (the brief reads this — it
   * must be exact), the memory store (recall across threads and programmes),
   * the tracking issue (the humans' view).
   */
  protected async recordDecision(args: Record<string, unknown>, actor: string): Promise<ProgrammeToolResult> {
    const key = typeof args.programmeKey === "string" ? args.programmeKey : "";
    const programme = await this.deps.store.getProgramme(key);
    if (!programme) return { ok: false, text: `No programme named ${key}.`, executed: false };
    const raw = Array.isArray(args.decisions) ? args.decisions : [];
    const incoming: ProgrammeDecision[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const topic = typeof record.topic === "string" ? record.topic.trim() : "";
      const decision = typeof record.decision === "string" ? record.decision.trim() : "";
      if (!topic || !decision) continue;
      const rationale = typeof record.rationale === "string" && record.rationale.trim() ? record.rationale.trim() : undefined;
      const decidedBy = typeof record.decidedBy === "string" && record.decidedBy.trim() ? record.decidedBy.trim() : actor;
      incoming.push({
        id: this.mintId(),
        topic: topic.slice(0, 120),
        decision: decision.slice(0, 1200),
        ...(rationale ? { rationale: rationale.slice(0, 600) } : {}),
        decidedBy,
        recordedAt: this.now().toISOString(),
      });
    }
    if (incoming.length === 0) {
      return { ok: false, text: "record_programme_decision needs at least one {topic, decision}.", executed: false };
    }
    const meta = programmeMetadata(programme);
    const existing = meta.decisions ?? [];
    // Same topic again supersedes: the latest decision on a topic is the one
    // the brief must carry, and two contradicting lines would be a guess.
    const superseded = new Set(incoming.map((d) => d.topic.toLowerCase()));
    const decisions = [...existing.filter((d) => !superseded.has(d.topic.toLowerCase())), ...incoming];
    const next: ProgrammeMetadata = { ...meta, decisions };
    await this.deps.store.updateProgramme(key, { metadata: next as Record<string, unknown> });
    programme.metadata = next as Record<string, unknown>;
    for (const d of incoming) {
      await this.remember(
        programme,
        "decision",
        `Decision for programme ${key} (${d.topic}): ${d.decision}${d.rationale ? ` Rationale: ${d.rationale}` : ""}`,
        { topic: d.topic, decidedBy: d.decidedBy },
        0.9,
      );
    }
    await this.syncTrackingIssue(programme);
    return {
      ok: true,
      text:
        `Recorded ${incoming.length} decision(s) on ${key} (${decisions.length} total): ` +
        incoming.map((d) => `${d.topic} — ${d.decision}`).join("; ") +
        `. Every brief from the next dispatch carries them verbatim${meta.trackingIssue ? `, and the tracking issue is updated` : ""}.`,
      executed: true,
    };
  }
}
