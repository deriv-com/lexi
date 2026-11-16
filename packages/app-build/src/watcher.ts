import type { AppBuildWorkflowRun } from "./github-port";
import type { AppBuildReader, AppBuildSnapshot, AppBuildTarget, BuildAssessmentComment, BuildComment, BuildReportComment } from "./reader";
import { APP_BUILD_APPS, APP_BUILD_CEILING_WARNING_RATIO, appBuildLabel, clampForSlack, type AppBuildApp, type ParsedSessionReport } from "./report";
import { appBuildPrKey, type AppBuildRelayState, type AppBuildStore } from "./store";

/**
 * Relays the build loop's PR comments into a chat thread.
 *
 * For each watched repository and app it finds the build PR and posts:
 *
 *   - one parent message per build PR, the first time it sees that PR open;
 *   - one reply per new session report (session n of max, phase, what was
 *     done, gate verdict, questions only a person can answer, cost), leading
 *     with the stop reason when the loop stopped;
 *   - one reply per new assessment (checks, review);
 *   - a single heads-up once a session reaches the ceiling-warning share of
 *     max_sessions, and a single note when the PR is closed.
 *
 * Dedupe is by GitHub comment id, kept in the store, so a restart with a
 * durable store neither repeats nor drops a relay. A relay is recorded only
 * after the chat accepted it, so a failed post is retried on the next tick.
 * On first sight of a PR only the newest report and assessment are relayed:
 * the history of a build that predates the watcher is not replayed.
 *
 * Plain mrkdwn text only: an oversized block card is rejected whole.
 */

/** The one chat call the watcher makes. `SlackProvider` and its mutation gateway satisfy it. */
export interface AppBuildChatPort {
  sendMessage(payload: { channel: string; text: string; threadTs?: string }): Promise<{ ok: boolean; ts?: string; error?: string }>;
}

export interface AppBuildWatchTarget {
  target: AppBuildTarget;
  /** The chat channel this repository's builds are relayed to. */
  channel: string;
}

export interface AppBuildWatchSummary {
  apps: number;
  threadsCreated: number;
  relayed: number;
  notices: number;
  errors: number;
}

export interface AppBuildWatcherOptions {
  reader: AppBuildReader;
  store: AppBuildStore;
  chat: AppBuildChatPort;
  /** The repositories to watch and where each one's builds are relayed. */
  targets: readonly AppBuildWatchTarget[];
  /** Default five minutes. */
  intervalMs?: number;
  /** A fixed ref for reading the caller workflow's defaults. Default: the repository's default branch. */
  workflowRef?: string;
  logger?: { warn(message: string, context?: string): void };
}

export const DEFAULT_APP_BUILD_WATCH_INTERVAL_MS = 5 * 60_000;

