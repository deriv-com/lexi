import type { AppBuildGithubPort, AppBuildWorkflowRun } from "./github-port";
import {
  ACTIVE_RUN_STATUSES,
  APP_BUILD_BRANCH_PREFIX,
  APP_BUILD_STOP_LABEL,
  APP_BUILD_WORKFLOW_FILE,
  appBuildBranch,
  callerDefaultMaxSessions,
  parseBuildComment,
  progressStatusLine,
  runApp,
  runMaxSessions,
  type AppBuildApp,
  type ParsedAssessment,
  type ParsedSessionReport,
} from "./report";
import type { AppBuildStore } from "./store";

/**
 * The repository a build runs in. Structurally the same as `RepoTarget` from
 * `@lexi/agent-tools`, so a resolved repo scope entry can be passed as-is.
 */
export interface AppBuildTarget {
  owner: string;
  repo: string;
  /** "owner/repo". */
  slug: string;
  /** The default branch the deployment knows, used when GitHub cannot say. */
  defaultBranch?: string;
}

/** How a deployment's build loop is laid out. Every field has the reusable workflow's default. */
export interface AppBuildLoopConfig {
  /** The caller workflow in the product repository. Default `app-build.yml`. */
  workflowFile: string;
  /** The `branch_prefix` the caller passes. Default `lexi/build-`. */
  branchPrefix: string;
  /** Where the loop keeps PROGRESS.md for an app. Default `app/<app>/docs/build`. */
  docsDir(app: AppBuildApp): string;
  /**
   * Whether a comment author may speak for the loop. The loop posts as a
   * GitHub App, so the default accepts only `…[bot]` logins: a person who
   * pastes a marker into a comment must not be able to fabricate a report.
   */
  isLoopAuthor(login: string | null): boolean;
}

export const DEFAULT_APP_BUILD_LOOP_CONFIG: AppBuildLoopConfig = {
  workflowFile: APP_BUILD_WORKFLOW_FILE,
  branchPrefix: APP_BUILD_BRANCH_PREFIX,
  docsDir: (app) => `app/${app}/docs/build`,
  isLoopAuthor: (login) => (login ?? "").endsWith("[bot]"),
};

export function resolveLoopConfig(partial: Partial<AppBuildLoopConfig> = {}): AppBuildLoopConfig {
  return { ...DEFAULT_APP_BUILD_LOOP_CONFIG, ...partial };
}

export interface BuildPullRequest {
  number: number;
  url: string;
  state: "open" | "closed";
  labels: string[];
}

export interface BuildComment {
  id: number;
  createdAt: string;
  url: string;
  parsed: ParsedSessionReport | ParsedAssessment;
}

export type BuildReportComment = BuildComment & { parsed: ParsedSessionReport };
export type BuildAssessmentComment = BuildComment & { parsed: ParsedAssessment };

export interface AppBuildSnapshot {
  app: AppBuildApp;
  pr: BuildPullRequest | null;
  comments: BuildComment[];
  latestReport: BuildReportComment | null;
  latestAssessment: BuildAssessmentComment | null;
  lastSession: number | null;
}

/** Runs read per listing: the active ones are always among the newest. */
const RUN_PAGE = 20;

/**
 * Reads a build's state from GitHub, the one way every caller reads it: the
 * tools, the status summary and the watcher.
 */
export class AppBuildReader {
  readonly config: AppBuildLoopConfig;

  constructor(
    private readonly github: AppBuildGithubPort,
    private readonly store: AppBuildStore,
    config: Partial<AppBuildLoopConfig> = {},
  ) {
    this.config = resolveLoopConfig(config);
  }

  branch(app: AppBuildApp): string {
    return appBuildBranch(app, this.config.branchPrefix);
  }

  /**
   * The newest PR from the build branch, open or closed: the one the loop
   * itself reads. `head` is qualified with the repository owner, so a fork PR
   * whose branch has the same name never becomes "the" build PR.
   */
  async findBuildPr(target: AppBuildTarget, app: AppBuildApp): Promise<BuildPullRequest | null> {
    const prs = await this.github.listPullRequests(target.owner, target.repo, {
      state: "all",
      head: `${target.owner}:${this.branch(app)}`,
      perPage: 20,
      sort: "created",
      direction: "desc",
    });
    if (prs === null) throw new Error("pull requests are not readable through this GitHub client");
    if (prs.length === 0) return null;
    const newest = [...prs].sort((a, b) => b.number - a.number)[0];
    const issue = await this.github.getIssue(target.owner, target.repo, newest.number);
    return { number: newest.number, url: newest.url, state: newest.state, labels: issue.labels ?? [] };
  }

