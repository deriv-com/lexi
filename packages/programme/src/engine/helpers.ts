import { createHash } from "node:crypto";
import type { AcceptanceTestBinding, ProgrammeStatus } from "@lexi/contracts";
import { BuildTaskStateMachine } from "../build-task-state-machine";
import { MilestoneStateMachine } from "../milestone-state-machine";
import { ProgrammeStateMachine } from "../programme-state-machine";
import { parseCriterionReason } from "../auto-merge-gate";
import { parseTokenUsageChecks, summarizeTokenUsage, type UsagePricing } from "../token-usage";
import type { BuildTaskRecord, ProgrammeRecord } from "../programme-store";
import type { ProgrammeBuildResult, RunEvidenceListRow } from "./ports";

/**
 * Constants, types and pure helpers shared by the programme engine's layers.
 */
/** A reference document as the brief cites it, or why it cannot. */
export type ResolvedApiReference =
  | { index: number; title: string; repoSlug: string; path: string; ref: string; sha: string }
  | { index: number; title: string; repoSlug: string; path: string; ref: string; unreadable: string };

/** Parallel briefs within this window cite the same blob of each reference. */
export const API_REFERENCE_CACHE_MS = 10 * 60 * 1000;
/** A reference is prose for an agent to read; past this it is not served. */
export const API_REFERENCE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The body of the first level-2 section whose heading matches, without the
 * heading; null when none does. Stops at the next level-2 heading.
 */
