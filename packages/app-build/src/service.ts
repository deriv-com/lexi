import { correlateDispatchedRun, dispatchSearchFloor, type CorrelateDispatchedRunOptions } from "@lexi/github";
import type { AppBuildGithubPort, AppBuildWorkflowRun } from "./github-port";
import { AppBuildReader, type AppBuildLoopConfig, type AppBuildSnapshot, type AppBuildTarget } from "./reader";
import {
  APP_BUILD_APPS,
  APP_BUILD_CEILING_WARNING_RATIO,
  APP_BUILD_STOP_LABEL,
  appBuildLabel,
  runApp,
  type AppBuildApp,
} from "./report";
import { APP_BUILD_AUDIT_ACTIONS, InMemoryAppBuildStore, type AppBuildStore } from "./store";

/**
 * Starts, stops, steers and reads the app-build loop
 * (`.github/workflows/app-build.yml`, started through a thin caller in the
 * product repository).
 *
 * Nothing here builds anything. The loop chains its own sessions; this starts
 * it, stops it with the stop label, passes people's words to it as PR
 * comments, and reads back what it reported. Every dispatch goes out on an
 * explicit ref.
 */

export const RESTART_PHASES = ["intent", "spec", "plan", "build"] as const;
export type RestartPhase = (typeof RESTART_PHASES)[number];

export function isRestartPhase(value: unknown): value is RestartPhase {
  return typeof value === "string" && (RESTART_PHASES as readonly string[]).includes(value);
}

/** Feedback longer than this is refused rather than cut. */
export const MAX_FEEDBACK_CHARS = 8000;

export interface AppBuildActor {
  /** The person the action is for. Recorded on the audit row. */
  actorId: string;
  channel?: string;
  threadTs?: string;
}

/**
 * What a service call ended in. `done` changed something, `noop` found
 * nothing to change, `refused` changed nothing and says why.
 */
export interface AppBuildOutcome {
  status: "done" | "noop" | "refused";
  text: string;
  runId?: number;
  runUrl?: string;
}

export interface StartBuildInput {
  app: AppBuildApp;
  /** Session to start at. Default: the last reported session + 1, or 1. */
  session?: number;
  maxSessions?: number;
  /** Continue a build stopped with the stop label (removes it first). */
  resume?: boolean;
  restartPhase?: RestartPhase;
}

export interface AppBuildServiceOptions {
  github: AppBuildGithubPort;
  /** Default: an in-memory store. */
  store?: AppBuildStore;
  /** How the deployment's loop is laid out (workflow file, branch prefix, docs dir, loop author). */
  loop?: Partial<AppBuildLoopConfig>;
  /** A fixed ref to dispatch on. Default: the repository's default branch. */
  workflowRef?: string;
  /**
   * Whether the caller workflow accepts `restart_phase`. Default true (the
   * example caller does). When false, a restart is refused instead of
   * dispatched, because GitHub refuses a dispatch with an unknown input.
   */
  callerAcceptsRestartPhase?: boolean;
  /** Retry settings for finding the run a dispatch created. */
  correlate?: CorrelateDispatchedRunOptions;
  /** How a person is named in a feedback comment. Default: their id. */
  displayName?: (actorId: string) => string | Promise<string>;
  /** Where feedback came from, as the comment names it. Default "chat". */
  feedbackSource?: string;
  logger?: { warn(message: string, context?: string): void };
}

export interface AppStatus {
  app: AppBuildApp;
  label: string;
  branch: string;
  pr: AppBuildSnapshot["pr"];
  stopLabelled: boolean;
  phase: string | null;
  lastSession: number | null;
  maxSessions: number | null;
  /** True when the last session reached the ceiling-warning share of max_sessions. */
  nearCeiling: boolean;
  runningRun: AppBuildWorkflowRun | null;
  latestRun: AppBuildWorkflowRun | null;
  /** PROGRESS.md's Status line; null = not readable, undefined = no Status line. */
  progress: string | null | undefined;
  latestReport: AppBuildSnapshot["latestReport"];
  latestAssessment: AppBuildSnapshot["latestAssessment"];
}

