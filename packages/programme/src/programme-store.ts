import type {
  ApiContractDocument,
  AutoMergeVerdict,
  BuildTaskStatus,
  DesignContextDocument,
  MilestoneStatus,
  ProgrammeStatus,
} from "@lexi/contracts";

/**
 * Persistence seam for the rebuild programme domain. Kept narrow and
 * structural so the advance job and the tool executors can be tested against
 * `InMemoryProgrammeStore`. A Prisma-backed implementation over the
 * `AppRebuildProgramme`, `ProgrammeMilestone`, `BuildTask`,
 * `DesignContextDocument` and `ApiContractDocument` models belongs with the
 * orchestrator wiring, which is not part of this package.
 *
 * State-machine legality is NOT enforced here. The store records; the pure
 * machines in `@lexi/programme` decide. Callers must `assertTransition`
 * before every status write.
 */

export interface ProgrammeRecord {
  id: string;
  key: string;
  title: string;
  status: ProgrammeStatus;
  targetRepoKey: string;
  platform?: string | null;
  sourceSpecRepoKey?: string | null;
  sourceSpecIssueNumber?: number | null;
  figmaFileKeys: string[];
  designContextId?: string | null;
  /** The programme-level APPROVED spec (autopilot: milestones derive from it). */
  specId?: string | null;
  /** repos.yaml key of the existing production app (parity floor). */
  referenceRepoKey?: string | null;
  pausedReason?: string | null;
  createdBy?: string | null;
  /**
   * Json column for what a dedicated column each would not justify: `baseBranch`, `trackingIssue` ({number, url}),
   * `originThreadKey` (the Slack thread that commissioned it) and `decisions`
   * (what humans decided, verbatim, for every brief).
   */
  metadata?: Record<string, unknown> | null;
}

export interface MilestoneRecord {
  id: string;
  programmeId: string;
  ordinal: number;
  title: string;
  status: MilestoneStatus;
  specId?: string | null;
  reviewChannel?: string | null;
  reviewThreadTs?: string | null;
  approvedBy?: string | null;
  /** QuickFixAttempt id of the exploratory sweep judging this milestone's head. */
  sweepAttemptId?: string | null;
  /** Head SHA the current sweep was dispatched against. */
  sweepHeadSha?: string | null;
}

export interface BuildTaskRecord {
  id: string;
  programmeId: string;
  milestoneId: string;
  title: string;
  status: BuildTaskStatus;
  dependsOn: string[];
  codeRepoKey: string;
  acceptanceCriterionIds: string[];
  designContextNodeIds: string[];
  attempts: number;
  currentAttemptId?: string | null;
  prNumber?: number | null;
  mergedSha?: string | null;
  lastMergeVerdict?: AutoMergeVerdict | null;
  metadata?: Record<string, unknown> | null;
}

export interface ProgrammeStore {
  createProgramme(record: ProgrammeRecord): Promise<void>;
  getProgramme(key: string): Promise<ProgrammeRecord | null>;
  getProgrammeById(id: string): Promise<ProgrammeRecord | null>;
  listProgrammesByStatus(statuses: ProgrammeStatus[]): Promise<ProgrammeRecord[]>;
  updateProgramme(
    key: string,
    patch: Partial<Pick<ProgrammeRecord, "status" | "pausedReason" | "designContextId" | "specId" | "metadata">>,
  ): Promise<void>;

  createMilestones(records: MilestoneRecord[]): Promise<void>;
  listMilestones(programmeId: string): Promise<MilestoneRecord[]>;
  getMilestone(id: string): Promise<MilestoneRecord | null>;
  updateMilestone(
    id: string,
    patch: Partial<
      Pick<MilestoneRecord, "status" | "specId" | "reviewChannel" | "reviewThreadTs" | "approvedBy" | "sweepAttemptId" | "sweepHeadSha">
    >,
  ): Promise<void>;

  /** Idempotent by task id — re-planning upserts onto the same rows. */
  upsertBuildTasks(records: BuildTaskRecord[]): Promise<void>;
  listBuildTasks(programmeId: string): Promise<BuildTaskRecord[]>;
  getBuildTask(id: string): Promise<BuildTaskRecord | null>;
  getBuildTaskByAttempt(attemptId: string): Promise<BuildTaskRecord | null>;
  updateBuildTask(
    id: string,
    patch: Partial<
      Pick<
        BuildTaskRecord,
        | "status"
        | "attempts"
        | "currentAttemptId"
        | "prNumber"
        | "mergedSha"
        | "lastMergeVerdict"
        | "metadata"
        | "acceptanceCriterionIds"
      >
    >,
  ): Promise<void>;
  /**
   * Applies `patch` only while the task's status is one of `statuses`, in a
   * single conditional write. False when the row is missing or its status
   * moved. Optional so older doubles keep compiling; callers fall back to a
   * re-read then a plain update.
   */
  updateBuildTaskIfStatus?(id: string, statuses: BuildTaskRecord["status"][], patch: Partial<
      Pick<
        BuildTaskRecord,
        | "status"
        | "attempts"
        | "currentAttemptId"
        | "prNumber"
        | "mergedSha"
        | "lastMergeVerdict"
        | "metadata"
        | "acceptanceCriterionIds"
      >
    >): Promise<boolean>;

