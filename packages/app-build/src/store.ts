/**
 * Durable state for app-build: who started, stopped or steered which build,
 * and what the watcher has already relayed.
 *
 * Two implementations:
 *
 * - `InMemoryAppBuildStore`, the default. Fine for a single process and for
 *   tests; a restart forgets the relay state, so the watcher would treat every
 *   build PR as new (it relays only the newest report then, never the history).
 * - `AuditLogAppBuildStore`, which writes append-only rows to the existing
 *   `AuditLog` table through a narrow Prisma-shaped client. No new table: the
 *   rows double as the audit trail the mutating tools owe.
 *
 * Rows carry `details.prKey` (`owner/repo#number`) and never a thread key, so
 * they stay out of any conversation's recalled context.
 */

export const APP_BUILD_AUDIT_ACTIONS = {
  START: "app_build.start",
  STOP: "app_build.stop",
  FEEDBACK: "app_build.feedback",
  /** The watcher posted the chat parent message for a build PR. */
  THREAD: "app_build.thread",
  /** The watcher relayed one report or assessment comment. */
  RELAY: "app_build.relay",
  /** A one-off notice (ceiling warning, PR closed) the watcher must not repeat. */
  NOTICE: "app_build.notice",
} as const;

/** The actor recorded on rows the watcher writes. */
export const APP_BUILD_SYSTEM_ACTOR = "app-build-watcher";

export interface AppBuildRelayState {
  channel: string | null;
  threadTs: string | null;
  relayedCommentIds: Set<number>;
  /** Highest relayed comment id, or 0. GitHub comment ids grow with time. */
  lastRelayedCommentId: number;
  notices: Set<string>;
}

export interface AppBuildThreadRecord {
  app: string;
  channel: string;
  threadTs: string;
  prNumber: number;
  /** Comments that predate the thread: history, never relayed. */
  backlogCommentIds: number[];
}

export interface AppBuildStore {
  /** Records a tool action (start, stop, feedback) against the person who asked. */
  recordAction(actor: string, action: string, details: Record<string, unknown>): Promise<void>;
  /** The max_sessions last dispatched for this repository and app; null when the newest start passed none. */
  lastDispatchedMaxSessions(repository: string, app: string): Promise<number | null>;
  loadRelayState(prKey: string): Promise<AppBuildRelayState>;
  recordThread(prKey: string, details: AppBuildThreadRecord): Promise<void>;
  recordRelay(prKey: string, details: { app: string; commentId: number; kind: string; session: number | null }): Promise<void>;
  recordNotice(prKey: string, notice: string): Promise<void>;
}

