import type {
  ApiContractDocument,
  AutoMergeVerdict,
  BuildTaskStatus,
  DesignContextDocument,
  MilestoneStatus,
  ProgrammeStatus,
} from "@lexi/contracts";
import {
  mergeStructuralMetadata,
  parseRenderedAcceptanceCriteria,
  type ApprovedSpecView,
  type BuildTaskRecord,
  type MilestoneRecord,
  type ProgrammeRecord,
  type ProgrammeSpecReader,
  type ProgrammeStore,
} from "../programme-store";
import {
  definedOnly,
  isoString,
  prismaDelegate,
  stringArray,
  type PrismaDelegate,
  type PrismaDelegateHost,
} from "./prisma-delegate";

type ProgrammePatch = Partial<Pick<ProgrammeRecord, "status" | "pausedReason" | "designContextId" | "specId" | "metadata">>;
type MilestonePatch = Partial<
  Pick<MilestoneRecord, "status" | "specId" | "reviewChannel" | "reviewThreadTs" | "approvedBy" | "sweepAttemptId" | "sweepHeadSha">
>;
type TaskPatch = Partial<
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
>;

/**
 * `ProgrammeStore` over the `AppRebuildProgramme`, `ProgrammeMilestone`,
 * `BuildTask`, `DesignContextDocument` and `ApiContractDocument` models.
 *
 * Every create writes EVERY field of its record. The in-memory store keeps
 * whatever it is handed, so a column this store forgets to write passes the
 * whole engine suite and then reads back as null in production — a task's
 * metadata, a milestone's approver, a programme's design context. The specs
 * guard that by round-tripping fully populated records through both stores
 * against a fake client that only knows the columns in `schema.prisma`.
 *
 * State-machine legality is NOT enforced here. The store records; the pure
 * machines decide. Callers must `assertTransition` before every status write.
 */
export class PrismaProgrammeStore implements ProgrammeStore {
  constructor(private readonly prisma: PrismaDelegateHost) {}

  private delegate(name: string): PrismaDelegate {
    return prismaDelegate(this.prisma, name);
  }

  /* ------------------------------------------------------------ programmes */

  private toProgramme(row: Record<string, unknown>): ProgrammeRecord {
    return {
      id: String(row.id),
      key: String(row.key),
      title: String(row.title),
      status: String(row.status) as ProgrammeStatus,
      targetRepoKey: String(row.targetRepoKey),
      platform: (row.platform as string | null) ?? null,
      sourceSpecRepoKey: (row.sourceSpecRepoKey as string | null) ?? null,
      sourceSpecIssueNumber: (row.sourceSpecIssueNumber as number | null) ?? null,
      figmaFileKeys: stringArray(row.figmaFileKeys),
      designContextId: (row.designContextId as string | null) ?? null,
      specId: (row.specId as string | null) ?? null,
      referenceRepoKey: (row.referenceRepoKey as string | null) ?? null,
      pausedReason: (row.pausedReason as string | null) ?? null,
      createdBy: (row.createdBy as string | null) ?? null,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    };
  }

  async createProgramme(record: ProgrammeRecord): Promise<void> {
    await this.delegate("appRebuildProgramme").create({
      data: {
        id: record.id,
        key: record.key,
        title: record.title,
        status: record.status,
        targetRepoKey: record.targetRepoKey,
        platform: record.platform ?? null,
        sourceSpecRepoKey: record.sourceSpecRepoKey ?? null,
        sourceSpecIssueNumber: record.sourceSpecIssueNumber ?? null,
        figmaFileKeys: record.figmaFileKeys,
        designContextId: record.designContextId ?? null,
        specId: record.specId ?? null,
        referenceRepoKey: record.referenceRepoKey ?? null,
        pausedReason: record.pausedReason ?? null,
        createdBy: record.createdBy ?? null,
        // A nullable Json column takes no plain null in a Prisma write; the
        // column's default is already NULL, so absence is the null.
        ...(record.metadata ? { metadata: record.metadata } : {}),
      },
    });
  }

  async getProgrammeById(id: string): Promise<ProgrammeRecord | null> {
    const row = await this.delegate("appRebuildProgramme").findUnique({ where: { id } });
    return row ? this.toProgramme(row) : null;
  }