export function markdownSection(markdown: string, heading: RegExp): string | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s/.test(line) && heading.test(line.replace(/^##\s*/, "")));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  const body = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  return body || null;
}

/** Feature-spec paths a brief may cite: plain path characters only. */
export const FEATURE_SPEC_PATH = /^[A-Za-z0-9_./-]+\.md$/i;
/** Cap on feature specs cited in one brief. */
export const MAX_CITED_FEATURE_SPECS = 50;




/** Statuses in which a task's criteria may be re-scoped: not in flight, not finished. */
export const RESCOPABLE_STATUSES = ["PENDING", "READY", "PR_OPEN", "HANDBACK", "FAILED"] as const;

/**
 * A person's re-scope of a task's criteria (set_task_criteria). Re-plans and
 * criteria-map passes keep a re-scoped task's criteria rather than silently
 * putting the round-robin set back. A re-scope a re-plan had to void (none of
 * its ids survived the spec) is moved to `criteriaRescopesVoided`, so the
 * fallback set is not pinned as if a person had chosen it.
 */
export function isCriteriaRescoped(task: { metadata?: unknown }): boolean {
  const list = ((task.metadata ?? {}) as { criteriaRescopes?: unknown }).criteriaRescopes;
  return Array.isArray(list) && list.length > 0;
}

/**
 * Free text for a Slack message: escapes `&`, `<` and `>` per Slack's rules, so
 * no mention (`<!channel>`, `<@U…>`), channel link (`<#C…>`) or disguised link
 * (`<https://…|text>`) in a requester's reason renders as one.
 */
export function withoutSlackMentions(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Most extra attempts one retry_build_task call may grant. */
export const MAX_EXTRA_ATTEMPTS_PER_GRANT = 3;
/** Retry notes go into the brief verbatim; keep them a note, not a document. */
export const MAX_RETRY_REASON_CHARS = 2000;

/**
 * Metadata minus the person's retry note. Automatic re-arms (conflict,
 * failed checks) drop it: the note was written for one attempt, and a
 * conflict refund rewinds `attempts`, which would otherwise make the next
 * dispatch match `forAttempt` again and replay a stale note as current.
 */
export function withoutRetryNote(metadata: unknown): Record<string, unknown> {
  const { retryNote: _dropped, ...rest } = (metadata ?? {}) as Record<string, unknown>;
  return rest;
}

export function extraAttemptsOf(task: { metadata?: unknown }): number {
  const raw = ((task.metadata ?? {}) as { extraAttempts?: unknown }).extraAttempts;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 0;
}








export const RESULT_ARTIFACT_NAME = "programme-result";
/** Candidate runs inspected when finding a run for an attempt without evidence. */
export const RUN_SCAN_LIMIT = 10;
/**
 * How far back to scan when a task carries no `dispatchedAt` — tasks
 * dispatched before that was recorded, which includes the one that exposed the
 * need for this scan. Wide on purpose: the artifact's own attemptId is what
 * decides a match, so a long window costs API calls, never correctness.
 */
export const RUN_SCAN_FALLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Check name `programme-explore.yml` reports in its checks bundle. */
export const SWEEP_CHECK_NAME = "exploratory-sweep";

/**
 * Every non-terminal programme status — a programme that still owns its target
 * repository. COMPLETE and CANCELLED are absent by design: a finished or
 * abandoned programme serves no briefs and must not hold a repo against the
 * next rebuild of it.
 */
/** Dependencies whose merged PR is read for file hints, newest plan order first. */
/** Ids per cancel_build_tasks call. A whole over-planned milestone fits; a runaway does not. */
export const MAX_TASKS_PER_CANCEL = 200;

export const MAX_DEPENDENCIES_READ_FOR_HINTS = 6;
/** Hint paths carried in one brief. Advisory, so a cap costs nothing real. */
export const MAX_FILE_MANIFEST_HINTS = 120;

export const LIVE_PROGRAMME_STATUSES: ProgrammeStatus[] = [
  "PROPOSED",
  "SEEDED",
  "PLANNED",
  "BUILDING",
  "MILESTONE_REVIEW",
  "HARDENING",
  "PAUSED",
];

/**
 * Statuses a model bench can run on. A bench only compares models on one
 * planned screen, so it does not need the programme to be live: a finished or
 * cancelled programme keeps its planned tasks as the bench's source and holds
 * no repository slot, which is what lets a bench run beside a real programme.
 */
export const BENCH_HOST_STATUSES: ProgrammeStatus[] = [
  "PLANNED",
  "BUILDING",
  "MILESTONE_REVIEW",
  "PAUSED",
  "COMPLETE",
  "CANCELLED",
];

/** Arm statuses a bench tick still has work on (fold, re-arm or dispatch). */
export const OPEN_BENCH_ARM_STATUSES = new Set([
  "PENDING",
  "READY",
  "DISPATCHED",
  "EVIDENCE_RED",
  "EVIDENCE_GREEN",
  "HANDBACK",
  "FAILED",
]);

export const programmeMachine = new ProgrammeStateMachine();
export const milestoneMachine = new MilestoneStateMachine();
export const taskMachine = new BuildTaskStateMachine();

/**
 * Headings the technical spec must carry. The `technical-spec` task writes
 * them; every later brief tells the agent to follow them; the advance job
 * parses the last one to re-assign criteria to screen tasks. Named in one
 * place so the writer and the readers cannot drift apart.
 */
export const TECHNICAL_SPEC_SECTIONS = [
  "Purpose and scope",
  "Sources",
  "Stack and architecture",
  "Routing and screens",
  "Authentication and session state",
  "API mapping",
  "State, data and error handling",
  "Design system and accessibility",
  "Testing strategy",
  "Decisions",
  "Open questions",
  "Acceptance criteria by screen",
] as const;

/** Repo-relative path of a programme's technical spec inside the rebuild repo. */
export function technicalSpecPath(programmeKey: string): string {
  return `docs/technical-spec/${programmeKey}.md`;
}

/**
 * The technical spec a LATER milestone writes. The programme's
 * spec is written once, by the milestone that plans it, so it only covers
 * that milestone's screens; every milestone after it writes one of these,
 * which extends the programme's document for its own screens rather than
 * rewriting it.
 */
export function milestoneTechnicalSpecPath(programmeKey: string, ordinal: number): string {
  return `docs/technical-spec/${programmeKey}-m${ordinal}.md`;
}

/** Id of a later milestone's own technical-spec task, in the milestone's id space. */
export function milestoneTechnicalSpecTaskId(programmeKey: string, milestoneId: string): string {
  return `${programmeKey}:${milestoneId}:technical-spec`;
}

/** The document a technical-spec task writes: recorded on it at planning, else the programme's. */
export function specPathOf(programmeKey: string, task: BuildTaskRecord): string {
  const recorded = ((task.metadata ?? {}) as { specPath?: unknown }).specPath;
  return typeof recorded === "string" && recorded.length > 0 ? recorded : technicalSpecPath(programmeKey);
}

export function isTechnicalSpecTask(task: BuildTaskRecord): boolean {
  return (((task.metadata ?? {}) as { kind?: string }).kind ?? "") === "technical-spec";
}

export interface ProgrammeDecision {
  id: string;
  topic: string;
  decision: string;
  rationale?: string;
  decidedBy: string;
  recordedAt: string;
}

export interface ProgrammeMetadata {
  baseBranch?: string;
  trackingIssue?: { number: number; url: string };
  trackingIssueBodyHash?: string;
  originThreadKey?: string;
  decisions?: ProgrammeDecision[];
  /** Programme spec's mapping sha; kept for programmes planned before per-milestone specs. */
  technicalSpecMappingSha?: string;
  /** Applied mapping sha per technical-spec task id (the programme's and each milestone's). */
  technicalSpecMappingShas?: Record<string, string>;
  /**
   * Milestone plans recorded ahead of time (`propose_milestone_plan` with
   * `deferred: true`), keyed by milestone id. The advance job plans each one
   * once its spec is APPROVED and every earlier milestone's build is
   * complete (repoSettings `autoPlanQueuedMilestones`), so a programme of
   * many milestones ships in order without anyone asking for the next.
   * Removed once planned.
   */
  queuedPlans?: Record<string, QueuedMilestonePlan>;
}

export interface QueuedMilestonePlan {
  specId: string;
  screenStates: string[];
  queuedBy: string;
  queuedAt: string;
  /** The planner's latest refusal, posted once rather than every tick. */
  lastRefusal?: string;
}

export type BuildTaskStatusLike = BuildTaskRecord["status"];

/**
 * One line naming why the auto-merge gate refused a PR_OPEN task, from its
 * persisted verdict; null when there is no verdict yet or it allowed the merge.
 * Unbound / red criteria are counted rather than listed (a mis-planned task can
 * carry a hundred), with a few ids as examples; every other reason is quoted.
 */
export function gateRefusalLine(task: {
  id: string;
  prNumber?: number | null;
  acceptanceCriterionIds?: string[];
  lastMergeVerdict?: { allowed: boolean; reasons: string[] } | null;
}): string | null {
  const verdict = task.lastMergeVerdict;
  if (!verdict || verdict.allowed || verdict.reasons.length === 0) return null;
  // Only criteria the task still owns: a re-scope takes effect before the
  // next tick rewrites the verdict.
  const owned = task.acceptanceCriterionIds ? new Set(task.acceptanceCriterionIds) : null;
  const criteria = verdict.reasons
    .map((reason) => parseCriterionReason(reason))
    .filter((parsed): parsed is { criterionId: string; status: string } => parsed !== null)
    .filter((parsed) => !owned || owned.has(parsed.criterionId));
  const other = verdict.reasons.filter((reason) => parseCriterionReason(reason) === null);
  const parts: string[] = [];
  if (criteria.length > 0) {
    const byStatus = new Map<string, string[]>();
    for (const { criterionId, status } of criteria) byStatus.set(status, [...(byStatus.get(status) ?? []), criterionId]);
    for (const [status, ids] of byStatus) {
      parts.push(`${ids.length} criteria ${status} (${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ", …" : ""})`);
    }
  }
  parts.push(...other.slice(0, 4));
  if (other.length > 4) parts.push(`+${other.length - 4} more`);
  const filteredOut = verdict.reasons.some((reason) => {
    const parsed = parseCriterionReason(reason);
    return parsed !== null && owned !== null && !owned.has(parsed.criterionId);
  });
  if (parts.length === 0) {
    return filteredOut
      ? `Gate verdict for ${task.prNumber ? `#${task.prNumber}` : task.id} predates a criteria re-scope; re-judged on the next tick.`
      : null;
  }
  if (filteredOut) parts.push("criteria re-scoped since the last verdict; re-judged next tick");
  return `Gate refusing ${task.prNumber ? `#${task.prNumber}` : task.id} (\`${task.id}\`): ${parts.join("; ")}.`;
}

export function programmeMetadata(programme: ProgrammeRecord): ProgrammeMetadata {
  return (programme.metadata ?? {}) as ProgrammeMetadata;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * An attempt's token spend, read from the `token-usage` check its evidence
 * carries, in the attempt row's column shape. One entry per (model, phase):
 * a bundle that arrives twice (POST and artifact fallback) is counted once.
 * Cost is left NULL when any model is unpriced — a partial sum would read as
 * a complete, cheaper run. No usage at all leaves every column untouched.
 */
export function attemptSpendFromEvidence(
  rows: Array<Pick<RunEvidenceListRow, "checks">>,
  pricing: UsagePricing,
): { columns: Record<string, number | null>; unpricedModels: string[] } {
  const byKey = new Map<string, ReturnType<typeof parseTokenUsageChecks>[number]>();
  for (const row of rows) {
    for (const entry of parseTokenUsageChecks(row.checks)) byKey.set(`${entry.model}|${entry.phase}`, entry);
  }
  const entries = [...byKey.values()];
  if (entries.length === 0) return { columns: {}, unpricedModels: [] };
  const summary = summarizeTokenUsage(entries, pricing);
  const models = Object.values(summary.byModel);
  const sum = (pick: (m: (typeof models)[number]) => number) => models.reduce((s, m) => s + pick(m), 0);
  const reported = models.every((m) => m.reportedCostUsd !== null)
    ? models.reduce((s, m) => s + (m.reportedCostUsd ?? 0), 0)
    : null;
  return {
    columns: {
      inputTokens: sum((m) => m.inputTokens),
      cachedInputTokens: sum((m) => m.cacheReadTokens),
      cacheCreationInputTokens: sum((m) => m.cacheWriteTokens),
      outputTokens: sum((m) => m.outputTokens),
      estimatedCostUsd: summary.unpricedModels.length > 0 ? null : summary.totalEstimatedCostUsd,
      reportedCostUsd: reported,
    },
    unpricedModels: summary.unpricedModels,
  };
}

export function isProgrammeBuildResult(value: unknown): value is ProgrammeBuildResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.taskId === "string" &&
    typeof record.attemptId === "string" &&
    (record.status === "shipped" || record.status === "handback" || record.status === "failed")
  );
}

/**
 * Reads `<workdir>/.lexi/ac-bindings.json`, which the BUILD AGENT writes.
 *
 * It accepts two spellings of the criterion id because there are two in the
 * system and only one of them was ever read. The contract type says
 * `criterionId`; every agent writes `acceptanceCriterionId` — which is the
 * spelling the runner's own red-report schema asks for
 * (`{"failingTests":[{…,"acceptanceCriterionId":"AC-…"}]}`), so it is what the
 * agent has in hand when it writes the bindings file.
 *
 * Reading only `criterionId` would fail totally and silently: every binding
 * would be filtered out, so `deriveAcStatuses` would report EVERY criterion
 * `unbound` and `requireAcMatrixGreen` would refuse every task that owned one,
 * including a task whose binding file says `"status": "green"`. Tasks that own
 * no criteria have an empty matrix that trivially passes, which is why such a
 * defect can hide until the first criteria-owning task arrives.
 */
export function parseBindingsForTest(raw: string | null): AcceptanceTestBinding[] {
  return parseBindings(raw);
}

export function parseBindings(raw: string | null): AcceptanceTestBinding[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { bindings?: unknown };
    if (!Array.isArray(parsed.bindings)) return [];
    const rows: AcceptanceTestBinding[] = [];
    for (const entry of parsed.bindings) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const criterionId =
        typeof row.criterionId === "string"
          ? row.criterionId
          : typeof row.acceptanceCriterionId === "string"
            ? row.acceptanceCriterionId
            : null;
      if (!criterionId || typeof row.status !== "string") continue;
      rows.push({ ...row, criterionId, status: row.status } as unknown as AcceptanceTestBinding);
    }
    return rows;
  } catch {
    return [];
  }
}

