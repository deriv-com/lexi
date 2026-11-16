/**
 * Rebuild programme contracts.
 *
 * A *programme* is Lexi rebuilding a whole product from scratch in a
 * dedicated agent-owned repository (`autonomyTier: autonomous` in
 * `repos.yaml`, see `AutonomyTier`): programme → milestones → build tasks, each build task
 * dispatched to the rebuild repo's `programme-build.yml` and returning evidence
 * through the existing `POST /api/evidence` channel (`RunEvidenceBundle`).
 *
 * Types only, like the rest of this package. The state machines that enforce
 * the transitions live in `@lexi/programme`; the I/O lives in the
 * orchestrator's programme services.
 */

/**
 * Programme lifecycle. `MILESTONE_REVIEW` and `HARDENING` are the two
 * human-gated stations: a programme cannot pass a milestone without a human
 * approval click, and cannot complete until a human concludes the hardening
 * with zero open findings.
 */
export type ProgrammeStatus =
  | "PROPOSED"
  | "SEEDED"
  | "PLANNED"
  | "BUILDING"
  | "MILESTONE_REVIEW"
  | "HARDENING"
  | "COMPLETE"
  | "PAUSED"
  | "CANCELLED";

export type MilestoneStatus =
  | "PENDING"
  | "READY"
  | "IN_PROGRESS"
  | "EVIDENCE_COMPLETE"
  | "IN_REVIEW"
  | "APPROVED"
  | "CHANGES_REQUESTED";

/**
 * Build-task lifecycle. `EVIDENCE_RED` before `EVIDENCE_GREEN` is not
 * decoration: the auto-merge gate requires a red bundle to have been received
 * before the first green one, which is the only durable difference between a
 * test that failed before it passed and one written afterwards.
 */
export type BuildTaskStatus =
  | "PENDING"
  | "READY"
  | "DISPATCHED"
  | "EVIDENCE_RED"
  | "EVIDENCE_GREEN"
  | "PR_OPEN"
  | "MERGED"
  | "VERIFIED"
  | "HANDBACK"
  | "FAILED"
  // A task a human retired before it ran: the work it describes is already on
  // the branch, or the slice no longer wants it. It is NOT a failure and NOT
  // an attempt — it never dispatched. It counts as SATISFIED for dependents
  // (see task-graph) and as done for milestone completion, because the whole
  // point of retiring "scaffold, already built" is to let the screens that
  // depend on it proceed. Reversible: CANCELLED -> PENDING.
  | "CANCELLED";

/**
 * One supplementary API document (`BuildTaskBrief.apiReferences[n].url`),
 * served by `GET /api/programme/api-references/:index/:sha`. JSON rather
 * than raw Markdown because the runner only accepts JSON brief inputs.
 */
export interface ApiReferenceDocument {
  title: string;
  repoSlug: string;
  path: string;
  /** The policy ref it was resolved from (branch, tag or sha). */
  ref: string;
  /** Git blob SHA of `markdown`. */
  sha: string;
  markdown: string;
}

/**
 * The structured build brief — the wire contract fetched by the rebuild
 * repo's runner from `GET /api/programme/briefs/:attemptId` (bearer
 * `BUILD_BRIEF_TOKEN`). Replaces prose-in-`bug_text`: everything large
 * travels by reference, never inline, and `attemptId` is finally on the wire
 * so evidence correlation stops being timestamp inference.
 */