export class AppBuildWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<AppBuildWatchSummary> | null = null;
  /**
   * Parent threads the chat accepted but the store did not: without this, a
   * failed `recordThread` would post a new parent message on every tick.
   */
  private readonly unrecordedThreads = new Map<string, { threadTs: string; channel: string }>();

  constructor(private readonly options: AppBuildWatcherOptions) {}

  /** Starts ticking. Idempotent. The timer does not keep the process alive. */
  start(): void {
    if (this.timer) return;
    const interval = this.options.intervalMs ?? DEFAULT_APP_BUILD_WATCH_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.warn(`app-build watcher tick failed: ${describe(error)}`));
    }, interval);
    this.timer.unref?.();
  }

  /** Stops ticking and waits for a tick in flight to finish. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** One pass over every watched repository and app. A tick in flight is joined, not doubled. */
  tick(): Promise<AppBuildWatchSummary> {
    if (!this.running) {
      this.running = this.runTick().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runTick(): Promise<AppBuildWatchSummary> {
    const summary: AppBuildWatchSummary = { apps: 0, threadsCreated: 0, relayed: 0, notices: 0, errors: 0 };
    const { reader } = this.options;
    for (const { target, channel } of this.options.targets) {
      if (!channel.trim()) continue;
      const runs = (await reader.recentRuns(target).catch(() => null)) ?? [];
      const ref = this.options.workflowRef?.trim() || (await reader.defaultBranch(target).catch(() => null)) || null;
      for (const app of APP_BUILD_APPS) {
        summary.apps += 1;
        try {
          await this.watchApp(target, channel.trim(), app, runs, ref, summary);
        } catch (error) {
          summary.errors += 1;
          this.warn(`app-build watcher: ${app} on ${target.slug} failed: ${describe(error)}`);
        }
      }
    }
    return summary;
  }

  private async watchApp(
    target: AppBuildTarget,
    defaultChannel: string,
    app: AppBuildApp,
    runs: AppBuildWorkflowRun[],
    ref: string | null,
    summary: AppBuildWatchSummary,
  ): Promise<void> {
    const { reader, store, chat } = this.options;
    const snapshot = await reader.snapshot(target, app);
    const pr = snapshot.pr;
    if (!pr) return;
    const prKey = appBuildPrKey(target.owner, target.repo, pr.number);
    const state = await store.loadRelayState(prKey);
    const remembered = this.unrecordedThreads.get(prKey);
    if (state.threadTs === null && remembered) {
      state.threadTs = remembered.threadTs;
      state.channel = remembered.channel;
    }
    const firstSight = state.threadTs === null;
    // A PR that was already closed before it was ever seen is history, not news.
    if (firstSight && pr.state === "closed") return;

    const pending = pendingComments(snapshot, state, firstSight);
    if (firstSight) {
      const posted = await chat.sendMessage({ channel: defaultChannel, text: parentText(app, pr.number, pr.url, target.slug) });
      if (!posted.ok || !posted.ts) throw new Error(`the chat refused the parent message: ${posted.error ?? "no ts"}`);
      const relayNow = new Set(pending.map((c) => c.id));
      const backlogCommentIds = snapshot.comments.map((c) => c.id).filter((id) => !relayNow.has(id));
      try {
        await store.recordThread(prKey, { app, channel: defaultChannel, threadTs: posted.ts, prNumber: pr.number, backlogCommentIds });
        this.unrecordedThreads.delete(prKey);
      } catch (error) {
        this.unrecordedThreads.set(prKey, { threadTs: posted.ts, channel: defaultChannel });
        this.warn(`app-build thread for ${prKey} posted but not recorded: ${describe(error)}`);
      }
      for (const id of backlogCommentIds) state.relayedCommentIds.add(id);
      state.threadTs = posted.ts;
      state.channel = defaultChannel;
      summary.threadsCreated += 1;
    }

    const channel = state.channel ?? defaultChannel;
    const threadTs = state.threadTs!;
    let maxSessions: number | null | undefined;
    const max = async (): Promise<number | null> => {
      if (maxSessions === undefined) maxSessions = ref ? await reader.maxSessions(target, app, runs, ref).catch(() => null) : null;
      return maxSessions;
    };

    for (const comment of pending) {
      const text =
        comment.parsed.kind === "report"
          ? reportText(app, comment as BuildReportComment, await max())
          : assessmentText(comment as BuildAssessmentComment);
      const posted = await chat.sendMessage({ channel, threadTs, text: clampForSlack(text) });
      if (!posted.ok) throw new Error(`the chat refused the relay of comment ${comment.id}: ${posted.error ?? "unknown"}`);
      await store.recordRelay(prKey, { app, commentId: comment.id, kind: comment.parsed.kind, session: comment.parsed.session });
      summary.relayed += 1;
      if (comment.parsed.kind === "report") {
        await this.maybeWarnCeiling(prKey, state, app, comment.parsed, await max(), channel, threadTs, summary);
      }
    }

    if (pr.state === "closed" && !state.notices.has("closed")) {
      const posted = await chat.sendMessage({
        channel,
        threadTs,
        text: `PR #${pr.number} was closed, so the ${appBuildLabel(app)} build loop has stopped. A new build starts a new PR.`,
      });
      if (posted.ok) {
        await store.recordNotice(prKey, "closed");
        state.notices.add("closed");
        summary.notices += 1;
      }
    }
  }

  private async maybeWarnCeiling(
    prKey: string,
    state: AppBuildRelayState,
    app: AppBuildApp,
    report: ParsedSessionReport,
    max: number | null,
    channel: string,
    threadTs: string,
    summary: AppBuildWatchSummary,
  ): Promise<void> {
    if (report.session === null || max === null || report.stopReason !== null) return;
    if (state.notices.has("ceiling")) return;
    if (report.session < Math.ceil(max * APP_BUILD_CEILING_WARNING_RATIO)) return;
    const posted = await this.options.chat.sendMessage({
      channel,
      threadTs,
      text:
        `Heads up: the ${appBuildLabel(app)} build has used ${report.session} of ${max} sessions ` +
        `(${Math.round((report.session / max) * 100)}% of max_sessions). It stops at ${max}; to give it more, ` +
        "resume it afterwards with a higher maxSessions.",
    });
    if (posted.ok) {
      await this.options.store.recordNotice(prKey, "ceiling");
      state.notices.add("ceiling");
      summary.notices += 1;
    }
  }

  private warn(message: string): void {
    this.options.logger?.warn(message, "AppBuildWatcher");
  }
}

/** New build comments in id order; on first sight, only the newest report and assessment. */
function pendingComments(snapshot: AppBuildSnapshot, state: AppBuildRelayState, firstSight: boolean): BuildComment[] {
  if (firstSight) {
    const newest: BuildComment[] = [];
    if (snapshot.latestReport) newest.push(snapshot.latestReport);
    if (snapshot.latestAssessment) newest.push(snapshot.latestAssessment);
    return newest.sort((a, b) => a.id - b.id);
  }
  return snapshot.comments.filter((c) => c.id > state.lastRelayedCommentId && !state.relayedCommentIds.has(c.id));
}

/** Slack mrkdwn needs &, < and > escaped in text that is not a link. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parentText(app: AppBuildApp, prNumber: number, prUrl: string, slug: string): string {
  return (
    `Building the ${appBuildLabel(app)}: <${prUrl}|PR #${prNumber}> on ${slug}. ` +
    "Each session report and review is posted in this thread. Reply here to steer the builder (the reply is passed to the PR), " +
    "or ask for it to be stopped."
  );
}

export function reportText(app: AppBuildApp, comment: BuildReportComment, max: number | null): string {
  const r = comment.parsed;
  const lines: string[] = [];
  if (r.stopReason) {
    lines.push(
      `*The ${appBuildLabel(app)} build loop stopped*${r.session !== null ? ` after session ${r.session}` : ""}: ` +
        `${escapeMrkdwn(r.stopReason)}. To continue, resume it (with a higher maxSessions if it hit the cap).`,
    );
  }
  const sessionLabel = r.session !== null ? `Session ${r.session}${max !== null ? ` of ${max}` : ""}` : "Session report";
  const head = [`*${sessionLabel}*`];
  if (r.phase) head.push(`phase: ${escapeMrkdwn(r.phase)}`);
  if (r.runUrl) head.push(`<${r.runUrl}|run log>`);
  head.push(`<${comment.url}|full report>`);
  lines.push(head.join(" · "));
  if (r.summary) lines.push(`Done: ${escapeMrkdwn(truncate(r.summary, 500))}`);
  if (r.gateVerdict) lines.push(`Phase gate: ${escapeMrkdwn(truncate(r.gateVerdict, 300))}`);
  const { pass, fail, missing } = r.checks;
  if (pass + fail + missing > 0) lines.push(`Checks: ${pass} pass, ${fail} fail${missing > 0 ? `, ${missing} missing` : ""}`);
  if (r.questions.length > 0) {
    lines.push("*Questions only a person can answer* (reply here and the answer is passed on):");
    for (const question of r.questions.slice(0, 10)) lines.push(`• ${escapeMrkdwn(truncate(question, 400))}`);
  }
  if (r.cost) lines.push(escapeMrkdwn(truncate(r.cost, 200)));
  return lines.join("\n");
}

export function assessmentText(comment: BuildAssessmentComment): string {
  const a = comment.parsed;
  const parts = [`*Assessment of session ${a.session ?? "?"}*`];
  const { pass, fail, missing } = a.checks;
  if (pass + fail + missing > 0) parts.push(`checks ${pass} pass / ${fail} fail${missing > 0 ? ` / ${missing} missing` : ""}`);
  parts.push(`review: ${a.blockers ?? "?"} blocker(s), ${a.majors ?? "?"} major(s)`);
  parts.push(`<${comment.url}|details>`);
  return parts.join(" · ");
}

function truncate(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap - 1)}…`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
