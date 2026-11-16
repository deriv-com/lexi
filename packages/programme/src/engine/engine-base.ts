import { randomUUID } from "node:crypto";
import type { ApiReferenceDocument, RepoDescriptor } from "@lexi/contracts";
import { repoSettingsFor } from "../load-programme-policy";
import { modelForAttempt } from "../model-ladder";
import { refundForInfraFault } from "../attempt-accounting";
import { benchArmOf, withoutBenchTasks } from "../model-bench-plan";
import { formatUsageSummary, parseTokenUsageChecks, summarizeTokenUsage } from "../token-usage";
import type { BuildTaskRecord, MilestoneRecord, ProgrammeRecord } from "../programme-store";
import type { ProgrammeBuildDeps, ProgrammeBuildResult, RunEvidenceListRow } from "./ports";
import {
  markdownSection,
  extraAttemptsOf,
  MAX_DEPENDENCIES_READ_FOR_HINTS,
  MAX_FILE_MANIFEST_HINTS,
  technicalSpecPath,
  programmeMetadata,
  sha256,
  MAX_MILESTONE_TITLE_LENGTH,
  type ResolvedApiReference,
  type ProgrammeMetadata,
  type BuildTaskStatusLike,
} from "./helpers";

/**
 * The programme engine's shared base: its dependencies, clock and id source,
 * logging, and the helpers every layer uses — the tracking issue, the review
 * channel, memory recall, repository paths and the attempt-budget arithmetic.
 *
 * The engine is one service split into layers, each a subclass of the one
 * before: lifecycle → planning → task commands → briefs → fold → merge →
 * review → ProgrammeBuildService. Members a layer calls but a later layer
 * implements are declared abstract here.
 */
export abstract class ProgrammeEngineBase {
  constructor(protected readonly deps: ProgrammeBuildDeps) {}


  /** apiContract.referenceDocs as last resolved; see resolveApiReferences. */
  protected apiReferenceCache: { at: number; references: ResolvedApiReference[] } | null = null;