export const MERGE_CONFLICT_REASON = "GitHub reports the pull request as not mergeable";

/** Milestone titles come from Slack and land in trustedInstruction. */
export const MAX_MILESTONE_TITLE_LENGTH = 120;
/** Screen names with no inventory to canonicalise them (built from scratch). */
export const FROM_SCRATCH_SCREEN_NAME = /^[A-Za-z0-9()/ _-]{1,64}$/;
export const MAX_FROM_SCRATCH_SCREENS = 30;


/**
 * The planned screen task a bench run repeats: an exact task id, else a screen
 * state spelled as the planner spells it (case-insensitive), else a unique
 * last-segment match — "login" finds "(auth)/login" when nothing else ends
 * that way. Ambiguity is refused with the candidates named, never guessed.
 */
export function resolveBenchSource(
  screens: BuildTaskRecord[],
  requested: string,
): { task: BuildTaskRecord; refusal?: undefined } | { task?: undefined; refusal: string } {
  const byId = screens.find((task) => task.id === requested);
  if (byId) return { task: byId };
  const wanted = requested.toLowerCase();
  const statesOf = (task: BuildTaskRecord) =>
    ((((task.metadata ?? {}) as { screenStates?: string[] }).screenStates ?? []) as string[]).map((state) =>
      state.toLowerCase(),
    );
  const exact = screens.filter((task) => statesOf(task).includes(wanted));
  const lastSegment = (value: string) => value.split("/").filter(Boolean).pop() ?? value;
  const candidates =
    exact.length > 0
      ? exact
      : screens.filter((task) => statesOf(task).some((state) => lastSegment(state) === lastSegment(wanted)));
  if (candidates.length === 1) return { task: candidates[0]! };
  if (candidates.length > 1) {
    return {
      refusal: `"${requested}" matches ${candidates.length} screen tasks — name one exactly: ${candidates.map((task) => task.id).join(", ")}.`,
    };
  }
  const sample = screens
    .flatMap((task) => statesOf(task))
    .slice(0, 12)
    .join(", ");
  return {
    refusal: `No planned screen task matches "${requested}". Plan it first with propose_milestone_plan${sample ? `; planned screens include ${sample}` : ""}.`,
  };
}