export interface BuildTaskBrief {
  briefVersion: 1;
  /** `QuickFixAttempt.id` — echoed into every evidence bundle the run POSTs. */
  attemptId: string;
  buildTaskId: string;
  programmeKey: string;
  milestone: { id: string; ordinal: number; title: string };
  spec: {
    specId: string;
    /** "organization/repository" the spec issue lives in. */
    trackingRepoSlug: string;
    issueNumber: number;
    revision: number;
    /**
     * Digest of the rendered spec at the approved revision. The runner
     * verifies what it fetched against this before acting — a brief must not
     * silently execute a spec revision nobody approved.
     */
    contentHash: string;
  };
  /** `AC-<8 hex>` ids from `acceptance-criteria.ts`, with their text. */
  acceptanceCriteria: Array<{ id: string; text: string }>;
  /**
   * The programme spec's criteria, when this task's milestone is governed by
   * a spec of its own. Rules that bind every milestone — session
   * states, currency, errors, accessibility. CONTEXT, not this task's
   * criteria: nothing binds a test to them and the merge gate never asks for
   * one; the technical spec cites the ones each screen relies on. Absent when
   * the milestone's spec IS the programme spec (its criteria are already in
   * `acceptanceCriteria`).
   */
  programmeCriteria?: { specId: string; criteria: Array<{ id: string; text: string }> };
  /**
   * Snapshot of the Figma prototype, served by the orchestrator
   * (`GET /api/programme/design-context/:id`). By reference because the
   * runner has no Figma access and Figma screenshot URLs are short-lived.
   */
  designContext?: { documentId: string; url: string; nodeIds: string[] };
  /** design-system component catalogue snapshot, mobile programmes only. */
  componentCatalogue?: { documentId: string; url: string };
  /**
   * The FILTERED backend OpenAPI snapshot, served by
   * `GET /api/programme/api-contract/:id`. The single source of endpoints a
   * build agent may target — archived/admin/internal operations are removed
   * before serving, and inventing an endpoint is a handback offence.
   */
  apiContract?: {
    documentId: string;
    url: string;
    title: string;
    version: string;
    operationCount: number;
    /** Base URL the rebuilt app calls (a staging host). Absent = not stated in policy. */
    baseUrl?: string;
    /** Paths that must stay behind fixtures (money in motion; never called live). */
    fixtureOnlyPaths?: string[];
  };
  /**
   * Supplementary API documentation (programme-policy.yaml
   * `apiContract.referenceDocs`): which contract operation serves which
   * journey, how each behaves at runtime, and which are broken, duplicated or
   * unsafe. Each `url` serves `ApiReferenceDocument` JSON, pinned to the blob
   * `sha` the brief saw. READ-ONLY context that narrows or explains
   * `apiContract`, never extends it: an operation named here that the
   * contract lacks is still out of bounds. Absent when policy names none, or
   * when none was readable when the brief was composed.
   */
  apiReferences?: Array<{
    title: string;
    url: string;
    /** "organization/repository" the document lives in. */
    repoSlug: string;
    path: string;
    /** Git blob SHA of the version served. */
    sha: string;
  }>;
  /**
   * Structural inventory of the EXISTING production app the rebuild replaces
   * (routes, screens, flags, events). A FLOOR: every entry must exist in the
   * rebuild; fewer is a handback. Served by `GET /api/programme/parity/:id`.
   */
  parityInventory?: {
    documentId: string;
    url: string;
    referenceRepoSlug: string;
    routeCount: number;
    featureCount: number;
  };
  /**
   * The EXISTING implementation this rebuild ports FROM, when one exists.
   *
   * Unlike every other entry here this is a git repository, not a document
   * the orchestrator serves: a React app is thousands of files plus assets,
   * and no JSON snapshot could carry its components, CSS, layout logic and
   * responsive behaviour faithfully. The runner checks it out itself, which
   * means the builder App's installation must cover `repoSlug` — a brief
   * naming a repo the runner cannot read fails at checkout, loudly.
   *
   * Its presence IS the mandate: reuse the existing implementation as closely
   * as possible and spend the effort on production integration — APIs, auth,
   * state, feature flags, analytics, error and loading states, code
   * splitting, bundle size, render performance, tests. Regenerating UI that
   * already exists is the waste this field is here to prevent.
   *
   * READ-ONLY by construction: it is a different repository from the one the
   * task commits to, so the runner cannot modify it even by accident.
   *
   * Absent means there is no existing implementation to port — the design
   * context is then the UI source, as before. Notably absent for mobile: a
   * React prototype cannot be reused by a Flutter build, and how (or whether)
   * that conversion works is an open question nobody has answered. A brief
   * that claimed otherwise would be inventing a capability.
   */
  uiSource?: {
    /** "organization/repository" of the implementation to port from. */
    repoSlug: string;
    /**
     * Git ref to check out — branch, tag or commit sha, taken verbatim from
     * policy. A branch is convenient and NOT reproducible: two attempts of
     * one task can see different source, and the evidence will not say so.
     * Pin a sha in `programme-policy.yaml` when that matters.
     */
    ref: string;
    /**
     * Subtrees worth reading first, when the repo is large. Advisory: the
     * agent may read the whole tree, and an empty list means no hint.
     */
    paths?: string[];
  };
  /**
   * The branch this task's PR targets and its run checks out — the
   * programme's working branch (programme-policy.yaml
   * programmes.repoSettings.<key>.baseBranch). Absent = the repo's default
   * branch. Never a
   * trunk or default branch when present: the policy loader refuses those.
   */
  baseBranch?: string;
  /**
   * The programme's technical spec inside the rebuild repository, authored by
   * the `technical-spec` task and approved by a human merging its PR. Every
   * later task reads it from the checkout at this path and treats it as the
   * architecture it must follow. `sections` names the headings the document
   * must carry (the technical-spec task writes them; later tasks read them).
   */
  technicalSpec?: {
    path: string;
    sections: string[];
  };
  /**
   * Per-page feature specs in the rebuild repository (e.g.
   * `docs/feature-spec/`), read from the checkout like `technicalSpec`.
   * `paths` are the documents matched by name to this task's screens — for
   * the technical-spec task, every document in `dir`. Empty `paths` with a
   * `dir` means nothing matched by name and the agent picks the covering
   * spec itself from the directory. Behaviour detail for the page (fields,
   * validation, states, copy, edge cases); the acceptance criteria still win
   * where they disagree, and the technical spec still owns structure.
   */
  featureSpecs?: {
    dir: string;
    paths: string[];
  };
  /**
   * The programme's GitHub tracking issue in the rebuild repo: the task
   * checklist, the decisions, the links. The runner cites it in PR bodies so
   * a reviewer can find the programme's state from any PR.
   */
  trackingIssue?: { number: number; url: string };
  /**
   * What Lexi remembers that bears on this task: decisions humans recorded
   * for the programme, outcomes of earlier tasks (what was reused, modified,
   * handed back and why), conventions taught in Slack. Rendered text, budgeted
   * by the memory policy, ADVISORY — the trusted instruction and the
   * acceptance criteria always win where they disagree. Absent when memory is
   * disabled or nothing relevant is stored, which the runner states rather
   * than hides.
   */
  priorLearnings?: string;
  /**
   * Repo-relative path of the append-only build log the coding agent must
   * read first and append to in the same PR: decisions taken during the task,
   * gaps left open, gotchas the next task needs. The repository is the memory
   * the runner can see without the orchestrator; this is where it lives.
   */
  buildLogPath?: string;
  /**
   * Model the runner must use for this attempt, chosen from the policy's
   * escalation ladder by attempt number. Absent = runner default.
   */
  model?: string;
  /**
   * Agent effort for every phase (`claude -p --effort`): low | medium | high |
   * xhigh | max. Set only for a model-bench arm that asked for one. Absent =
   * the CLI default.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** 1-based attempt number this brief belongs to. */
  attempt: number;
  /** Task kind from the deterministic plan (scaffold | screen | ...). */
  taskKind: string;
  /** Suggested paths. Advisory only — the runner owns its own file layout. */
  fileManifestHints: string[];
  /** Tasks this one builds on; merged SHAs let the runner pin its base. */
  dependencies: Array<{ buildTaskId: string; prNumber?: number; mergedSha?: string }>;
  constraints: {
    maxFiles?: number;
    testKinds: Array<"unit" | "widget" | "integration" | "e2e" | "maestro">;
  };
  /**
   * Lexi-authored instruction, template-composed. Kept structurally separate
   * from `untrustedContext` (reporter/issue text) as a prompt
   * quarantine — the runner refuses a brief where one leaks into the other.
   */
  trustedInstruction: string;
  untrustedContext?: string;
}

/**
 * The pure auto-merge gate's verdict (`evaluateAutoMergeGate` in
 * `@lexi/programme`). `reasons` names every failed gate; it is empty only
 * when `allowed` is true, so a refusal is always explicable and a silent
 * pass is unrepresentable.
 */
export interface AutoMergeVerdict {
  allowed: boolean;
  reasons: string[];
  requiredChecks: Array<{ name: string; status: "passed" | "failed" | "missing" }>;
  acMatrix: Array<{ criterionId: string; status: "red" | "green" | "missing" | "unbound" }>;
  /** Whether a red bundle was received before the first green one. */
  redBeforeGreen: boolean;
}