  protected now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }


  protected mintId(): string {
    return this.deps.mintId ? this.deps.mintId() : randomUUID();
  }


  protected log(message: string): void {
    this.deps.logger.log(message, "ProgrammeBuildService");
  }


  protected warn(message: string): void {
    this.deps.logger.warn(message, "ProgrammeBuildService");
  }


  protected slugify(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
  }


  /**
   * Resolve the optional source-spec issue to its title, for the creation
   * reply only.
   *
   * Reports rather than refuses, like the parity and API-contract snapshots
   * either side of it. A recorded pointer that silently does not exist — a
   * typo'd number rendered by get_programme_status as if it were real — is
   * worse than no pointer, but a GitHub blip is no reason to refuse a
   * programme over a field nothing reads. So the human who supplied it sees
   * either the issue's title or the reason it could not be confirmed.
   */
  /**
   * Give an infrastructure fault its attempt back, if the budget allows.
   *
   * `storedAttempts` is what the row currently holds — for a failed dispatch
   * that is the value just written by the DISPATCHED transition, not the stale
   * in-memory `task.attempts`. Getting that wrong refunds the wrong number
   * silently, so the caller passes it explicitly rather than having it
   * inferred here.
   *
   * Returns null when the refund is refused, in which case the caller writes
   * no counter change and the fault burns a build attempt exactly as before.
   */
  protected refundInfraFault(
    task: BuildTaskRecord,
    storedAttempts: number,
    fault: string,
  ): { attempts: number; infraFaults: number; metadataPatch: Record<string, unknown> } | null {
    const metadata = (task.metadata ?? {}) as Record<string, unknown>;
    const priorInfraFaults = typeof metadata.infraFaults === "number" ? metadata.infraFaults : 0;
    const refund = refundForInfraFault({
      storedAttempts,
      priorInfraFaults,
      maxInfraFaults: this.deps.policy.dispatch.maxInfraFaults,
    });
    if (!refund) {
      this.warn(
        `Not refunding ${task.id}: ${priorInfraFaults}/${this.deps.policy.dispatch.maxInfraFaults} infrastructure faults already spent, so this one is charged to the build budget (${fault}).`,
      );
      return null;
    }
    this.log(
      `Refunded an attempt to ${task.id} for an infrastructure fault: ${fault} (infrastructure fault ${refund.infraFaults}/${this.deps.policy.dispatch.maxInfraFaults}).`,
    );
    return {
      attempts: refund.attempts,
      infraFaults: refund.infraFaults,
      metadataPatch: { infraFaults: refund.infraFaults, lastInfraFault: fault },
    };
  }


  protected async describeSpecIssue(slug: string, issueNumber: number): Promise<string> {
    const reference = `${slug}#${issueNumber}`;
    const getIssue = this.deps.github.getIssueForRepo;
    if (!getIssue) return `Source spec: ${reference} (recorded; not confirmed — no issue reader wired).`;
    const [owner, repo] = slug.split("/");
    try {
      const issue = await getIssue.call(this.deps.github, owner, repo, issueNumber);
      return `Source spec: ${reference} — "${issue.title}".`;
    } catch (error) {
      return (
        `Source spec: ${reference} RECORDED BUT UNCONFIRMED — ` +
        `${error instanceof Error ? error.message : "read failed"}. ` +
        `Check the number; nothing reads this issue, so a wrong one fails silently from here on.`
      );
    }
  }


  /**
   * Milestone titles from a tool call, in the order given. Accepts
   * `[{ title }]` (the schema) and bare strings (what a model sends when it
   * skims the schema); blanks are dropped rather than minted as untitled
   * milestones.
   *
   * Titles are Slack-sourced free text that lands in every screen brief's
   * trustedInstruction ("… of milestone N (\"<title>\")"), so they are
   * flattened to one line, stripped of backticks and capped: a title must not
   * be able to carry extra instruction lines into a brief.
   */
  protected parseMilestoneTitles(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      const raw =
        typeof entry === "string"
          ? entry
          : typeof entry === "object" && entry !== null && typeof (entry as { title?: unknown }).title === "string"
            ? (entry as { title: string }).title
            : "";
      const title = raw
        .replace(/[\r\n\t`]+/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, MAX_MILESTONE_TITLE_LENGTH)
        .trim();
      return title ? [title] : [];
    });
  }


  /**
   * Creates the programme's working branch from the default branch, once.
   * Idempotent: an existing branch is reused, because a programme can be
   * cancelled and re-created against the same repository and the branch is
   * the owner's to promote or delete, not this service's. `ok` is true only
   * when the branch is known to exist afterwards.
   */
  protected async ensureWorkingBranch(repo: RepoDescriptor, branch: string): Promise<{ ok: boolean; line: string }> {
    const { organization: owner, repository: repoName } = repo;
    const from = repo.defaultBranch ?? "main";
    if (!this.deps.github.branchExists || !this.deps.github.createBranch) {
      return {
        ok: false,
        line: `Working branch \`${branch}\` could not be verified: this deployment's GitHub provider cannot read or create branches. Create it from \`${from}\` by hand before the first dispatch.`,
      };
    }
    try {
      const exists = await this.deps.github.branchExists(owner, repoName, branch);
      if (exists === true) {
        return { ok: true, line: `Working branch \`${branch}\` already exists on ${owner}/${repoName}; task PRs will target it.` };
      }
      const created = await this.deps.github.createBranch(owner, repoName, { name: branch, from });
      return {
        ok: true,
        line: `Working branch \`${branch}\` created from \`${from}\` at ${created.sha.slice(0, 12)}; task PRs will target it and auto-merge lands there.`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      this.warn(`Working branch ${branch} on ${owner}/${repoName} could not be ensured: ${message}`);
      return {
        ok: false,
        line: `Working branch \`${branch}\` could NOT be created on ${owner}/${repoName} (${message}). Dispatch will fail until it exists — create it from \`${from}\`.`,
      };
    }
  }


  /** Opens the tracking issue and records its number on the programme. */
  protected async openTrackingIssue(programme: ProgrammeRecord, milestones: MilestoneRecord[]): Promise<string> {
    const repo = this.deps.registry.resolveRepo(programme.targetRepoKey);
    if (!repo) return "";
    if (!this.deps.github.createIssue) {
      return "Tracking issue not opened: this deployment's GitHub provider cannot create issues.";
    }
    const body = this.renderTrackingIssueBody(programme, milestones, []);
    try {
      const issue = await this.deps.github.createIssue(
        repo.organization,
        repo.repository,
        `[LEXI programme] ${programme.title}`,
        body,
        ["lexi-programme"],
      );
      const next: ProgrammeMetadata = {
        ...programmeMetadata(programme),
        trackingIssue: { number: issue.githubNumber, url: issue.url },
        trackingIssueBodyHash: sha256(body),
      };
      await this.deps.store.updateProgramme(programme.key, { metadata: next as Record<string, unknown> });
      programme.metadata = next as Record<string, unknown>;
      return `Tracking issue: ${issue.url} — the task checklist, decisions and links live there and the advance job keeps it current.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      this.warn(`Tracking issue for ${programme.key} could not be opened: ${message}`);
      return `Tracking issue could NOT be opened on ${repo.slug} (${message}); the programme runs without a status board until one is created and recorded.`;
    }
  }


  /**
   * The tracking issue body — a VIEW over the store. Regenerated whole on
   * every change and compared by hash, so it never drifts and never costs an
   * API call when nothing moved.
   */
  protected renderTrackingIssueBody(
    programme: ProgrammeRecord,
    milestones: MilestoneRecord[],
    tasks: BuildTaskRecord[],
  ): string {
    const repo = this.deps.registry.resolveRepo(programme.targetRepoKey);
    const meta = programmeMetadata(programme);
    const settings = repoSettingsFor(this.deps.policy, programme.targetRepoKey);
    const uiSource = this.deps.policy.uiSources?.[programme.targetRepoKey];
    const uiSourceRepo = uiSource ? this.deps.registry.resolveRepo(uiSource.repoKey) : null;
    const done = new Set<BuildTaskStatusLike>(["MERGED", "VERIFIED"]);
    // A retired task ticks its box: it will never complete, and leaving it
    // open makes the milestone read as permanently unfinished. It still
    // prints its state below, so "cancelled" is never read as "merged".
    const settled = new Set<BuildTaskStatusLike>(["MERGED", "VERIFIED", "CANCELLED"]);
    const mark = (task: BuildTaskRecord): string => {
      const box = settled.has(task.status) ? "x" : " ";
      const pr = task.prNumber && repo ? ` — [#${task.prNumber}](https://github.com/${repo.slug}/pull/${task.prNumber})` : "";
      const state = done.has(task.status) ? "" : ` _(${task.status.toLowerCase().replace(/_/g, " ")}${task.status === "CANCELLED" ? `: ${String((task.metadata as { cancelledReason?: unknown } | null)?.cancelledReason ?? "no reason recorded")}` : task.status === "HANDBACK" || task.status === "FAILED" ? `: ${String((task.metadata as { handbackReason?: unknown } | null)?.handbackReason ?? "no reason recorded")}` : ""})_`;
      return `- [${box}] \`${task.id}\` ${task.title}${pr}${state}`;
    };
    const byMilestone = new Map<string, BuildTaskRecord[]>();
    for (const task of tasks) {
      const list = byMilestone.get(task.milestoneId) ?? [];
      list.push(task);
      byMilestone.set(task.milestoneId, list);
    }
    const sharedTasks = tasks.filter((task) => task.id.includes(`:${"shared"}:`));
    const decisions = meta.decisions ?? [];
    const lines: string[] = [
      `Lexi rebuild programme \`${programme.key}\` — **${programme.status}**. Maintained by the orchestrator's advance job; edits here are overwritten.`,
      "",
      "## Sources",
      `- Business spec: approved spec session \`${programme.specId ?? "none yet"}\`${programme.sourceSpecRepoKey && programme.sourceSpecIssueNumber ? ` (issue ${programme.sourceSpecRepoKey}#${programme.sourceSpecIssueNumber})` : ""}`,
      `- UI source (intent reference only — rebuild, do not port): ${uiSourceRepo ? `${uiSourceRepo.slug}@${uiSource!.ref}` : "none configured"}`,
      `- API contract: ${this.deps.policy.apiContract?.repoSlug ?? "none"} \`${this.deps.policy.apiContract?.path ?? ""}\` (filtered snapshot in every brief)`,
      `- Technical spec: \`${technicalSpecPath(programme.key)}\`${settings.requireTechnicalSpec ? " — authored by the technical-spec task; its PR merge is the approval" : " — not required for this repo"}`,
      `- Working branch: \`${meta.baseBranch ?? repo?.defaultBranch ?? "main"}\``,
      `- Production parity: none (rebuilds are judged against the spec and the prototype's intent)`,
      "",
      "## Decisions",
      ...(decisions.length > 0
        ? decisions.map((d) => `- **${d.topic}** — ${d.decision}${d.rationale ? ` _(${d.rationale})_` : ""} · ${d.decidedBy}, ${d.recordedAt.slice(0, 10)}`)
        : ["- none recorded yet"]),
      "",
      "## Tasks",
      ...(tasks.length === 0
        ? ["- not planned yet — `propose_milestone_plan` writes the checklist"]
        : [
            ...(sharedTasks.length > 0 ? ["### Programme-level (once)", ...sharedTasks.map(mark), ""] : []),
            ...milestones
              .filter((m) => m.ordinal > 0)
              .flatMap((m) => {
                const own = (byMilestone.get(m.id) ?? []).filter((task) => !sharedTasks.includes(task));
                return [`### M${m.ordinal} ${m.title} — ${m.status}`, ...(own.length > 0 ? own.map(mark) : ["- no tasks"]), ""];
              }),
          ]),
    ];
    return lines.join("\n").trimEnd() + "\n";
  }


  /** Pushes the regenerated body when it changed. Never throws into the advance loop. */
  /**
   * Paths a task's MERGED dependencies already wrote, so its brief can name
   * what to reuse instead of re-deriving it.
   *
   * Bounded twice over: at most a handful of dependencies are read, and the
   * result is capped — a hint list longer than the agent will read is not a
   * better hint list, and the brief has its own size budget. Truncation is
   * silent by design here: these are advisory paths, and the dependency SHAs
   * travel alongside them, so an agent that wants the full picture can diff
   * the branch itself.
   *
   * A dependency whose files cannot be read is skipped with a warning rather
   * than failing the brief: no hints is the behaviour every brief had until
   * now, and a brief that refuses to build because an advisory field could
   * not be filled would be a worse failure than the one this fixes.
   */
  protected async dependencyFileHints(
    task: BuildTaskRecord,
    dependencies: Array<{ buildTaskId: string; prNumber?: number; mergedSha?: string }>,
  ): Promise<string[]> {
    const read = this.deps.github.getPullRequestFiles;
    if (!read) return [];
    const repo = this.deps.registry.resolveRepo(task.codeRepoKey);
    if (!repo) return [];

    const merged = dependencies.filter((dependency) => dependency.prNumber && dependency.mergedSha);
    const hints: string[] = [];
    const seen = new Set<string>();
    for (const dependency of merged.slice(0, MAX_DEPENDENCIES_READ_FOR_HINTS)) {
      try {
        const files = await read.call(
          this.deps.github,
          repo.organization,
          repo.repository,
          dependency.prNumber!,
        );
        for (const file of files) {
          // Deleted paths are not there to reuse.
          if (file.status === "removed") continue;
          if (seen.has(file.filename)) continue;
          seen.add(file.filename);
          hints.push(file.filename);
          if (hints.length >= MAX_FILE_MANIFEST_HINTS) return hints.sort();
        }
      } catch (error) {
        this.warn(
          `Could not read files of ${repo.slug}#${dependency.prNumber} for ${task.id}'s brief: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
    return hints.sort();
  }


  protected async syncTrackingIssue(programme: ProgrammeRecord): Promise<void> {
    const meta = programmeMetadata(programme);
    if (!meta.trackingIssue || !this.deps.github.updateIssue) return;
    const repo = this.deps.registry.resolveRepo(programme.targetRepoKey);
    if (!repo) return;
    try {
      const fresh = (await this.deps.store.getProgramme(programme.key)) ?? programme;
      const milestones = await this.deps.store.listMilestones(fresh.id);
      // Bench arms are not the programme's checklist: they never merge, so
      // listing them would leave eight boxes unticked for ever.
      const tasks = withoutBenchTasks(await this.deps.store.listBuildTasks(fresh.id));
      const body = this.renderTrackingIssueBody(fresh, milestones, tasks);
      const hash = sha256(body);
      if (programmeMetadata(fresh).trackingIssueBodyHash === hash) return;
      await this.deps.github.updateIssue(repo.organization, repo.repository, meta.trackingIssue.number, {
        title: `[LEXI programme] ${fresh.title}`,
        body,
      });
      await this.deps.store.updateProgramme(fresh.key, {
        metadata: { ...programmeMetadata(fresh), trackingIssueBodyHash: hash } as Record<string, unknown>,
      });
    } catch (error) {
      this.warn(`Tracking issue sync for ${programme.key} failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }


  /**
   * The refusal for a `screenStates` name the inventory does not know.
   *
   * Names candidates rather than only the rejection, because the inventory is
   * ~100 entries long and the operator cannot see it from Slack — a bare "no
   * such screen" would leave them guessing at spellings. Substring matches
   * first (a real "did you mean"), then a bounded sample, then the total, so
   * the reply is useful without pasting a hundred route paths into a thread.
   */
  protected describeUnknownScreens(
    unknown: string[],
    available: string[],
    scopeSource: string,
  ): string {
    const unique = [...new Set(available.map((name) => name.trim()))].filter(
      (name) => name.length > 0,
    );
    const lines = unknown.map((name) => {
      const needle = name.toLowerCase();
      const near = unique
        .filter((candidate) => {
          const hay = candidate.toLowerCase();
          return hay.includes(needle) || needle.includes(hay);
        })
        .slice(0, 5);
      return near.length > 0
        ? `• "${name}" — did you mean ${near.map((candidate) => `\`${candidate}\``).join(", ")}?`
        : `• "${name}" — no close match`;
    });
    return [
      `${unknown.length} requested screen name(s) are not in this programme's inventory (${scopeSource}), so nothing was planned:`,
      ...lines,
      "",
      `The inventory holds ${unique.length} screen(s). A sample: ${unique
        .slice(0, 15)
        .map((name) => `\`${name}\``)
        .join(", ")}${unique.length > 15 ? ", …" : ""}.`,
      "Names must come from the inventory — a screen nobody has an entry for cannot be built from a brief, so it is refused rather than invented.",
    ].join("\n");
  }


  /** Policy cap plus any extra attempts a person granted this task via retry_build_task. */
  protected attemptCapFor(task: BuildTaskRecord): number {
    return this.deps.policy.dispatch.maxTaskAttempts + extraAttemptsOf(task);
  }


  /**
   * Adds (and optionally removes) ids in the programme's deferred-criteria
   * record, re-reading the programme first so a concurrent metadata write is
   * never overwritten with a stale copy. Returns the resulting list.
   *
   * Still a read-then-write of the whole metadata object (the store has no
   * JSON-path update). Writers that can race it: the advance tick's
   * technicalSpecMappingSha(s) and record_programme_decision. The window is
   * the gap between the re-read and the write — no awaits in between — so it
   * is kept to one round trip; a lost mapping sha only costs a re-read, and
   * this is the same exposure every other programme-metadata writer has.
   */
  protected async addDeferredCriteria(programmeKey: string, add: string[], remove: string[] = []): Promise<string[]> {
    const fresh = await this.deps.store.getProgramme(programmeKey);
    if (!fresh) return [];
    const meta = programmeMetadata(fresh) as ProgrammeMetadata & { deferredCriterionIds?: string[] };
    const before = [...(meta.deferredCriterionIds ?? [])].sort((a, b) => a.localeCompare(b));
    const next = [...new Set([...before, ...add])].filter((id) => !remove.includes(id)).sort((a, b) => a.localeCompare(b));
    if (next.join(",") !== before.join(",")) {
      await this.deps.store.updateProgramme(programmeKey, {
        metadata: { ...meta, deferredCriterionIds: next } as Record<string, unknown>,
      });
    }
    return next;
  }


  /**
   * The path of one of the app's own `.lexi/` files, from its repo KEY.
   *
   * Prefixed with the app's `workdir` in a repo holding several apps, bare
   * otherwise. Resolved from the KEY rather than the slug because the slug no
   * longer identifies an app: one repository can be registered once per app.
   *
   * An unresolvable key yields the bare path. That is safe at every call
   * site: the auto-merge gate has already refused on the tier check by then
   * (`isProgramme` is false for an unknown key), and the brief only quotes
   * the path into prose. It cannot open a gate — a missing bindings file
   * parses to no bindings, which fails `requireAcMatrixGreen`.
   */
  protected lexiPath(codeRepoKey: string, file: string): string {
    const workdir = this.deps.registry.resolveRepo(codeRepoKey)?.workdir;
    return workdir ? `${workdir}/.lexi/${file}` : `.lexi/${file}`;
  }


  /**
   * One bindings file PER TASK, so parallel tasks never collide on it.
   *
   * Every task used to write the same `.lexi/ac-bindings.json`, and tasks are
   * dispatched in parallel from one base — so whichever merged second always
   * conflicted there, was re-armed, and paid a full agent run to rebuild work
   * it had already finished. Git does
   * not conflict on files that do not overlap, so the fix is a file each
   * rather than a cleverer merge.
   *
   * The task id, `:` sanitised to `-`, matching the branch name the runner
   * derives from the same id.
   */
  protected bindingsShardPath(codeRepoKey: string, taskId: string): string {
    return this.lexiPath(codeRepoKey, `bindings/${taskId.replace(/:/g, "-")}.json`);
  }


  /**
   * `previewUrl` from the rebuild APP's own `.lexi/repo.json` at `ref`.
   *
   * Per app, not per repo. Two apps in one repository deploy to two previews,
   * so a single root manifest could only hold one of them and every sweep
   * would drive whichever was written there — a sweep that reports clean
   * about the wrong app is worse than no sweep, because a milestone completes
   * on it. There is deliberately NO fallback to the root manifest here: for a
   * repo with a workdir, the root file is either absent or another app's.
   */
  protected async previewUrl(repo: RepoDescriptor, ref: string): Promise<string | null> {
    const path = repo.workdir ? `${repo.workdir}/.lexi/repo.json` : ".lexi/repo.json";
    try {
      const raw = await this.deps.github.getFileContents(
        repo.organization,
        repo.repository,
        path,
        ref,
      );
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { previewUrl?: unknown };
      const url = typeof parsed.previewUrl === "string" ? parsed.previewUrl.trim() : "";
      return /^https:\/\/\S+$/.test(url) ? url : null;
    } catch {
      return null;
    }
  }


  /* --------------------------------------------------------- token usage */

  /** Token usage across every attempt of a programme, priced from the configured model pricing. */
  protected async usageSummaryLine(programmeId: string): Promise<string> {
    const tasks = await this.deps.store.listBuildTasks(programmeId);
    const attemptIds = tasks
      .map((task) => task.currentAttemptId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const entries = [];
    for (const attemptId of attemptIds) {
      const rows = await this.deps.evidence.listByAttempt(attemptId);
      for (const row of rows) entries.push(...parseTokenUsageChecks(row.checks));
    }
    if (entries.length === 0) return "";
    const summary = summarizeTokenUsage(entries, this.deps.pricing ?? {});
    return `*Token usage* (current attempts only)\n${formatUsageSummary(summary)}`;
  }


  /**
   * What Lexi remembers that bears on a task, rendered for the brief.
   *
   * One recall over the programme's origin thread (the Slack conversation
   * that commissioned and steered it) plus the org-scoped episodes that match
   * the task — decisions, facts and outcomes recorded by earlier tasks and
   * earlier programmes on this repo. Advisory in the brief; the criteria and
   * the trusted instruction always win. Empty when memory is off or nothing
   * matched, and the runner says so rather than pretending.
   */
  protected async recallForTask(
    programme: ProgrammeRecord,
    task: BuildTaskRecord,
    screens: string[],
  ): Promise<string> {
    if (!this.deps.memory) return "";
    const meta = programmeMetadata(programme);
    const repo = this.deps.registry.resolveRepo(programme.targetRepoKey);
    const query = [programme.title, task.title, ...screens.slice(0, 12), repo?.slug ?? ""].join(" ").slice(0, 400);
    try {
      const pack = await this.deps.memory.recall(
        {
          query,
          scope: "org",
          kinds: ["decision", "fact", "outcome"],
          ...(meta.originThreadKey ? { threadKey: meta.originThreadKey } : {}),
          limit: 12,
        },
        { maxTokens: 1800 },
      );
      return pack.rendered.trim();
    } catch (error) {
      this.warn(`Memory recall for ${task.id} failed: ${error instanceof Error ? error.message : "unknown"}`);
      return "";
    }
  }


  /** Writes one org-scoped episode about a programme, attached to its repo. Never throws. */
  protected async remember(
    programme: ProgrammeRecord,
    kind: "decision" | "fact" | "outcome",
    content: string,
    provenance: Record<string, unknown>,
    importance = 0.7,
  ): Promise<void> {
    if (!this.deps.memory) return;
    const meta = programmeMetadata(programme);
    try {
      await this.deps.memory.remember({
        scope: "org",
        kind,
        entityType: "repo",
        entityId: programme.targetRepoKey,
        ...(meta.originThreadKey ? { threadKey: meta.originThreadKey } : {}),
        content,
        importance,
        confidence: 1,
        provenance: { source: "programme", programmeKey: programme.key, ...provenance },
      });
    } catch (error) {
      this.warn(`Memory write for ${programme.key} failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }


  /**
   * Screen names from the prototype implementation's routes: every
   * `app/<route>/page.tsx` (Next.js App Router, which both the prototype and the
   * rebuild use) under the configured uiSource paths, as its route path.
   * `(auth)/login`, `(auth)/signup/verify`, `home`. Empty when no uiSource is
   * configured or the tree cannot be read; the caller reports which.
   */
  protected async uiSourceScreens(programme: ProgrammeRecord): Promise<string[]> {
    const config = this.deps.policy.uiSources?.[programme.targetRepoKey];
    if (!config || !this.deps.github.getTree) return [];
    const repo = this.deps.registry.resolveRepo(config.repoKey);
    if (!repo) return [];
    try {
      const tree = await this.deps.github.getTree(repo.organization, repo.repository, undefined, config.ref);
      const roots = config.paths.length > 0 ? config.paths : [""];
      const screens = new Set<string>();
      for (const entry of tree.entries) {
        if (entry.type !== "blob") continue;
        if (!roots.some((root) => root === "" || entry.path === root || entry.path.startsWith(`${root}/`))) continue;
        const match = entry.path.match(/(?:^|\/)app\/(.+)\/page\.[jt]sx?$/);
        if (!match?.[1]) continue;
        // `dev/` is the prototype's own tooling, never a product screen.
        if (match[1].startsWith("dev/")) continue;
        screens.add(match[1]);
      }
      return [...screens].sort((a, b) => a.localeCompare(b));
    } catch (error) {
      this.warn(`Prototype routes for ${programme.key} could not be read: ${error instanceof Error ? error.message : "unknown"}`);
      return [];
    }
  }


  protected async postBlocksToReviewChannel(text: string, blocks: unknown[]): Promise<void> {
    const channel = this.deps.flags.reviewChannel;
    if (!channel) return;
    try {
      const sent = await this.deps.notifier.sendMessage({
        channel,
        text,
        blocks: blocks as Array<Record<string, unknown>>,
      });
      if (sent.ok === false) {
        this.warn(`Review-channel card blocked: ${sent.error ?? "write gate"}`);
      }
    } catch (error) {
      this.warn(`Review-channel card failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }


  /**
   * When the technical-spec PR opens, ask its "Open questions" in Slack —
   * in the thread that commissioned the programme, where the requester is,
   * else the review channel. The PR description carries them too, but a
   * question only a PR reader sees gets answered by whoever merges, after the
   * fact. Answers recorded with record_programme_decision are binding on every
   * later brief. Best-effort: a spec it cannot read, or with no open
   * questions, posts nothing, and no failure here holds the task.
   */
  protected async postTechnicalSpecQuestions(
    programme: ProgrammeRecord,
    owner: string,
    repoName: string,
    prNumber: number,
    headSha: string | undefined,
    path: string,
  ): Promise<void> {
    try {
      let ref = headSha;
      if (!ref) {
        const pull = await this.deps.github.getPullRequest(owner, repoName, prNumber);
        ref = pull.headRef ?? undefined;
      }
      if (!ref) return;
      const markdown = await this.deps.github.getFileContents(owner, repoName, path, ref);
      const questions = markdown ? markdownSection(markdown, /^open questions$/i) : null;
      // Agent-written text going to Slack: strip anything that would ping.
      const body = questions
        ?.replace(/<[!@#][^>]*>/g, "")
        .replace(/@(channel|here|everyone)\b/gi, "$1")
        .trim();
      if (!body || /^(none|n\/a|no open questions)\.?$/i.test(body)) return;
      const text = [
        `The technical spec \`${path}\` for \`${programme.key}\` is ready for review: https://github.com/${owner}/${repoName}/pull/${prNumber}`,
        "It leaves these questions open. Answer them here before merging and I'll record each as a programme decision — every later task is bound by them. If an answer changes the spec itself, ask me to re-run the technical-spec task before you merge.",
        "",
        body.length > 2800 ? `${body.slice(0, 2800)}\n… (truncated — the rest is under "Open questions" in ${path})` : body,
      ].join("\n");
      const [channel, threadTs] = (programmeMetadata(programme).originThreadKey ?? "").split(":");
      if (channel && threadTs) {
        const sent = await this.deps.notifier.sendMessage({ channel, threadTs, text });
        if (sent.ok !== false) return;
        this.warn(`Technical-spec questions for ${programme.key} not posted to the origin thread: ${sent.error ?? "write gate"}`);
      }
      await this.postToReviewChannel(text);
    } catch (error) {
      this.warn(`Technical-spec questions for ${programme.key} could not be posted: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }


  protected async postToReviewChannel(text: string): Promise<void> {
    const channel = this.deps.flags.reviewChannel;
    if (!channel) return;
    try {
      const sent = await this.deps.notifier.sendMessage({ channel, text });
      if (sent.ok === false) {
        this.warn(`Review-channel post blocked: ${sent.error ?? "write gate"}`);
      }
    } catch (error) {
      this.warn(`Review-channel post failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }


  protected normaliseRunId(value: RunEvidenceListRow["workflowRunId"]): number | null {
    if (value == null) return null;
    const numeric = typeof value === "bigint" ? Number(value) : Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }


  /**
   * The ladder's model for a task kind and 1-based attempt; undefined = runner
   * default. A bench arm is pinned instead: every attempt, retries included,
   * runs the arm's own model, so its cost per landed task is that model's.
   */
  protected modelForTask(taskKind: string, attempt: number, task?: BuildTaskRecord): string | undefined {
    const pinned = task ? benchArmOf(task)?.model : undefined;
    if (pinned) return pinned;
    const ladder = this.deps.policy.dispatch.modelLadder;
    if (ladder.length === 0) return undefined;
    return modelForAttempt({
      ladder,
      byTaskKind: this.deps.policy.dispatch.modelByTaskKind,
      taskKind,
      attempt,
    });
  }

  /*
   * Members implemented by later layers and called by earlier ones. Declared
   * here so each layer type-checks on its own; the concrete
   * ProgrammeBuildService supplies every one.
   */
  protected abstract recordAttemptOutcome(
    attemptId: string,
    outcome: "shipped" | "handback" | "failed" | "infra_handback" | "no_result",
    evidence?: RunEvidenceListRow[],
    result?: ProgrammeBuildResult,
  ): Promise<void>;
  protected abstract foldTask(programme: ProgrammeRecord, owner: string, repoName: string, task: BuildTaskRecord): Promise<void>;
  protected abstract dispatchTask(programme: ProgrammeRecord, repo: RepoDescriptor, ref: string, task: BuildTaskRecord): Promise<boolean>;
  protected abstract resolveApiReferences(fresh?: boolean): Promise<ResolvedApiReference[]>;
  abstract apiReferenceDocument(index: number, sha: string): Promise<ApiReferenceDocument | null>;
}
