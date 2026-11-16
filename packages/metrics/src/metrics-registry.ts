import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export interface MetricsRegistryOptions {
  prefix?: string;
  collectDefault?: boolean;
}

/**
 * Central Prometheus metrics registry for the orchestrator. Exposes typed
 * helper methods so callers never touch prom-client primitives directly,
 * keeping metric names/labels consistent across the codebase.
 */
export class MetricsRegistry {
  readonly registry: Registry;

  private readonly issuesProcessedTotal: Counter<"status">;
  private readonly verificationSuccessTotal: Counter<"result">;
  private readonly githubUpdatesTotal: Counter<"operation">;
  private readonly slackNotificationsTotal: Counter<"template">;
  private readonly quickFixOutcomesTotal: Counter<"outcome" | "path">;
  private readonly fixThisIssueClicksTotal: Counter<"outcome">;
  private readonly dispatchedBriefChars: Histogram<"path">;
  private readonly workflowDurationSeconds: Histogram<"stage">;
  private readonly queueDepthGauge: Gauge<"queue">;

  constructor(options: MetricsRegistryOptions = {}) {
    const prefix = options.prefix ?? "lexi_";
    this.registry = new Registry();

    if (options.collectDefault !== false) {
      collectDefaultMetrics({ register: this.registry, prefix });
    }

    this.issuesProcessedTotal = new Counter({
      name: `${prefix}issues_processed_total`,
      help: "Total number of GitHub issues processed by the orchestrator",
      labelNames: ["status"],
      registers: [this.registry],
    });

    this.verificationSuccessTotal = new Counter({
      name: `${prefix}verification_success_total`,
      help: "Total number of reproduction verification outcomes",
      labelNames: ["result"],
      registers: [this.registry],
    });

    this.githubUpdatesTotal = new Counter({
      name: `${prefix}github_updates_total`,
      help: "Total number of GitHub mutation operations performed",
      labelNames: ["operation"],
      registers: [this.registry],
    });

    this.slackNotificationsTotal = new Counter({
      name: `${prefix}slack_notifications_total`,
      help: "Total number of Slack notifications sent",
      labelNames: ["template"],
      registers: [this.registry],
    });

    // Terminal outcomes of dispatched `direct-fix.yml` runs. Lexi does not
    // author code — it hands a brief to that workflow — so this counter is the
    // closest thing the platform has to "did the work land", and it is the
    // baseline any change to the brief is measured against.
    //
    // `path` splits Slack `trigger_direct_fix` from the unattended
    // confirmed-bug dispatch. The two build their briefs differently (the
    // unattended one runs a code search and gates on it; the Slack one sends
    // the model's own prose), so a single blended rate would hide whichever is
    // worse behind whichever is busier.
    this.quickFixOutcomesTotal = new Counter({
      name: `${prefix}quick_fix_outcomes_total`,
      help: "Terminal outcomes of dispatched direct-fix attempts, by dispatch path",
      labelNames: ["outcome", "path"],
      registers: [this.registry],
    });

    // How each "Fix this issue" click resolved its brief. This exists because
    // the failure it watches for was invisible: a click that could not recover
    // the analysis used to fall back to a 900-char copy inlined in the Slack
    // button and dispatch anyway, with no log line and no counter, so a fixer
    // working from a third of the brief looked identical to a healthy run.
    //
    // `refused_brief_unavailable` is the safe outcome, not an error — but a
    // rising rate means offers are not surviving to the click (an unapplied
    // migration, or a database the orchestrator cannot reach), and every one
    // of them is a human being asked to re-request an analysis.
    this.fixThisIssueClicksTotal = new Counter({
      name: `${prefix}fix_this_issue_clicks_total`,
      help: "Fix this issue button clicks by how the analysis brief resolved",
      labelNames: ["outcome"],
      registers: [this.registry],
    });

    // Size of the `bug_text` actually put on the wire. The brief is the entire
    // input to the coding agent, so its length is the one cheap proxy for "did
    // the fixer get the whole problem". Buckets start below the old 900-char
    // ceiling on purpose: traffic piling up under it is the regression signal.
    this.dispatchedBriefChars = new Histogram({
      name: `${prefix}dispatched_brief_chars`,
      help: "Character length of the bug_text dispatched to direct-fix, by dispatch path",
      labelNames: ["path"],
      buckets: [200, 500, 900, 1500, 2500, 4000, 6000, 10000, 20000, 50000],
      registers: [this.registry],
    });

    this.workflowDurationSeconds = new Histogram({
      name: `${prefix}workflow_duration_seconds`,
      help: "Duration of workflow stage executions in seconds",
      labelNames: ["stage"],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
      registers: [this.registry],
    });

    this.queueDepthGauge = new Gauge({
      name: `${prefix}queue_depth`,
      help: "Current depth of a BullMQ queue",
      labelNames: ["queue"],
      registers: [this.registry],
    });
  }

  incIssuesProcessed(status: string, value = 1): void {
    this.issuesProcessedTotal.inc({ status }, value);
  }

  incVerificationSuccess(result: string, value = 1): void {
    this.verificationSuccessTotal.inc({ result }, value);
  }

  incGithubUpdate(operation: string, value = 1): void {
    this.githubUpdatesTotal.inc({ operation }, value);
  }

  incSlackNotification(template: string, value = 1): void {
    this.slackNotificationsTotal.inc({ template }, value);
  }

  /**
   * One terminal direct-fix outcome.
   *
   * `outcome` is the row's `resultStatus` verbatim (`shipped` | `handback` |
   * `timed_out`) rather than a derived success boolean: `timed_out` covers both
   * a run that never published a result marker and a dispatch that was never
   * correlated at all, and collapsing it into "failed" would hide a broken
   * correlation behind a bad-fix rate.
   */
  incQuickFixOutcome(outcome: string, path: string, value = 1): void {
    this.quickFixOutcomesTotal.inc({ outcome, path }, value);
  }

  /**
   * One "Fix this issue" click. `outcome` is `dispatched_from_memory`,
   * `dispatched_from_durable`, `refused_brief_unavailable`, or
   * `refused_unparseable` — the resolution path, not a success boolean,
   * because "dispatched" alone was exactly what hid the truncation.
   */
  incFixThisIssueClick(outcome: string, value = 1): void {
    this.fixThisIssueClicksTotal.inc({ outcome }, value);
  }

  /** Length of one dispatched brief, in characters. */
  observeDispatchedBriefChars(path: string, chars: number): void {
    this.dispatchedBriefChars.observe({ path }, chars);
  }

  observeWorkflowDuration(stage: string, seconds: number): void {
    this.workflowDurationSeconds.observe({ stage }, seconds);
  }

  setQueueDepth(queue: string, depth: number): void {
    this.queueDepthGauge.set({ queue }, depth);
  }

  async metrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