  async getProgramme(key: string): Promise<ProgrammeRecord | null> {
    const row = await this.delegate("appRebuildProgramme").findUnique({ where: { key } });
    return row ? this.toProgramme(row) : null;
  }

  async listProgrammesByStatus(statuses: ProgrammeStatus[]): Promise<ProgrammeRecord[]> {
    const rows = await this.delegate("appRebuildProgramme").findMany({
      where: { status: { in: statuses } },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => this.toProgramme(row));
  }

  async updateProgramme(key: string, patch: ProgrammePatch): Promise<void> {
    await this.delegate("appRebuildProgramme").update({ where: { key }, data: definedOnly({ ...patch }) });
  }

  /* ------------------------------------------------------------ milestones */

  private toMilestone(row: Record<string, unknown>): MilestoneRecord {
    return {
      id: String(row.id),
      programmeId: String(row.programmeId),
      ordinal: Number(row.ordinal),
      title: String(row.title),
      status: String(row.status) as MilestoneStatus,
      specId: (row.specId as string | null) ?? null,
      reviewChannel: (row.reviewChannel as string | null) ?? null,
      reviewThreadTs: (row.reviewThreadTs as string | null) ?? null,
      approvedBy: (row.approvedBy as string | null) ?? null,
      sweepAttemptId: (row.sweepAttemptId as string | null) ?? null,
      sweepHeadSha: (row.sweepHeadSha as string | null) ?? null,
    };
  }

  async createMilestones(records: MilestoneRecord[]): Promise<void> {
    for (const record of records) {
      // `approvedBy` is not planner data: it arrives on the synthetic
      // ordinal-0 row that records a hardening conclusion, which is written
      // through THIS method. The hardening gate reads exactly that field, so
      // a create that dropped it would leave a concluded pass open for ever.
      const approval = record.approvedBy ? { approvedBy: record.approvedBy, approvedAt: new Date() } : {};
      await this.delegate("programmeMilestone").upsert({
        where: { id: record.id },
        // An existing row stays as it is (creation is idempotent for the
        // planner) EXCEPT for an approval it does not yet carry: a retry of
        // the conclusion must be able to repair a row written without one.
        update: approval,
        create: {
          id: record.id,
          programmeId: record.programmeId,
          ordinal: record.ordinal,
          title: record.title,
          status: record.status,
          specId: record.specId ?? null,
          reviewChannel: record.reviewChannel ?? null,
          reviewThreadTs: record.reviewThreadTs ?? null,
          sweepAttemptId: record.sweepAttemptId ?? null,
          sweepHeadSha: record.sweepHeadSha ?? null,
          ...approval,
        },
      });
    }
  }

  async listMilestones(programmeId: string): Promise<MilestoneRecord[]> {
    const rows = await this.delegate("programmeMilestone").findMany({
      where: { programmeId },
      orderBy: { ordinal: "asc" },
    });
    return rows.map((row) => this.toMilestone(row));
  }

  async getMilestone(id: string): Promise<MilestoneRecord | null> {
    const row = await this.delegate("programmeMilestone").findUnique({ where: { id } });
    return row ? this.toMilestone(row) : null;
  }

  async updateMilestone(id: string, patch: MilestonePatch): Promise<void> {
    const data = definedOnly({ ...patch });
    // The approval time follows the approver: set with it, cleared with it.
    if (patch.approvedBy !== undefined) data.approvedAt = patch.approvedBy === null ? null : new Date();
    await this.delegate("programmeMilestone").update({ where: { id }, data });
  }

  /* ----------------------------------------------------------- build tasks */

  private toTask(row: Record<string, unknown>): BuildTaskRecord {
    return {
      id: String(row.id),
      programmeId: String(row.programmeId),
      milestoneId: String(row.milestoneId),
      title: String(row.title),
      status: String(row.status) as BuildTaskStatus,
      dependsOn: stringArray(row.dependsOn),
      codeRepoKey: String(row.codeRepoKey),
      acceptanceCriterionIds: stringArray(row.acceptanceCriterionIds),
      designContextNodeIds: stringArray(row.designContextNodeIds),
      attempts: Number(row.attempts ?? 0),
      currentAttemptId: (row.currentAttemptId as string | null) ?? null,
      prNumber: (row.prNumber as number | null) ?? null,
      mergedSha: (row.mergedSha as string | null) ?? null,
      lastMergeVerdict: (row.lastMergeVerdict as AutoMergeVerdict | null) ?? null,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    };
  }

  async upsertBuildTasks(records: BuildTaskRecord[]): Promise<void> {
    for (const record of records) {
      // Read first: Prisma cannot merge a Json column in an update, and a
      // blind write would erase the runtime keys the advance job stored.
      const existing = await this.delegate("buildTask").findUnique({ where: { id: record.id } });
      await this.delegate("buildTask").upsert({
        where: { id: record.id },
        // Re-planning refreshes STRUCTURE only: status, attempts and the PR
        // fields belong to the advance job and survive a re-plan untouched.
        update: {
          title: record.title,
          dependsOn: record.dependsOn,
          acceptanceCriterionIds: record.acceptanceCriterionIds,
          designContextNodeIds: record.designContextNodeIds,
          metadata: mergeStructuralMetadata(
            (existing?.metadata as Record<string, unknown> | null | undefined) ?? null,
            record.metadata,
          ),
        },
        create: {
          id: record.id,
          programmeId: record.programmeId,
          milestoneId: record.milestoneId,
          title: record.title,
          status: record.status,
          dependsOn: record.dependsOn,
          codeRepoKey: record.codeRepoKey,
          acceptanceCriterionIds: record.acceptanceCriterionIds,
          designContextNodeIds: record.designContextNodeIds,
          attempts: record.attempts,
          currentAttemptId: record.currentAttemptId ?? null,
          prNumber: record.prNumber ?? null,
          mergedSha: record.mergedSha ?? null,
          ...(record.lastMergeVerdict ? { lastMergeVerdict: record.lastMergeVerdict } : {}),
          // Without metadata at creation every task reads as kind "screen":
          // a document task gets a screen brief and the runner skips its
          // drafting phase.
          ...(record.metadata ? { metadata: record.metadata } : {}),
        },
      });
    }
  }

  async listBuildTasks(programmeId: string): Promise<BuildTaskRecord[]> {
    const rows = await this.delegate("buildTask").findMany({
      where: { programmeId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => this.toTask(row));
  }

  async getBuildTask(id: string): Promise<BuildTaskRecord | null> {
    const row = await this.delegate("buildTask").findUnique({ where: { id } });
    return row ? this.toTask(row) : null;
  }

  async getBuildTaskByAttempt(attemptId: string): Promise<BuildTaskRecord | null> {
    const row = await this.delegate("buildTask").findFirst({ where: { currentAttemptId: attemptId } });
    return row ? this.toTask(row) : null;
  }

  async updateBuildTask(id: string, patch: TaskPatch): Promise<void> {
    await this.delegate("buildTask").update({ where: { id }, data: definedOnly({ ...patch }) });
  }

  async updateBuildTaskIfStatus(id: string, statuses: BuildTaskStatus[], patch: TaskPatch): Promise<boolean> {
    const delegate = this.delegate("buildTask");
    const data = definedOnly({ ...patch });
    if (typeof delegate.updateMany === "function") {
      const result = await delegate.updateMany({ where: { id, status: { in: statuses } }, data });
      return (result?.count ?? 0) > 0;
    }
    // A delegate without updateMany: read, then write.
    const row = await delegate.findUnique({ where: { id } });
    if (!row || !statuses.includes(row.status as BuildTaskStatus)) return false;
    await delegate.update({ where: { id }, data });
    return true;
  }

  /* ------------------------------------------------------- design context */

  async saveDesignContext(document: DesignContextDocument): Promise<void> {
    await this.delegate("designContextDocument").upsert({
      where: { figmaFileKey_version: { figmaFileKey: document.figmaFileKey, version: document.version } },
      // A snapshot is immutable: a re-save of the same version is a no-op.
      update: {},
      create: {
        id: document.id,
        figmaFileKey: document.figmaFileKey,
        version: document.version,
        capturedAt: new Date(document.capturedAt),
        content: { states: document.states },
        ...(document.componentCatalogue != null ? { componentCatalogue: document.componentCatalogue } : {}),
      },
    });
  }

  private toContext(row: Record<string, unknown>): DesignContextDocument {
    const content = (row.content ?? {}) as { states?: DesignContextDocument["states"] };
    return {
      id: String(row.id),
      figmaFileKey: String(row.figmaFileKey),
      version: Number(row.version),
      capturedAt: isoString(row.capturedAt),
      states: content.states ?? [],
      ...(row.componentCatalogue != null ? { componentCatalogue: row.componentCatalogue } : {}),
    };
  }

  async getDesignContext(id: string): Promise<DesignContextDocument | null> {
    const row = await this.delegate("designContextDocument").findUnique({ where: { id } });
    return row ? this.toContext(row) : null;
  }

  async latestDesignContext(figmaFileKey: string): Promise<DesignContextDocument | null> {
    const row = await this.delegate("designContextDocument").findFirst({
      where: { figmaFileKey },
      orderBy: { version: "desc" },
    });
    return row ? this.toContext(row) : null;
  }

  /* --------------------------------------------------------- API contract */

  private toApiContract(row: Record<string, unknown>): ApiContractDocument {
    const info = (row.info ?? {}) as { title?: unknown; version?: unknown };
    return {
      id: String(row.id),
      sourceRepoSlug: String(row.sourceRepoSlug),
      sourcePath: String(row.sourcePath),
      sourceSha: String(row.sourceSha),
      version: Number(row.version),
      capturedAt: isoString(row.capturedAt),
      info: {
        title: typeof info.title === "string" ? info.title : "unknown",
        version: typeof info.version === "string" ? info.version : "unknown",
      },
      operations: (Array.isArray(row.operations) ? row.operations : []) as ApiContractDocument["operations"],
      excludedOperationCount: Number(row.excludedOperationCount ?? 0),
      spec: row.spec,
    };
  }

  async saveApiContract(document: ApiContractDocument): Promise<void> {
    await this.delegate("apiContractDocument").upsert({
      where: {
        sourceRepoSlug_sourcePath_version: {
          sourceRepoSlug: document.sourceRepoSlug,
          sourcePath: document.sourcePath,
          version: document.version,
        },
      },
      update: {},
      create: {
        id: document.id,
        sourceRepoSlug: document.sourceRepoSlug,
        sourcePath: document.sourcePath,
        sourceSha: document.sourceSha,
        version: document.version,
        capturedAt: new Date(document.capturedAt),
        info: document.info,
        operations: document.operations,
        excludedOperationCount: document.excludedOperationCount,
        spec: document.spec ?? {},
      },
    });
  }

  async getApiContract(id: string): Promise<ApiContractDocument | null> {
    const row = await this.delegate("apiContractDocument").findUnique({ where: { id } });
    return row ? this.toApiContract(row) : null;
  }

  async latestApiContract(sourceRepoSlug: string, sourcePath: string): Promise<ApiContractDocument | null> {
    const row = await this.delegate("apiContractDocument").findFirst({
      where: { sourceRepoSlug, sourcePath },
      orderBy: { version: "desc" },
    });
    return row ? this.toApiContract(row) : null;
  }
}

/**
 * Reads the latest APPROVED revision of a spec from `SpecDocument`. Read-only,
 * and deliberately separate from the authoring flow's store.
 */
export class PrismaProgrammeSpecReader implements ProgrammeSpecReader {
  constructor(private readonly prisma: PrismaDelegateHost) {}

  async loadApprovedSpec(specId: string): Promise<ApprovedSpecView | null> {
    const documents = (this.prisma as Record<string, PrismaDelegate | undefined>).specDocument;
    if (!documents) return null;
    const row = await documents.findFirst({
      where: { sessionId: specId, status: "APPROVED" },
      orderBy: { revision: "desc" },
    });
    if (!row) return null;
    return {
      specId,
      revision: Number(row.revision),
      status: String(row.status),
      contentHash: String(row.contentHash ?? ""),
      issueNumber: row.issueNumber == null ? null : Number(row.issueNumber),
      trackingRepoKey: (row.trackingRepoKey as string | null) ?? null,
      acceptanceCriteria: parseRenderedAcceptanceCriteria(String(row.body ?? "")),
    };
  }
}
