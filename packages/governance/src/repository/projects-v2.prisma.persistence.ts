/**
 * Prisma-backed implementation of `ProjectsPersistence` for `ProjectsV2Service`.
 *
 * Backed by the `ProjectBoardItem` model (`project_board_items`), which is the
 * local mirror of a GitHub Projects v2 board. Every row is written by
 * `ProjectsV2Service` — either from `syncBoard()` (authoritative, pulled from
 * GitHub) or as a side effect of a placement/status mutation.
 *
 * The mirror is a cache, not a source of truth: reads here answer "what did we
 * last see on the board", which is only as fresh as the last sync. `lastSyncedAt`
 * is stamped on every write so callers can judge staleness.
 */

/**
 * The slice of the Prisma client this adapter uses.
 *
 * Declared structurally rather than importing `PrismaService` so the adapter can
 * be unit-tested with a plain object, and so a lagging generated client cannot
 * break the governance build. `PrismaService` satisfies this shape.
 */
export interface ProjectsPrismaClient {
  projectBoardItem: {
    findUnique(args: { where: Record<string, unknown> }): Promise<ProjectBoardItemRow | null>;
    findMany(args: {
      where?: Record<string, unknown>;
      select?: Record<string, boolean>;
      orderBy?: Record<string, unknown> | Array<Record<string, unknown>>;
      take?: number;
    }): Promise<ProjectBoardItemRow[]>;
    upsert(args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
  issue: {
    findMany(args: {
      where?: Record<string, unknown>;
      select?: Record<string, boolean>;
      orderBy?: Record<string, unknown> | Array<Record<string, unknown>>;
      take?: number;
    }): Promise<IssueRow[]>;
  };
}

export interface ProjectBoardItemRow {
  issueNumber?: number;
  issueRepository?: string;
  projectOrg?: string;
  projectNumber?: number;
  projectItemId?: string | null;
  status?: string | null;
  statusFieldId?: string | null;
  iteration?: string | null;
  priority?: string | null;
  assignee?: string | null;
  lastSyncedAt?: Date | null;
}

export interface IssueRow {
  githubNumber?: number;
  title?: string | null;
  labels?: string[] | null;
}

export interface BoardItemUpsert {
  issueNumber: number;
  issueRepository: string;
  projectOrg: string;
  projectNumber: number;
  projectItemId: string | null;
  status: string | null;
  iteration: string | null;
  priority: string | null;
  assignee: string | null;
}

export interface ProjectsPersistenceOptions {
  /**
   * Cap on the open-issue scan behind `getIssuesNotOnBoard`. The "not on board"
   * answer is a set difference computed in memory, so this bounds the query
   * rather than the answer.
   */
  unboardedScanLimit?: number;
}

const DEFAULT_UNBOARDED_SCAN_LIMIT = 500;

/** Splits an "owner/name" repository slug. Returns null when it is not a slug. */
function splitRepository(repository: string): { owner: string; name: string } | null {
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length > 0) return null;
  return { owner, name };
}

/**
 * Drops keys whose value is null/undefined.
 *
 * `ProjectsV2Service` passes a fully-populated item shape on every write, but
 * only some paths actually know every field: `addToBoard` and `updateStatus`
 * send `iteration: null, priority: null, assignee: null` because they are not
 * reading those from GitHub — not because the board has no values there. A
 * literal write would erase whatever the last `syncBoard()` recorded, so on
 * UPDATE a null means "leave alone" and only non-null values are applied.
 *
 * The trade-off: a field genuinely cleared on GitHub stays set locally until a
 * sync sees a different non-null value. That is the safer direction — a stale
 * priority is recoverable, a silently wiped one is not, and status (the field
 * that actually changes state) is always sent non-null by `updateStatus`.
 */
function withoutNulls(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

export class ProjectsV2PrismaPersistence {
  constructor(
    private readonly prisma: ProjectsPrismaClient,
    private readonly options: ProjectsPersistenceOptions = {},
  ) {}

  async upsertBoardItem(item: BoardItemUpsert): Promise<void> {
    const now = new Date();
    const identity = {
      issueNumber: item.issueNumber,
      issueRepository: item.issueRepository,
      projectOrg: item.projectOrg,
      projectNumber: item.projectNumber,
    };

    const mutable = {
      projectItemId: item.projectItemId,
      status: item.status,
      iteration: item.iteration,
      priority: item.priority,
      assignee: item.assignee,
    };

    await this.prisma.projectBoardItem.upsert({
      // Matches the @@unique([issueNumber, issueRepository, projectOrg, projectNumber]).
      where: { issueNumber_issueRepository_projectOrg_projectNumber: identity },
      create: { ...identity, ...mutable, lastSyncedAt: now, updatedAt: now },
      // `updatedAt` is `@default(now())` on this model, not `@updatedAt`, so
      // Prisma will not maintain it — set it explicitly or it stays at insert time.
      update: { ...withoutNulls(mutable), lastSyncedAt: now, updatedAt: now },
    });
  }

  async getBoardItem(
    issueNumber: number,
    issueRepository: string,
    projectOrg: string,
    projectNumber: number,
  ): Promise<{
    projectItemId: string | null;
    status: string | null;
    iteration: string | null;
    priority: string | null;
  } | null> {
    const row = await this.prisma.projectBoardItem.findUnique({
      where: {
        issueNumber_issueRepository_projectOrg_projectNumber: {
          issueNumber,
          issueRepository,
          projectOrg,
          projectNumber,
        },
      },
    });
    if (!row) return null;

    return {
      projectItemId: row.projectItemId ?? null,
      status: row.status ?? null,
      iteration: row.iteration ?? null,
      priority: row.priority ?? null,
    };
  }

  /**
   * Open issues in `repository` that have no row for this board.
   *
   * Computed as a set difference: the local mirror only stores what IS on the
   * board, so "not on board" cannot be expressed as a single query. This means
   * an un-synced board reports every issue as unboarded — see `lastSyncedAt`
   * before trusting a large result.
   */
  async getIssuesNotOnBoard(
    repository: string,
    projectOrg: string,
    projectNumber: number,
    filters?: { labels?: string[]; priority?: string },
  ): Promise<Array<{ issueNumber: number; title: string; labels: string[] }>> {
    const repo = splitRepository(repository);
    if (!repo) return [];

    const boarded = await this.prisma.projectBoardItem.findMany({
      where: { projectOrg, projectNumber, issueRepository: repository },
      select: { issueNumber: true },
    });
    const boardedNumbers = new Set(
      boarded.map((row) => row.issueNumber).filter((n): n is number => typeof n === "number"),
    );

    // Priority is carried as a label ("P1", "P2"…) — the Issue model has no
    // priority column — so it folds into the same hasEvery match.
    const requiredLabels = [...(filters?.labels ?? [])];
    if (filters?.priority) requiredLabels.push(filters.priority);

    const where: Record<string, unknown> = {
      state: "open",
      repoOwner: repo.owner,
      repoName: repo.name,
    };
    if (requiredLabels.length > 0) where.labels = { hasEvery: requiredLabels };

    const open = await this.prisma.issue.findMany({
      where,
      select: { githubNumber: true, title: true, labels: true },
      orderBy: { githubNumber: "desc" },
      take: this.options.unboardedScanLimit ?? DEFAULT_UNBOARDED_SCAN_LIMIT,
    });

    return open
      .filter((row) => typeof row.githubNumber === "number" && !boardedNumbers.has(row.githubNumber))
      .map((row) => ({
        issueNumber: row.githubNumber as number,
        title: row.title ?? "",
        labels: row.labels ?? [],
      }));
  }

  async getProjectItems(
    projectOrg: string,
    projectNumber: number,
    filters?: { status?: string; assignee?: string },
  ): Promise<
    Array<{
      issueNumber: number;
      issueRepository: string;
      status: string | null;
      priority: string | null;
      assignee: string | null;
    }>
  > {
    const where: Record<string, unknown> = { projectOrg, projectNumber };
    // Board field values are free text set by humans, so match case-insensitively
    // rather than making the caller guess "In Progress" vs "in progress".
    if (filters?.status) where.status = { equals: filters.status, mode: "insensitive" };
    if (filters?.assignee) where.assignee = { equals: filters.assignee, mode: "insensitive" };

    const rows = await this.prisma.projectBoardItem.findMany({
      where,
      orderBy: { issueNumber: "asc" },
    });

    return rows
      .filter(
        (row): row is ProjectBoardItemRow & { issueNumber: number; issueRepository: string } =>
          typeof row.issueNumber === "number" && typeof row.issueRepository === "string",
      )
      .map((row) => ({
        issueNumber: row.issueNumber,
        issueRepository: row.issueRepository,
        status: row.status ?? null,
        priority: row.priority ?? null,
        assignee: row.assignee ?? null,
      }));
  }

  /**
   * Most recent `lastSyncedAt` for a board, or null when never synced.
   *
   * Not part of `ProjectsPersistence` — exposed so a caller can decide whether to
   * refresh before trusting a read. Every "onBoard: false" answer from this
   * mirror is indistinguishable from "never synced" without it.
   */
  async getBoardLastSyncedAt(projectOrg: string, projectNumber: number): Promise<Date | null> {
    const rows = await this.prisma.projectBoardItem.findMany({
      where: { projectOrg, projectNumber },
      select: { lastSyncedAt: true },
      orderBy: { lastSyncedAt: "desc" },
      take: 1,
    });
    return rows[0]?.lastSyncedAt ?? null;
  }
}