export interface BuildStatus {
  target: AppBuildTarget;
  runsReadable: boolean;
  apps: AppStatus[];
}

export class AppBuildService {
  readonly reader: AppBuildReader;
  readonly store: AppBuildStore;
  private readonly github: AppBuildGithubPort;

  constructor(private readonly options: AppBuildServiceOptions) {
    this.github = options.github;
    this.store = options.store ?? new InMemoryAppBuildStore();
    this.reader = new AppBuildReader(this.github, this.store, options.loop);
  }

  get workflowFile(): string {
    return this.reader.config.workflowFile;
  }

  /**
   * Dispatches the next session of an app's build, or resumes a stopped one.
   * Refuses when the build is already running, so the loop is never started
   * twice beside itself.
   */
  async start(target: AppBuildTarget, input: StartBuildInput, actor: AppBuildActor): Promise<AppBuildOutcome> {
    const { app } = input;
    const label = appBuildLabel(app);
    const branch = this.reader.branch(app);
    const workflow = this.workflowFile;
    if (input.maxSessions !== undefined && input.session !== undefined && input.session > input.maxSessions) {
      return refuse(`Session ${input.session} is beyond maxSessions ${input.maxSessions}; the loop would stop before building. Nothing was dispatched.`);
    }
    if (input.restartPhase !== undefined && this.options.callerAcceptsRestartPhase === false) {
      return refuse(`The caller workflow here does not accept restart_phase, so a restart cannot be dispatched. Nothing was dispatched.`);
    }

    const snapshot = await this.reader.snapshot(target, app);
    const pr = snapshot.pr;
    if (pr?.state === "closed") {
      return refuse(
        `The ${label} build PR #${pr.number} (${pr.url}) is closed, and the loop stops on a closed PR. ` +
          `Reopen it to continue that build, or delete the branch ${branch} to start a fresh one. Nothing was dispatched.`,
      );
    }
    const stopLabelled = pr?.labels.includes(APP_BUILD_STOP_LABEL) === true;
    if (stopLabelled && !input.resume) {
      return refuse(
        `The ${label} build PR #${pr!.number} carries ${APP_BUILD_STOP_LABEL}, so a new session would stop at once. ` +
          `Start it again with resume: true to remove the label and continue at session ${(snapshot.lastSession ?? 0) + 1}. Nothing was dispatched.`,
      );
    }

    const runs = await this.reader.recentRuns(target);
    if (runs === null) {
      return refuse(`Workflow runs on ${target.slug} are not readable, so I cannot tell whether the ${label} build is already running. Nothing was dispatched.`);
    }
    const { run, unattributed } = this.reader.activeRunFor(runs, app, snapshot);
    if (run) {
      return refuse(
        `The ${label} build is already running (${run.status}): ${run.runUrl}. It starts its next session by itself, ` +
          "so there is nothing to start. Read its status to follow it, or stop it.",
      );
    }
    // A stopped build's last session may still be finishing its segment. If a
    // run the title cannot tie to an app is in flight, removing the label now
    // could let that session chain on beside the one about to start.
    if (stopLabelled && unattributed.length > 0) {
      return refuse(
        `A run of ${workflow} is still in flight (${unattributed[0].runUrl}) and may be the stopped ${label} ` +
          "session finishing its segment. Resume once it has reported. Nothing was dispatched.",
      );
    }

    const session = input.session ?? (snapshot.lastSession !== null ? snapshot.lastSession + 1 : 1);
    const capReached = snapshot.latestReport?.parsed.stopReason?.match(/max_sessions\s*\((\d+)\)/i);
    if (capReached && input.maxSessions === undefined && session > Number(capReached[1])) {
      return refuse(
        `The ${label} build stopped because it reached max_sessions (${capReached[1]}). ` +
          `Pass maxSessions above ${capReached[1]} to continue at session ${session}. Nothing was dispatched.`,
      );
    }
    if (input.maxSessions !== undefined && session > input.maxSessions) {
      return refuse(`Session ${session} is beyond maxSessions ${input.maxSessions}; the loop would stop before building. Nothing was dispatched.`);
    }

    // A build whose PROGRESS.md says `Status: done` stops again at session
    // start unless a phase is restarted. Restarting at the build phase lets
    // "continue the build" act on an assessment or a review; an explicit
    // restartPhase wins. Sent only when needed, because a caller without the
    // input refuses the dispatch.
    let restartPhase = input.restartPhase ?? null;
    const progress = await this.reader.progressStatus(target, app);
    const markedDone = typeof progress === "string" && /^status\s*:\s*done\b/i.test(progress);
    const autoRestart = markedDone && restartPhase === null;
    if (autoRestart) {
      if (this.options.callerAcceptsRestartPhase === false) {
        return refuse(
          `PROGRESS.md on ${branch} says the ${label} is done, so a new session would stop at once, and the caller workflow here ` +
            "does not accept restart_phase. Change PROGRESS.md's Status line first. Nothing was dispatched.",
        );
      }
      restartPhase = "build";
    }

    const ref = this.options.workflowRef?.trim() || (await this.reader.defaultBranch(target));
    if (!ref) return refuse(`Could not determine which ref to dispatch ${workflow} on for ${target.slug}. Nothing was dispatched.`);

    const inputs: Record<string, string> = { app, session: String(session) };
    if (input.maxSessions !== undefined) inputs.max_sessions = String(input.maxSessions);
    if (restartPhase !== null) inputs.restart_phase = restartPhase;

    if (stopLabelled) await this.github.removeLabels(target.owner, target.repo, pr!.number, [APP_BUILD_STOP_LABEL]);
    const dispatchedAt = new Date();
    try {
      await this.github.dispatchWorkflow(target.owner, target.repo, workflow, ref, inputs);
    } catch (error) {
      // The label went first so the new session would not stop at once; a
      // dispatch that never happened must not leave the build un-stopped.
      if (stopLabelled) {
        await this.github.addLabels(target.owner, target.repo, pr!.number, [APP_BUILD_STOP_LABEL]).catch(() => undefined);
      }
      throw error;
    }

    await this.recordAfterWrite(actor.actorId, APP_BUILD_AUDIT_ACTIONS.START, {
      repo: target.slug,
      app,
      session,
      maxSessions: input.maxSessions ?? null,
      ref,
      resumed: stopLabelled,
      restartPhase,
      prNumber: pr?.number ?? null,
      channel: actor.channel ?? null,
      threadTs: actor.threadTs ?? null,
    });

    const dispatched = await correlateDispatchedRun(
      this.github.findDispatchedRun?.bind(this.github),
      target.owner,
      target.repo,
      workflow,
      dispatchSearchFloor(dispatchedAt),
      { ...this.options.correlate, excludeRunIds: runs.map((r) => r.runId) },
    );
    // Runs listed before the dispatch are excluded above, so the match is the
    // new run unless another dispatch of the same workflow landed alongside.
    const ownRun = dispatched;

    const lines = [
      `${stopLabelled ? "Resumed" : "Started"} the ${label} build: dispatched ${workflow} on ${target.slug}@${ref} ` +
        `for session ${session}${input.maxSessions !== undefined ? ` of at most ${input.maxSessions}` : " (max_sessions: the caller's default)"}.`,
      stopLabelled ? `Removed ${APP_BUILD_STOP_LABEL} from PR #${pr!.number}.` : "",
      restartPhase !== null
        ? autoRestart
          ? `PROGRESS.md says done, so the session restarts at the ${restartPhase} phase; otherwise it would stop at once.`
          : `Restarting at the ${restartPhase} phase.`
        : "",
      pr
        ? `It works on PR #${pr.number} (${pr.url}) and chains the next session itself.`
        : `The first session opens a draft PR from ${branch} and chains the next session itself.`,
      unattributed.length > 0
        ? `Another run of the workflow is in flight that I cannot tie to an app (${unattributed[0].runUrl}), most likely the other app's build.`
        : "",
      ownRun
        ? `Run ${ownRun.runId}: ${ownRun.runUrl}.`
        : "The run is not visible yet; it usually appears under Actions within a minute. Do not wait for it in this turn.",
    ];
    return { status: "done", text: lines.filter(Boolean).join("\n"), ...(ownRun ? { runId: ownRun.runId, runUrl: ownRun.runUrl } : {}) };
  }

