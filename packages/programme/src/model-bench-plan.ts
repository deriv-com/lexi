/**
 * Model bench on a rebuild programme — the same screen built once per model,
 * in parallel, so the rebuild bench (`/lexi diag rebuild-bench`) compares
 * models on identical work instead of on whatever a ladder happened to route
 * to them.
 *
 * A ladder is not a like-for-like comparison: its escalation rung only ever
 * sees the tasks the first rung failed. A bench arm is. Every arm copies one
 * source task — its criteria, design nodes, screen states and dependencies —
 * and differs from its siblings only in the model it is pinned to.
 *
 * Arms are rows on the programme's own build-task table, marked by
 * `metadata.bench`, so they need no schema change and are folded, evidenced
 * and priced by exactly the code that folds real tasks. What they must NOT do
 * is take part in the programme: eight implementations of one screen cannot
 * all merge, so an arm is never auto-merged, never counted toward milestone
 * completion or the final review, and never re-mapped by the technical spec.
 * `isBenchTask` is the one predicate every such gate filters on.
 */

export interface BenchArmMetadata {
  /** Groups the arms of one bench run. */
  runId: string;
  /** Pinned for every attempt — a retry re-runs the same model, never climbs. */
  model: string;
  /** The programme task whose work every arm of this run repeats. */
  sourceTaskId: string;
  startedBy: string;
  startedAt: string;
  /**
   * Agent effort every attempt of this arm runs at (`claude -p --effort`).
   * Absent = the CLI default, which is how every run before this field ran.
   */
  effort?: BenchEffort;
  /**
   * Branch or tag every attempt of this arm is built from and opens its PR
   * against, instead of the programme's working branch. Pins a bench to a
   * fixed base, so runs started weeks apart still build identical work.
   */
  baseRef?: string;
  /**
   * Started on a COMPLETE or CANCELLED programme. Only such arms are advanced
   * on a settled programme: cancel_programme leaves task rows as they were,
   * so an older run's handed-back arms must not be re-armed by a later tick.
   */
  standalone?: boolean;
}

/** A git branch or tag name: it becomes a dispatch ref and a PR base. */
export function isBenchBaseRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(value) &&
    !value.includes("..") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock")
  );
}

/** The CLI's own effort levels — the runner accepts nothing else. */
export const BENCH_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type BenchEffort = (typeof BENCH_EFFORTS)[number];

export function isBenchEffort(value: unknown): value is BenchEffort {
  return typeof value === "string" && (BENCH_EFFORTS as readonly string[]).includes(value);
}

interface TaskLike {
  id: string;
  metadata?: Record<string, unknown> | null;
}

export function benchArmOf(task: TaskLike): BenchArmMetadata | null {
  const bench = (task.metadata ?? {})["bench"];
  if (!bench || typeof bench !== "object") return null;
  const candidate = bench as Partial<BenchArmMetadata>;
  if (typeof candidate.model !== "string" || candidate.model.length === 0) return null;
  if (typeof candidate.runId !== "string" || typeof candidate.sourceTaskId !== "string") return null;
  // An unrecognised effort is dropped rather than trusted: it becomes a CLI flag.
  const { effort, baseRef, standalone, ...rest } = candidate as BenchArmMetadata;
  return {
    ...(rest as BenchArmMetadata),
    ...(isBenchEffort(effort) ? { effort } : {}),
    ...(isBenchBaseRef(baseRef) ? { baseRef } : {}),
    ...(standalone === true ? { standalone: true } : {}),
  };
}

export function isBenchTask(task: TaskLike): boolean {
  return benchArmOf(task) !== null;
}

/** The tasks that ARE the programme — everything but bench arms. */
export function withoutBenchTasks<T extends TaskLike>(tasks: T[]): T[] {
  return tasks.filter((task) => !isBenchTask(task));
}

/**
 * Branch- and id-safe form of a model name. The task id becomes the branch
 * `lexi/<id with : replaced by ->`, so anything outside [a-z0-9-] is folded.
 */
export function benchModelSlug(model: string): string {
  return (model.toLowerCase().match(/[a-z0-9]+/g) ?? []).join("-");
}

export function benchArmTaskId(sourceTaskId: string, runId: string, model: string): string {
  return `${sourceTaskId}:bench-${runId}-${benchModelSlug(model)}`;
}

export interface BenchSourceTask {
  id: string;
  programmeId: string;
  milestoneId: string;
  title: string;
  dependsOn: string[];
  codeRepoKey: string;
  acceptanceCriterionIds: string[];
  designContextNodeIds: string[];
  metadata?: Record<string, unknown> | null;
}