export function appBuildPrKey(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`;
}

interface Row {
  actor: string;
  action: string;
  details: Record<string, unknown>;
}

const WATCHER_ACTIONS: readonly string[] = [
  APP_BUILD_AUDIT_ACTIONS.THREAD,
  APP_BUILD_AUDIT_ACTIONS.RELAY,
  APP_BUILD_AUDIT_ACTIONS.NOTICE,
];

function emptyRelayState(): AppBuildRelayState {
  return { channel: null, threadTs: null, relayedCommentIds: new Set(), lastRelayedCommentId: 0, notices: new Set() };
}

/** Folds watcher rows, newest first, into the relay state. Shared by both stores. */
function foldRelayRows(rows: Iterable<Row>): AppBuildRelayState {
  const state = emptyRelayState();
  for (const row of rows) {
    const details = row.details ?? {};
    if (row.action === APP_BUILD_AUDIT_ACTIONS.THREAD && state.threadTs === null) {
      if (typeof details.threadTs === "string") state.threadTs = details.threadTs;
      if (typeof details.channel === "string") state.channel = details.channel;
      // History is handled but is not the high-water mark, so a first-sight
      // relay that failed is still retried.
      for (const id of Array.isArray(details.backlogCommentIds) ? details.backlogCommentIds : []) {
        if (typeof id === "number") state.relayedCommentIds.add(id);
      }
    } else if (row.action === APP_BUILD_AUDIT_ACTIONS.RELAY && typeof details.commentId === "number") {
      state.relayedCommentIds.add(details.commentId);
      state.lastRelayedCommentId = Math.max(state.lastRelayedCommentId, details.commentId);
    } else if (row.action === APP_BUILD_AUDIT_ACTIONS.NOTICE && typeof details.notice === "string") {
      state.notices.add(details.notice);
    }
  }
  return state;
}

/** The newest start for this app decides: one that passed no cap left the caller's default in force. */
function lastMaxSessions(startsNewestFirst: Iterable<Row>, repository: string, app: string): number | null {
  for (const row of startsNewestFirst) {
    const details = row.details ?? {};
    if (details.repo !== repository || details.app !== app) continue;
    return typeof details.maxSessions === "number" && details.maxSessions > 0 ? details.maxSessions : null;
  }
  return null;
}

/** Process-local store. The default when the deployment provides none. */
export class InMemoryAppBuildStore implements AppBuildStore {
  /** Oldest first. Exposed for tests and diagnostics. */
  readonly rows: Row[] = [];

  async recordAction(actor: string, action: string, details: Record<string, unknown>): Promise<void> {
    this.rows.push({ actor, action, details: { ...details } });
  }

  async lastDispatchedMaxSessions(repository: string, app: string): Promise<number | null> {
    const starts = this.rows.filter((row) => row.action === APP_BUILD_AUDIT_ACTIONS.START).reverse();
    return lastMaxSessions(starts, repository, app);
  }

  async loadRelayState(prKey: string): Promise<AppBuildRelayState> {
    return foldRelayRows(
      this.rows.filter((row) => WATCHER_ACTIONS.includes(row.action) && row.details.prKey === prKey).reverse(),
    );
  }

  recordThread(prKey: string, details: AppBuildThreadRecord): Promise<void> {
    return this.recordAction(APP_BUILD_SYSTEM_ACTOR, APP_BUILD_AUDIT_ACTIONS.THREAD, { prKey, ...details });
  }

  recordRelay(prKey: string, details: { app: string; commentId: number; kind: string; session: number | null }): Promise<void> {
    return this.recordAction(APP_BUILD_SYSTEM_ACTOR, APP_BUILD_AUDIT_ACTIONS.RELAY, { prKey, ...details });
  }

  recordNotice(prKey: string, notice: string): Promise<void> {
    return this.recordAction(APP_BUILD_SYSTEM_ACTOR, APP_BUILD_AUDIT_ACTIONS.NOTICE, { prKey, notice });
  }
}

/**
 * The narrow slice of a Prisma client this store uses (the `AuditLog` model in
 * `packages/database/prisma/schema.prisma`), so it needs no generated client
 * and tests need no database. The JSON-path filter is PostgreSQL's.
 */
/** A JSON value as the audit table's `details` column accepts it. */
export type AuditJson = string | number | boolean | { readonly [key: string]: AuditJson | null } | ReadonlyArray<AuditJson | null>;

export interface AppBuildAuditPrisma {
  auditLog: {
    create(args: { data: { actor: string; action: string; details: AuditJson } }): Promise<unknown>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, "asc" | "desc">;
      take?: number;
    }): Promise<Array<{ actor: string; action: string; details: unknown }>>;
  };
}

/** Rows read per relay-state load; a build PR has far fewer comments than this. */
const RELAY_ROW_LIMIT = 500;

export class AuditLogAppBuildStore implements AppBuildStore {
  constructor(private readonly prisma: AppBuildAuditPrisma) {}

  async recordAction(actor: string, action: string, details: Record<string, unknown>): Promise<void> {
    // A JSON round trip drops undefined fields and turns dates into strings,
    // which is what the JSON column stores anyway.
    const json = JSON.parse(JSON.stringify(details)) as AuditJson;
    await this.prisma.auditLog.create({ data: { actor, action, details: json } });
  }

  async lastDispatchedMaxSessions(repository: string, app: string): Promise<number | null> {
    const rows = await this.prisma.auditLog.findMany({
      where: { action: APP_BUILD_AUDIT_ACTIONS.START, details: { path: ["repo"], equals: repository } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return lastMaxSessions(rows.map(asRow), repository, app);
  }

  async loadRelayState(prKey: string): Promise<AppBuildRelayState> {
    const rows = await this.prisma.auditLog.findMany({
      where: { action: { in: [...WATCHER_ACTIONS] }, details: { path: ["prKey"], equals: prKey } },
      orderBy: { createdAt: "desc" },
      take: RELAY_ROW_LIMIT,
    });
    return foldRelayRows(rows.map(asRow));
  }

  recordThread(prKey: string, details: AppBuildThreadRecord): Promise<void> {
    return this.recordAction(APP_BUILD_SYSTEM_ACTOR, APP_BUILD_AUDIT_ACTIONS.THREAD, { prKey, ...details });
  }

  recordRelay(prKey: string, details: { app: string; commentId: number; kind: string; session: number | null }): Promise<void> {
    return this.recordAction(APP_BUILD_SYSTEM_ACTOR, APP_BUILD_AUDIT_ACTIONS.RELAY, { prKey, ...details });
  }

  recordNotice(prKey: string, notice: string): Promise<void> {
    return this.recordAction(APP_BUILD_SYSTEM_ACTOR, APP_BUILD_AUDIT_ACTIONS.NOTICE, { prKey, notice });
  }
}

function asRow(row: { actor: string; action: string; details: unknown }): Row {
  const details = row.details && typeof row.details === "object" ? (row.details as Record<string, unknown>) : {};
  return { actor: row.actor, action: row.action, details };
}