  /** Labels the open build PR with the stop label. The running session finishes its segment first. */
  async stop(target: AppBuildTarget, app: AppBuildApp, actor: AppBuildActor): Promise<AppBuildOutcome> {
    const label = appBuildLabel(app);
    const pr = await this.reader.findBuildPr(target, app);
    if (!pr || pr.state !== "open") {
      return refuse(
        pr
          ? `The ${label} build PR #${pr.number} is already closed, so the loop is not running from it. Nothing was changed.`
          : `There is no ${label} build PR (${this.reader.branch(app)}) on ${target.slug}, so there is nothing to stop. Nothing was changed.`,
      );
    }
    if (pr.labels.includes(APP_BUILD_STOP_LABEL)) {
      return {
        status: "noop",
        text: `PR #${pr.number} already carries ${APP_BUILD_STOP_LABEL}; the ${label} build stops (or has stopped) at its next boundary. Nothing was changed.`,
      };
    }
    await this.github.addLabels(target.owner, target.repo, pr.number, [APP_BUILD_STOP_LABEL]);
    await this.recordAfterWrite(actor.actorId, APP_BUILD_AUDIT_ACTIONS.STOP, {
      repo: target.slug,
      app,
      prNumber: pr.number,
      channel: actor.channel ?? null,
      threadTs: actor.threadTs ?? null,
    });
    return {
      status: "done",
      text:
        `Labelled the ${label} build PR #${pr.number} ${APP_BUILD_STOP_LABEL} (${pr.url}). ` +
        "The loop reads the label at session start and at each segment boundary, so a session already running finishes its " +
        "current segment, pushes, posts its report and then stops; it is not cut off mid-commit. To continue later, start it with resume: true.",
    };
  }