  async snapshot(target: AppBuildTarget, app: AppBuildApp): Promise<AppBuildSnapshot> {
    const pr = await this.findBuildPr(target, app);
    if (!pr) return { app, pr: null, comments: [], latestReport: null, latestAssessment: null, lastSession: null };
    const raw = await this.github.listComments(target.owner, target.repo, pr.number);
    const comments: BuildComment[] = [];
    for (const comment of raw) {
      if (!this.config.isLoopAuthor(comment.authorLogin)) continue;
      const parsed = parseBuildComment(comment.body ?? "");
      if (!parsed) continue;
      // Both apps can share one repository; a comment naming the other app is not ours.
      if (parsed.app !== null && parsed.app !== app) continue;
      comments.push({ id: comment.id, createdAt: comment.createdAt, url: `${pr.url}#issuecomment-${comment.id}`, parsed });
    }
    comments.sort((a, b) => a.id - b.id);
    const reports = comments.filter((c): c is BuildReportComment => c.parsed.kind === "report");
    const assessments = comments.filter((c): c is BuildAssessmentComment => c.parsed.kind === "assessment");
    const sessions = reports.map((c) => c.parsed.session).filter((n): n is number => n !== null);
    return {
      app,
      pr,
      comments,
      latestReport: reports[reports.length - 1] ?? null,
      latestAssessment: assessments[assessments.length - 1] ?? null,
      lastSession: sessions.length > 0 ? Math.max(...sessions) : null,
    };
  }

  /** Recent runs of the caller workflow. Null when runs are not readable. */
  async recentRuns(target: AppBuildTarget): Promise<AppBuildWorkflowRun[] | null> {
    return this.github.listWorkflowRuns(target.owner, target.repo, this.config.workflowFile, { perPage: RUN_PAGE });
  }

  /**
   * The run building this app right now, if one is.
   *
   * Exact when the caller's `run-name` names the app. Otherwise an active run
   * that cannot be attributed counts as this app's only when this app's loop
   * says it is still going (its latest report promised the next session, on
   * an open PR with no stop label). A run that can be neither attributed nor
   * explained comes back as `unattributed`, so the caller can say so instead
   * of guessing.
   */
  activeRunFor(
    runs: AppBuildWorkflowRun[],
    app: AppBuildApp,
    snapshot: AppBuildSnapshot,
  ): { run: AppBuildWorkflowRun | null; unattributed: AppBuildWorkflowRun[] } {
    const active = runs.filter((run) => ACTIVE_RUN_STATUSES.has(run.status));
    const mine = active.find((run) => runApp(run) === app);
    if (mine) return { run: mine, unattributed: [] };
    const unattributed = active.filter((run) => runApp(run) === null);
    const stillGoing =
      snapshot.pr?.state === "open" &&
      !snapshot.pr.labels.includes(APP_BUILD_STOP_LABEL) &&
      (snapshot.latestReport === null || snapshot.latestReport.parsed.continuing);
    if (unattributed.length > 0 && stillGoing) return { run: unattributed[0], unattributed: [] };
    return { run: null, unattributed };
  }

  /**
   * max_sessions in force for the app: a run title that names it, else what
   * was last dispatched through this store, else the caller workflow's default.
   */
  async maxSessions(target: AppBuildTarget, app: AppBuildApp, runs: AppBuildWorkflowRun[], ref: string): Promise<number | null> {
    const latestOwn = runs.find((run) => runApp(run) === app);
    if (latestOwn) {
      const fromTitle = runMaxSessions(latestOwn);
      if (fromTitle !== null) return fromTitle;
    }
    const dispatched = await this.store.lastDispatchedMaxSessions(target.slug, app).catch(() => null);
    if (dispatched !== null) return dispatched;
    const caller = await this.github
      .getFileContents(target.owner, target.repo, `.github/workflows/${this.config.workflowFile}`, ref)
      .catch(() => null);
    return caller ? callerDefaultMaxSessions(caller, app) : null;
  }

  /**
   * PROGRESS.md on the build branch: null when it cannot be read, else its
   * `Status:` line, or undefined when the file has none.
   */
  async progressStatus(target: AppBuildTarget, app: AppBuildApp): Promise<string | null | undefined> {
    const progress = await this.github
      .getFileContents(target.owner, target.repo, `${this.config.docsDir(app)}/PROGRESS.md`, this.branch(app))
      .catch(() => null);
    if (progress === null) return null;
    return progressStatusLine(progress) ?? undefined;
  }

  /** The live default branch, else the configured one. Null when neither is known. */
  async defaultBranch(target: AppBuildTarget): Promise<string | null> {
    const live = await this.github.getDefaultBranch(target.owner, target.repo).catch(() => null);
    return live?.trim() || target.defaultBranch?.trim() || null;
  }
}
