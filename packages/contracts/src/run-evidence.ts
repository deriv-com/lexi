/**
 * Run evidence — the structured return channel from a dispatched runner.
 *
 * Lexi dispatches a workflow into a product repo and the GitHub runner, not
 * Lexi, authors the change. A fenced result marker scraped out of the run's
 * logs, plus a run status correlated to an attempt by *timestamp*, is enough
 * to relay "a PR exists"; it is not enough to review one.
 *
 * Three consequences of the log-scraping channel, all fixed by pushing a
 * typed bundle instead:
 *
 *   1. It is terminal-only. A RED-phase artefact — the failing test, and the
 *      proof it failed for the intended reason — exists mid-run and is gone by
 *      the time the run ends. Evidence that can only arrive at the end cannot
 *      describe how the work got there.
 *   2. It is prose. A check suite is a list of named results; recovering that
 *      from an announcement paragraph means parsing English.
 *   3. Correlation is best-effort. `findDispatchedRun` matches on dispatch
 *      time and excludes ids already claimed, which is careful but still
 *      inference. The runner knows exactly which attempt it is working on,
 *      because Lexi told it — so it should say so.
 *
 * TYPES ONLY, and deliberately narrow: this is the seam between something
 * outside the trust boundary (a runner in another repo) and Lexi's evidence
 * store. Everything here is UNTRUSTED INPUT. A bundle asserts what a runner
 * claims happened; it is not proof that it did, and nothing in this module
 * should ever be treated as an authorisation. In particular `checks[].status`
 * is a *report* of a check, never a substitute for running one — see
 * `RunEvidenceBundle.attemptId` for why the id alone is not authority either.
 */

/**
 * Which part of the red-green-refactor cycle produced this bundle.
 *
 * Separate bundles rather than one terminal payload, so the RED artefact is
 * captured while it exists. A `red` bundle whose `checks` are all passing is a
 * contradiction worth surfacing — it means the test did not fail, so it is not
 * yet evidence of missing behaviour.
 */
export type RunEvidencePhase = "red" | "green" | "refactor" | "checks";

/** Result of one named check. `skipped` is distinct from `passed` on purpose. */
export type RunCheckStatus = "passed" | "failed" | "skipped" | "errored";

/**
 * One check the runner executed — formatting, analysis, types, unit, contract,
 * component, integration, performance, security, accessibility.
 *
 * `name` is free-form because the set differs per repo and per language, and a
 * closed union here would make Lexi reject evidence from a repo that added a
 * check. The *interpretation* of a missing check belongs to whatever consumes
 * the bundle, which can see the whole set; a validator that silently dropped
 * unknown names would hide exactly that.
 */
export interface RunCheckResult {
  name: string;
  status: RunCheckStatus;
  /** Human-readable failure output, truncated by the sender. */
  detail?: string;
  durationMs?: number;
}

/**
 * A file the runner produced and stored somewhere Lexi can later fetch —
 * typically a GitHub Actions artifact, a JUnit XML report, or a screenshot.
 *
 * `uri` is recorded, never dereferenced at ingest time. Fetching an
 * attacker-supplied URL from inside the orchestrator, which holds GitHub App
 * and Slack credentials, is a server-side request forgery with extra steps.
 * Whoever consumes an artifact does so knowingly and with its provenance in
 * hand.
 */
export interface RunEvidenceArtifact {
  type: "screenshot" | "video" | "log" | "report" | "trace" | "coverage";
  uri: string;
  /** Optional content digest, so a later fetch can be checked against it. */
  sha256?: string;
  label?: string;
}

/**
 * The RED-phase claim: this test failed, and here is the failure.
 *
 * `failureOutput` matters more than the boolean. "A test failed" is cheap to
 * assert and cheap to fake; a failure message that names the missing behaviour
 * is what distinguishes a real RED phase from a broken fixture — which is the
 * exact distinction the test-plan gate asks a human to confirm.
 */
export interface FailingTestProof {
  testName: string;
  /** Test file path, repo-relative. */
  file?: string;
  failureOutput: string;
  /**
   * Acceptance criterion this test was written against, when the work came
   * from an approved spec.
   *
   * Optional today because acceptance criteria are still free text — they are
   * newline-split out of one coverage dimension and have no stable ids, so
   * there is nothing durable to point at. The field exists now so the runner
   * contract does not have to change when they gain ids; until then it stays
   * empty rather than carrying a line number that renumbers on every edit.
   */
  acceptanceCriterionId?: string;
}

/**
 * One report from one runner about one attempt.
 *
 * Bundles are additive: several arrive per attempt (a `red`, then a `green`,
 * then `checks`), and none supersedes another. Storing an ordered log rather
 * than a mutable "latest evidence" record is what lets a reviewer see that the
 * test failed before it passed — collapsing to the final state throws away the
 * only thing that makes it TDD rather than a test written afterwards.
 */
export interface RunEvidenceBundle {
  /**
   * The `QuickFixAttempt.id` this evidence belongs to, echoed back from the
   * dispatch input.
   *
   * NOT AUTHORITY. Knowing an attempt id does not entitle a caller to write
   * against it — the bearer token does. The id is a correlation key, and it is
   * validated as one: an unknown id is rejected rather than creating an
   * orphan row, so a typo cannot quietly accumulate evidence attached to
   * nothing.
   */
  attemptId: string;
  phase: RunEvidencePhase;
  /** GitHub Actions run id, when the sender knows it. */
  workflowRunId?: string;
  /** Commit the evidence was produced against. */
  commitSha?: string;
  checks?: RunCheckResult[];
  failingTests?: FailingTestProof[];
  artifacts?: RunEvidenceArtifact[];
  /**
   * Sender-supplied timestamp, ISO 8601. Advisory only — the store stamps its
   * own receipt time, because a clock in another repo's runner is not a clock
   * Lexi controls and an audit trail ordered by sender time is reorderable by
   * the sender.
   */
  reportedAt?: string;
}

/** Outcome of an ingest attempt, as reported back to the runner. */
export interface RunEvidenceReceipt {
  accepted: boolean;
  attemptId: string;
  phase: RunEvidencePhase;
  /** Server-assigned id of the stored bundle. */
  evidenceId?: string;
  /**
   * True when this bundle was already stored and the existing row was returned.
   *
   * Not an error, and deliberately not reported as a rejection: a runner that
   * both POSTs a bundle and uploads it as an artifact is doing exactly what it
   * was told to do, and the second arrival is the fallback working rather than
   * a fault. The flag exists so the runner can tell "stored" from "already had
   * it" without inferring anything from a status code.
   */
  deduplicated?: boolean;
  /** Present when `accepted` is false. */
  reason?: string;
}