  /** Passes a person's words to the builder as a comment on the build PR. */
  async feedback(target: AppBuildTarget, app: AppBuildApp, rawMessage: string, actor: AppBuildActor): Promise<AppBuildOutcome> {
    if (rawMessage.length > MAX_FEEDBACK_CHARS) {
      return refuse(`The message is ${rawMessage.length} characters; the limit is ${MAX_FEEDBACK_CHARS}. Nothing was posted.`);
    }
    const message = sanitizeFeedback(rawMessage);
    if (!message) return refuse("The message is empty once HTML comments are removed. Nothing was posted.");
    const label = appBuildLabel(app);
    const pr = await this.reader.findBuildPr(target, app);
    if (!pr || pr.state !== "open") {
      return refuse(
        pr
          ? `The ${label} build PR #${pr.number} is closed; the loop no longer reads it. Nothing was posted.`
          : `There is no ${label} build PR yet, so there is nowhere for the builder to read feedback. Start the build first. Nothing was posted.`,
      );
    }
    const who = sanitizeFeedback(String((await this.displayName(actor.actorId)) || actor.actorId)).replace(/\s+/g, " ").slice(0, 80);
    const body = `Feedback from ${who || actor.actorId} via ${this.options.feedbackSource ?? "chat"}:\n\n${message}`;
    const comment = await this.github.addComment(target.owner, target.repo, pr.number, body);
    await this.recordAfterWrite(actor.actorId, APP_BUILD_AUDIT_ACTIONS.FEEDBACK, {
      repo: target.slug,
      app,
      prNumber: pr.number,
      commentId: comment.id,
      chars: message.length,
      channel: actor.channel ?? null,
      threadTs: actor.threadTs ?? null,
    });
    return {
      status: "done",
      text:
        `Posted to the ${label} build PR #${pr.number}: ${pr.url}#issuecomment-${comment.id}. ` +
        "The builder reads allowlisted comments at the start of its next segment or session (it cannot see the chat), " +
        "so a session already running picks this up then.",
    };
  }