  saveDesignContext(document: DesignContextDocument): Promise<void>;
  getDesignContext(id: string): Promise<DesignContextDocument | null>;
  latestDesignContext(figmaFileKey: string): Promise<DesignContextDocument | null>;

  saveApiContract(document: ApiContractDocument): Promise<void>;
  getApiContract(id: string): Promise<ApiContractDocument | null>;
  /** Latest snapshot of one source document, keyed exactly as captured. */
  latestApiContract(sourceRepoSlug: string, sourcePath: string): Promise<ApiContractDocument | null>;
}

/** In-memory implementation: the test double, and a no-database fallback. */

/** Structural task metadata the planner owns; everything else is the advance job's. */
const STRUCTURAL_TASK_METADATA_KEYS = ["kind", "screenStates", "testKinds"] as const;

/**
 * Re-plan merge for a task's metadata: the planner's structural keys win, the
 * advance job's runtime keys (dispatchedAt, infraFaults, handbackReason,
 * headSha) are kept. Returns the existing value untouched when the plan
 * carries nothing structural.
 */
export function mergeStructuralMetadata(
  existing: Record<string, unknown> | null | undefined,
  planned: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(existing ?? {}) };
  for (const key of STRUCTURAL_TASK_METADATA_KEYS) {
    if (planned && planned[key] !== undefined) base[key] = planned[key];
  }
  return base;
}

export class InMemoryProgrammeStore implements ProgrammeStore {
  private readonly programmes = new Map<string, ProgrammeRecord>();
  private readonly milestones = new Map<string, MilestoneRecord>();
  private readonly tasks = new Map<string, BuildTaskRecord>();
  private readonly contexts = new Map<string, DesignContextDocument>();

  async createProgramme(record: ProgrammeRecord): Promise<void> {
    if (this.programmes.has(record.key)) {
      throw new Error(`programme ${record.key} already exists`);
    }
    this.programmes.set(record.key, { ...record });
  }

  async getProgrammeById(id: string): Promise<ProgrammeRecord | null> {
    return [...this.programmes.values()].find((p) => p.id === id) ?? null;
  }

  async getProgramme(key: string): Promise<ProgrammeRecord | null> {
    return this.programmes.get(key) ?? null;
  }

  async listProgrammesByStatus(statuses: ProgrammeStatus[]): Promise<ProgrammeRecord[]> {
    return [...this.programmes.values()].filter((p) => statuses.includes(p.status));
  }

  async updateProgramme(
    key: string,
    patch: Partial<Pick<ProgrammeRecord, "status" | "pausedReason" | "designContextId" | "specId" | "metadata">>,
  ): Promise<void> {
    const existing = this.programmes.get(key);
    if (!existing) throw new Error(`programme ${key} not found`);
    this.programmes.set(key, { ...existing, ...patch });
  }

  async createMilestones(records: MilestoneRecord[]): Promise<void> {
    for (const record of records) this.milestones.set(record.id, { ...record });
  }

