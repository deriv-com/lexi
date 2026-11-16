import type { DispatchedWorkflowRun } from "./types";

/**
 * GitHub's `created_at` for a fresh run can land a few seconds BEFORE the
 * local clock reading taken at dispatch time. Searching from an un-skewed
 * `new Date()` therefore misses the very run it just created.
 *
 * Lifted from the QA caller, which discovered this the hard way and was the
 * only caller that had it right.
 */
export const DISPATCH_CLOCK_SKEW_MS = 30_000;

/** A dispatched run does not appear in list-runs instantly. */
export const DEFAULT_CORRELATE_ATTEMPTS = 5;
export const DEFAULT_CORRELATE_DELAY_MS = 1000;

/** The one provider method this needs. Narrow on purpose — easy to fake in tests. */
export type FindDispatchedRunFn = (
  owner: string,
  repo: string,
  workflowFile: string,
  since: Date,
  excludeRunIds?: number[],
  nameContains?: string,
) => Promise<DispatchedWorkflowRun | null>;

export interface CorrelateDispatchedRunOptions {
  /** Run IDs already claimed by other in-flight dispatches on this repo/workflow. */
  excludeRunIds?: readonly number[];
  /** Narrows by run title when the workflow puts a discriminator there. */
  nameContains?: string;
  attempts?: number;
  delayMs?: number;
  /** Injectable for tests, so a retry loop costs no wall-clock. */
  wait?: (ms: number) => Promise<void>;
  /** Swallowed and treated as "not correlated". See below. */
  onError?: (error: unknown) => void;
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Applies the clock-skew allowance to a dispatch timestamp. Call this to build
 * the `since` you hand to `correlateDispatchedRun` — or store it on a DB row
 * for a poller to use later.
 */
export function dispatchSearchFloor(dispatchedAt: Date = new Date()): Date {
  return new Date(dispatchedAt.getTime() - DISPATCH_CLOCK_SKEW_MS);
}

/**
 * Best-effort recovery of the run a `workflow_dispatch` just created.
 *
 * `dispatchWorkflow` returns 204 with no body, so the run id has to be found
 * afterwards by listing runs. Every caller that wants to show a person "here
 * is your run" needs the same three things — a clock-skew window, a few
 * retries while the run registers, and exclusion of runs already claimed by a
 * neighbouring dispatch — and before this helper only the QA caller had all three.
 * `triggerMobileBuild` called `findDispatchedRun` exactly once against an
 * un-skewed `new Date()`, which is why its `Run:` line was so often absent.
 *
 * **Never throws.** A missing link is a cosmetic loss; a throw here would
 * fail a dispatch that already succeeded, turning "I couldn't link the run"
 * into "your merge didn't happen". Returns `null` on exhaustion or error, and
 * reports the error through `onError` for logging.
 */
export async function correlateDispatchedRun(
  findDispatchedRun: FindDispatchedRunFn | undefined,
  owner: string,
  repo: string,
  workflowFile: string,
  since: Date,
  options: CorrelateDispatchedRunOptions = {},
): Promise<DispatchedWorkflowRun | null> {
  if (!findDispatchedRun) return null;

  const attempts = Math.max(1, options.attempts ?? DEFAULT_CORRELATE_ATTEMPTS);
  const delayMs = options.delayMs ?? DEFAULT_CORRELATE_DELAY_MS;
  const wait = options.wait ?? defaultWait;
  const exclude = [...(options.excludeRunIds ?? [])];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await wait(delayMs);
    try {
      const run = await findDispatchedRun(
        owner,
        repo,
        workflowFile,
        since,
        exclude,
        options.nameContains,
      );
      if (run) return run;
    } catch (error) {
      options.onError?.(error);
      return null;
    }
  }
  return null;
}

/**
 * The " Run: <url>" fragment appended to a dispatch confirmation, or "" when
 * the run could not be correlated.
 *
 * Centralised so every "Dispatched …" reply reads the same, and so the empty
 * case is a deliberate silence rather than a dangling "Run: undefined".
 */
export function runLinkSuffix(run: DispatchedWorkflowRun | null | undefined): string {
  return run?.runUrl ? ` Run: ${run.runUrl}` : "";
}

/**
 * Slack-flavoured variant: a `<url|run>` link. Slack renders bare URLs too,
 * but an unfurled raw Actions URL is noisy in a busy thread.
 */
export function slackRunLink(run: DispatchedWorkflowRun | null | undefined): string {
  return run?.runUrl ? `<${run.runUrl}|run>` : "";
}