  /** Status of one app's build, or of both. Never writes. */
  async status(target: AppBuildTarget, app?: AppBuildApp): Promise<BuildStatus> {
    const apps: AppBuildApp[] = app ? [app] : [...APP_BUILD_APPS];
    const runs = await this.reader.recentRuns(target).catch(() => null);
    const ref = this.options.workflowRef?.trim() || (await this.reader.defaultBranch(target)) || undefined;
    const statuses: AppStatus[] = [];
    for (const each of apps) statuses.push(await this.appStatus(target, each, runs ?? [], ref));
    return { target, runsReadable: runs !== null, apps: statuses };
  }

  private async appStatus(target: AppBuildTarget, app: AppBuildApp, runs: AppBuildWorkflowRun[], ref: string | undefined): Promise<AppStatus> {
    const snapshot = await this.reader.snapshot(target, app);
    const base: AppStatus = {
      app,
      label: appBuildLabel(app),
      branch: this.reader.branch(app),
      pr: snapshot.pr,
      stopLabelled: snapshot.pr?.labels.includes(APP_BUILD_STOP_LABEL) === true,
      phase: snapshot.latestReport?.parsed.phase ?? null,
      lastSession: snapshot.lastSession,
      maxSessions: null,
      nearCeiling: false,
      runningRun: null,
      latestRun: runs.find((run) => runApp(run) === app) ?? null,
      progress: null,
      latestReport: snapshot.latestReport,
      latestAssessment: snapshot.latestAssessment,
    };
    if (!snapshot.pr) return base;
    const maxSessions = ref ? await this.reader.maxSessions(target, app, runs, ref) : null;
    return {
      ...base,
      maxSessions,
      nearCeiling:
        maxSessions !== null && snapshot.lastSession !== null && snapshot.lastSession >= Math.ceil(maxSessions * APP_BUILD_CEILING_WARNING_RATIO),
      runningRun: this.reader.activeRunFor(runs, app, snapshot).run,
      progress: await this.reader.progressStatus(target, app),
    };
  }