  async listMilestones(programmeId: string): Promise<MilestoneRecord[]> {
    return [...this.milestones.values()]
      .filter((m) => m.programmeId === programmeId)
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  async getMilestone(id: string): Promise<MilestoneRecord | null> {
    return this.milestones.get(id) ?? null;
  }

  async updateMilestone(
    id: string,
    patch: Partial<
      Pick<MilestoneRecord, "status" | "specId" | "reviewChannel" | "reviewThreadTs" | "approvedBy" | "sweepAttemptId" | "sweepHeadSha">
    >,
  ): Promise<void> {
    const existing = this.milestones.get(id);
    if (!existing) throw new Error(`milestone ${id} not found`);
    this.milestones.set(id, { ...existing, ...patch });
  }

  async upsertBuildTasks(records: BuildTaskRecord[]): Promise<void> {
    for (const record of records) {
      const existing = this.tasks.get(record.id);
      // Upsert must never regress a live task: plan rows arrive PENDING, and
      // overwriting a DISPATCHED task's status with PENDING would re-dispatch
      // it. Only structural fields refresh on re-plan.
      if (existing) {
        this.tasks.set(record.id, {
          ...existing,
          title: record.title,
          dependsOn: record.dependsOn,
          acceptanceCriterionIds: record.acceptanceCriterionIds,
          designContextNodeIds: record.designContextNodeIds,
          // Structural metadata (kind, screenStates, testKinds) refreshes;
          // runtime keys the advance job wrote (dispatchedAt, infraFaults,
          // handbackReason, headSha) survive underneath.
          metadata: mergeStructuralMetadata(existing.metadata, record.metadata),
        });
      } else {
        this.tasks.set(record.id, { ...record });
      }
    }
  }

  async listBuildTasks(programmeId: string): Promise<BuildTaskRecord[]> {
    return [...this.tasks.values()].filter((t) => t.programmeId === programmeId);
  }

  async updateBuildTaskIfStatus(
    id: string,
    statuses: BuildTaskRecord["status"][],
    patch: Partial<BuildTaskRecord>,
  ): Promise<boolean> {
    const existing = this.tasks.get(id);
    if (!existing || !statuses.includes(existing.status)) return false;
    this.tasks.set(id, { ...existing, ...patch });
    return true;
  }

  async getBuildTask(id: string): Promise<BuildTaskRecord | null> {
    return this.tasks.get(id) ?? null;
  }

  async getBuildTaskByAttempt(attemptId: string): Promise<BuildTaskRecord | null> {
    return [...this.tasks.values()].find((t) => t.currentAttemptId === attemptId) ?? null;
  }

  async updateBuildTask(
    id: string,
    patch: Partial<
      Pick<
        BuildTaskRecord,
        | "status"
        | "attempts"
        | "currentAttemptId"
        | "prNumber"
        | "mergedSha"
        | "lastMergeVerdict"
        | "metadata"
        | "acceptanceCriterionIds"
      >
    >,
  ): Promise<void> {
    const existing = this.tasks.get(id);
    if (!existing) throw new Error(`build task ${id} not found`);
    this.tasks.set(id, { ...existing, ...patch });
  }

  async saveDesignContext(document: DesignContextDocument): Promise<void> {
    this.contexts.set(document.id, document);
  }

  async getDesignContext(id: string): Promise<DesignContextDocument | null> {
    return this.contexts.get(id) ?? null;
  }

  async latestDesignContext(figmaFileKey: string): Promise<DesignContextDocument | null> {
    const versions = [...this.contexts.values()].filter((d) => d.figmaFileKey === figmaFileKey);
    if (versions.length === 0) return null;
    return versions.reduce((latest, doc) => (doc.version > latest.version ? doc : latest));
  }

  private readonly apiContracts = new Map<string, ApiContractDocument>();

  async saveApiContract(document: ApiContractDocument): Promise<void> {
    this.apiContracts.set(document.id, document);
  }

  async getApiContract(id: string): Promise<ApiContractDocument | null> {
    return this.apiContracts.get(id) ?? null;
  }

  async latestApiContract(
    sourceRepoSlug: string,
    sourcePath: string,
  ): Promise<ApiContractDocument | null> {
    const versions = [...this.apiContracts.values()].filter(
      (d) => d.sourceRepoSlug === sourceRepoSlug && d.sourcePath === sourcePath,
    );
    if (versions.length === 0) return null;
    return versions.reduce((latest, doc) => (doc.version > latest.version ? doc : latest));
  }
}

/**
 * What a build brief needs from an approved spec. A read-only view
 * over `SpecSession` + the latest APPROVED `SpecDocument` — deliberately not
 * part of `SpecPipelineStore`, whose surface is the authoring flow's.
 */
export interface ApprovedSpecView {
  specId: string;
  revision: number;
  status: string;
  contentHash: string;
  issueNumber: number | null;
  trackingRepoKey: string | null;
  acceptanceCriteria: Array<{ id: string; text: string }>;
}

export interface ProgrammeSpecReader {
  /** Null when the spec is unknown OR has no APPROVED revision — same refusal. */
  loadApprovedSpec(specId: string): Promise<ApprovedSpecView | null>;
}

/**
 * Criteria as the approved document renders them (`- **AC-xxxxxxxx** — text`,
 * the spec template). Parsed from the RENDERED body rather than re-derived
 * from coverage answers so the ids in the brief are byte-identical to the
 * ids the reviewer approved.
 */
export function parseRenderedAcceptanceCriteria(body: string): Array<{ id: string; text: string }> {
  const criteria: Array<{ id: string; text: string }> = [];
  for (const match of body.matchAll(/\*\*(AC-[0-9a-f]{8})\*\*[ \t]*—[ \t]*(\S.*)$/gm)) {
    criteria.push({ id: match[1]!, text: match[2]!.trim() });
  }
  return criteria;
}