export interface BenchArmRow {
  id: string;
  programmeId: string;
  milestoneId: string;
  title: string;
  status: "PENDING";
  dependsOn: string[];
  codeRepoKey: string;
  acceptanceCriterionIds: string[];
  designContextNodeIds: string[];
  attempts: 0;
  metadata: Record<string, unknown>;
}

export type BenchPlan =
  | { ok: true; runId: string; arms: BenchArmRow[] }
  | { ok: false; reason: string };

export const MAX_BENCH_MODELS = 12;

/**
 * One arm per distinct model, each a copy of `source` pinned to that model.
 * Only a screen can be benched: it is the unit a model is judged on, and the
 * shared-infra tasks are what every arm builds ON.
 */
export function planModelBench(input: {
  source: BenchSourceTask;
  models: string[];
  runId: string;
  startedBy: string;
  now: Date;
  /** Applies to every arm of the run, so they differ only in the model. */
  effort?: string;
  /** Pinned base for every arm of the run; absent = the programme's branch. */
  baseRef?: string;
  /** The host programme is COMPLETE or CANCELLED (see BenchArmMetadata.standalone). */
  standalone?: boolean;
}): BenchPlan {
  const { source } = input;
  if (input.effort !== undefined && !isBenchEffort(input.effort)) {
    return { ok: false, reason: `Effort "${input.effort}" is not one of ${BENCH_EFFORTS.join(", ")}.` };
  }
  const effort = input.effort as BenchEffort | undefined;
  if (input.baseRef !== undefined && !isBenchBaseRef(input.baseRef)) {
    return { ok: false, reason: `Base "${input.baseRef}" is not a branch or tag name.` };
  }
  const baseRef = input.baseRef;
  if (isBenchTask(source)) {
    return { ok: false, reason: `${source.id} is itself a bench arm — bench the programme's own task.` };
  }
  const kind = String((source.metadata ?? {})["kind"] ?? "");
  if (kind !== "screen") {
    return { ok: false, reason: `${source.id} is a ${kind || "untyped"} task; only screen tasks can be benched.` };
  }
  if (!/^[a-z0-9]{1,16}$/.test(input.runId)) {
    return { ok: false, reason: `Bench run id "${input.runId}" must be 1-16 lowercase letters or digits.` };
  }
  const models = [...new Set(input.models.map((model) => model.trim()).filter(Boolean))];
  if (models.length === 0) return { ok: false, reason: "Name at least one model." };
  if (models.length > MAX_BENCH_MODELS) {
    return { ok: false, reason: `${models.length} models named; a bench run takes at most ${MAX_BENCH_MODELS}.` };
  }
  const slugs = new Map<string, string>();
  for (const model of models) {
    const slug = benchModelSlug(model);
    if (!slug) return { ok: false, reason: `Model name "${model}" has no usable characters.` };
    const clash = slugs.get(slug);
    if (clash) return { ok: false, reason: `"${clash}" and "${model}" would share the branch slug "${slug}".` };
    slugs.set(slug, model);
  }

  const inherited = { ...(source.metadata ?? {}) };
  // Per-attempt bookkeeping of the source task is not the arm's history.
  for (const key of [
    "dispatchedAt",
    "headSha",
    "handbackReason",
    "lastRetryReason",
    "cancelledReason",
    "infraFaults",
    "lastInfraFault",
    "conflictRearms",
  ]) {
    delete inherited[key];
  }
  const arms = models.map<BenchArmRow>((model) => ({
    id: benchArmTaskId(source.id, input.runId, model),
    programmeId: source.programmeId,
    milestoneId: source.milestoneId,
    title: `[bench ${model}${effort ? ` @ ${effort}` : ""}] ${source.title}`,
    status: "PENDING",
    dependsOn: [...source.dependsOn],
    codeRepoKey: source.codeRepoKey,
    acceptanceCriterionIds: [...source.acceptanceCriterionIds],
    designContextNodeIds: [...source.designContextNodeIds],
    attempts: 0,
    metadata: {
      ...inherited,
      kind: "screen",
      bench: {
        runId: input.runId,
        model,
        sourceTaskId: source.id,
        startedBy: input.startedBy,
        startedAt: input.now.toISOString(),
        ...(effort ? { effort } : {}),
        ...(baseRef ? { baseRef } : {}),
        ...(input.standalone ? { standalone: true } : {}),
      } satisfies BenchArmMetadata,
    },
  }));
  return { ok: true, runId: input.runId, arms };
}