  /**
   * A write already happened; its audit row is best-effort. A failed write is
   * logged, not reported as a failed action: the dispatch is real, and a
   * "failed" answer invites a retry that would dispatch it twice.
   */
  private async recordAfterWrite(actor: string, action: string, details: Record<string, unknown>): Promise<void> {
    try {
      await this.store.recordAction(actor, action, details);
    } catch (error) {
      this.options.logger?.warn(
        `app-build audit row ${action} not written after a successful write on ${String(details.repo)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "AppBuildService",
      );
    }
  }

  private async displayName(actorId: string): Promise<string> {
    if (!this.options.displayName) return actorId;
    try {
      return (await this.options.displayName(actorId)) || actorId;
    } catch {
      return actorId;
    }
  }
}

function refuse(text: string): AppBuildOutcome {
  return { status: "refused", text };
}

function stripHtmlCommentOnce(input: string): string {
  let out = "";
  let pos = 0;
  while (pos < input.length) {
    const start = input.indexOf("<!--", pos);
    if (start === -1) {
      out += input.slice(pos);
      break;
    }
    out += input.slice(pos, start);
    let scan = start + 4;
    let end = -1;
    while (scan < input.length) {
      const dash = input.indexOf("--", scan);
      if (dash === -1) break;
      if (input[dash + 2] === ">") {
        end = dash + 3;
        break;
      }
      if (input[dash + 2] === "!" && input[dash + 3] === ">") {
        end = dash + 4;
        break;
      }
      scan = dash + 1;
    }
    if (end === -1) {
      break;
    }
    pos = end;
  }
  return out;
}

/**
 * Removes HTML comments, so relayed text can never carry an
 * `<!-- app-build:… -->` marker. The loop decides its feedback window and a
 * relay decides what to repeat from those markers; a spoofed one would hide
 * real feedback or fabricate a report.
 */
export function sanitizeFeedback(message: string): string {
  // Repeat until stable: removing an inner comment can splice an outer marker
  // back together ("<!<!-- -->-- app-build:report -->"). Then drop any stray
  // delimiter or marker prefix left behind until fixed point.
  let text = message;
  while (true) {
    const next = stripHtmlCommentOnce(text)
      .split("<!--")
      .join("")
      .split("--!>")
      .join("")
      .split("-->")
      .join("")
      .replace(/app-build:/gi, "");
    if (next === text) break;
    text = next;
  }
  return text.trim().slice(0, MAX_FEEDBACK_CHARS);
}

/** A plain-text summary of a build's status, for a chat reply or a log line. */
export function formatBuildStatus(status: BuildStatus): string {
  const blocks: string[] = status.runsReadable ? [] : [`Runs: not readable on ${status.target.slug} (the GitHub App needs Actions: read).`];
  for (const app of status.apps) blocks.push(formatAppStatus(status.target, app));
  return blocks.join("\n\n");
}

function formatAppStatus(target: AppBuildTarget, s: AppStatus): string {
  const header = `${s.label[0].toUpperCase()}${s.label.slice(1)} (${target.slug})`;
  if (!s.pr) return `${header}\n- No build PR yet (${s.branch}). Starting the build opens one.`;
  const lines = [header, `- PR #${s.pr.number}: ${s.pr.url} (${s.pr.state}${s.stopLabelled ? `, ${APP_BUILD_STOP_LABEL}` : ""})`];
  const report = s.latestReport?.parsed ?? null;
  lines.push(`- Phase: ${s.phase ?? "not reported"}`);
  if (s.lastSession !== null) {
    const ceiling =
      s.nearCeiling && s.maxSessions !== null
        ? ` (at ${Math.round((s.lastSession / s.maxSessions) * 100)}% of max_sessions; raise it with maxSessions when it stops)`
        : "";
    lines.push(`- Last session: ${s.lastSession}${s.maxSessions !== null ? ` of ${s.maxSessions}` : " (max_sessions unknown)"}${ceiling}`);
  } else {
    lines.push(`- No session report yet${s.maxSessions !== null ? ` (max_sessions ${s.maxSessions})` : ""}`);
  }
  if (s.runningRun) lines.push(`- Running now: ${s.runningRun.runUrl} (${s.runningRun.status})`);
  else if (s.latestRun) {
    lines.push(`- Latest run: ${s.latestRun.runUrl} (${s.latestRun.status}${s.latestRun.conclusion ? `/${s.latestRun.conclusion}` : ""})`);
  } else if (report?.runUrl) lines.push(`- Latest reported run: ${report.runUrl}; nothing of this app is running now`);
  if (report?.stopReason) lines.push(`- Loop stopped: ${report.stopReason}`);
  lines.push(`- PROGRESS.md: ${s.progress ?? (s.progress === null ? "not readable on the build branch" : "no Status line")}`);
  if (report?.summary) lines.push(`- Last session did: ${report.summary}`);
  if (report?.gateVerdict) lines.push(`- Last phase gate: ${report.gateVerdict}`);
  const { pass, fail, missing } = report?.checks ?? { pass: 0, fail: 0, missing: 0 };
  if (pass + fail + missing > 0) lines.push(`- Checks: ${pass} pass, ${fail} fail${missing ? `, ${missing} missing` : ""}`);
  if (report?.cost) lines.push(`- ${report.cost}`);
  if (report && report.questions.length > 0) {
    lines.push("- Questions only a person can answer:");
    for (const question of report.questions.slice(0, 8)) lines.push(`  - ${question}`);
  } else if (report) {
    lines.push("- No open questions for a person in the latest report.");
  }
  if (s.latestReport) lines.push(`- Latest report: ${s.latestReport.url}`);
  const a = s.latestAssessment;
  if (a) {
    lines.push(
      `- Latest assessment (session ${a.parsed.session ?? "?"}): checks ${a.parsed.checks.pass} pass / ${a.parsed.checks.fail} fail, ` +
        `blockers ${a.parsed.blockers ?? "?"}, majors ${a.parsed.majors ?? "?"}: ${a.url}`,
    );
  }
  return lines.join("\n");
}
