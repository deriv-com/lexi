import { readFileSync } from "fs";
import { resolve } from "path";
import { load } from "js-yaml";
import { z } from "zod";

/**
 * Loads and validates `programme-policy.yaml` from `GOVERNANCE_CONFIG_DIR`.
 *
 * The YAML `enabled` keys are the policy half of the kill switch —
 * `PROGRAMME_ENABLED` / `PROGRAMME_AUTO_MERGE_ENABLED` are the env half,
 * and BOTH must be true for the capability to act (the `SPEC_APPROVAL_ENABLED`
 * + `writes.approvalEnabled` pairing, applied again). A loose cast here would
 * let a typo silently widen the auto-merge gate, so this validates like
 * `loadSpecPolicy` does rather than trusting the file.
 */

/** Default location: `programme-policy.yaml` inside `GOVERNANCE_CONFIG_DIR` (`./config` when unset). */
export const PROGRAMME_POLICY_PATH = resolve(process.env.GOVERNANCE_CONFIG_DIR ?? "config", "programme-policy.yaml");

const evidencePhaseSchema = z.enum(["red", "green", "refactor", "checks"]);

const programmePolicySchema = z
  .object({
    version: z.number(),
    // PROGRAMME_ENABLED's YAML half. Absent means off — a new capability
    // never turns itself on by omission.
    enabled: z.boolean().default(false),
    programmes: z
      .object({
        /**
         * The ONLY repo keys a programme may target. Checked against
         * `repos.yaml` at boot by the orchestrator wiring; a key here
         * that is not registered (or not `autonomyTier: autonomous`) fails
         * fast rather than waiting to refuse at dispatch time.
         */
        allowedRepoKeys: z.array(z.string().min(1)).default([]),
        /**
         * Per-rebuild-key working settings. Every key here must also be in
         * allowedRepoKeys.
         *
         * - `baseBranch`: the branch task PRs target and auto-merge lands on.
         *   Governance blocks agent writes to default branches, so a
         *   programme that has to keep moving works on a feature branch the
         *   orchestrator creates from the default branch at start. Refused at
         *   boot when it names a trunk/default branch. Every programme on the
         *   key shares it.
         * - `workingBranchPrefix`: a branch PER PROGRAMME instead. At creation the orchestrator names it
         *   `<prefix><programme-key>-<YYYYMMDD>` (UTC), creates it from the
         *   default branch, and stores it on the programme; its task PRs
         *   target it and auto-merge lands there, and a human later merges
         *   the finished programme's branch to the default. Exclusive with
         *   `baseBranch`.
         * - `requireExploratorySweep`: overrides milestoneReview's global
         *   value for this key. `false` = no preview exists yet; a milestone
         *   completes on merged tasks alone and the owner verifies locally.
         * - `requireTechnicalSpec`: plan a `technical-spec` task ahead of the
         *   scaffold. The coding agent authors the technical spec into the
         *   repo (docs/technical-spec/<programme>.md), a human merges that PR,
         *   and its "Acceptance criteria by screen" table re-assigns criteria
         *   to screen tasks before they dispatch.
         * - `trackingIssue`: open one GitHub issue per programme in the rebuild
         *   repo holding the checklist of tasks, decisions and links; kept in
         *   step by the advance job.
         */
        repoSettings: z
          .record(
            z.string(),
            z.object({
              baseBranch: z.string().min(1).optional(),
              workingBranchPrefix: z
                .string()
                .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*[/-]$/, "workingBranchPrefix must be a git-safe prefix ending in '/' or '-'")
                .optional(),
              requireExploratorySweep: z.boolean().optional(),
              requireTechnicalSpec: z.boolean().default(false),
              /**
               * Merge each LATER milestone's technical-spec PR without a
               * person, once GitHub reports it mergeable into the working
               * branch. The programme's own technical spec (the first one,
               * which sets the architecture) still waits for a person. The
               * milestone documents extend it within an approved business
               * spec, and their open questions still post to Slack.
               */
              autoMergeMilestoneTechnicalSpecs: z.boolean().default(false),
              /**
               * Plan each queued milestone (`propose_milestone_plan` with
               * `deferred: true`) from the advance job, once its spec is
               * approved and every earlier milestone's build is complete, so
               * milestones ship in order without anyone asking.
               */
              autoPlanQueuedMilestones: z.boolean().default(false),
              /**
               * The technical spec that already governs the working branch.
               * Briefs cite it when a programme's own technical-spec task
               * was retired (cancel_build_tasks) because the work it
               * would specify already exists. Without it, such a programme's
               * briefs would name a spec that was never written, and the
               * agent would hand back without building anything.
               */
              existingTechnicalSpecPath: z.string().min(1).optional(),
              /**
               * Repo-relative directory of per-page feature specs in the
               * rebuild repo (one Markdown document per feature). Briefs
               * list it at the task's base ref and tell each task to read
               * the document(s) for the page it builds; the technical-spec
               * task reads all of them. Absent = no feature specs.
               */
              featureSpecDir: z
                .string()
                .regex(
                  /^(?!\/)(?!.*(?:^|\/)\.+(?:\/|$))[A-Za-z0-9_./-]+$/,
                  "featureSpecDir must be a repo-relative path with no '.' or '..' segment",
                )
                .transform((value) => value.replace(/\/+$/, ""))
                .optional(),
              trackingIssue: z.boolean().default(false),
            }),
          )
          .prefault({}),
      })
      .prefault({}),
    dispatch: z
      .object({
        workflowFile: z.string().min(1).default("programme-build.yml"),
        maxConcurrentTasksPerProgramme: z.number().int().positive().default(3),
        /**
         * In-flight cap for model-bench arms (`start_model_bench`), counted
         * apart from the programme's own tasks so a bench run neither waits
         * behind the programme nor starves it. Sized so one bench run of the
         * standard model set dispatches in a single tick. 0 dispatches none.
         */
        maxConcurrentBenchTasksPerProgramme: z.number().int().nonnegative().default(8),
        maxTaskAttempts: z.number().int().positive().default(3),
        /**
         * Separate, bounded budget for failures that never reached the coding
         * agent — a dispatch GitHub refused, a runner that could not fetch its
         * brief. Those give their attempt back rather than spending
         * `maxTaskAttempts` on plumbing; once this budget is gone they are
         * charged to the build budget as before, so a permanently broken
         * repository still terminates. 0 restores the old behaviour exactly.
         */
        maxInfraFaults: z.number().int().nonnegative().default(3),
        /**
         * How many times a task may be re-armed because its PR conflicts with
         * a base a sibling moved. A conflict tests nothing about the build, so
         * it refunds its attempt rather than spending `maxTaskAttempts` on a
         * neighbour's merge; once this budget is gone conflicts are charged to
         * the build budget as before, so an unresolvable one still terminates.
         *
         * Sized against milestone width, not `maxTaskAttempts`: the worst
         * honest case is one conflict per sibling that merges ahead of the
         * task. 0 restores the old behaviour exactly.
         */
        maxConflictRearms: z.number().int().nonnegative().default(20),
        /**
         * Minutes after dispatch at which a task with nothing to show for it
         * is handed back. A run that ends without posting evidence OR a result
         * cannot be attributed to its attempt at all — workflow_dispatch
         * returns no run id and both other identifiers come off artifacts that
         * run never uploaded — so age is the only signal that it is never
         * coming back. Anchored on a GUARANTEED bound, not an observed one:
         * GitHub kills any job at its 6-hour ceiling, so nothing can be alive
         * past 360 minutes from job start, and the remainder covers queueing
         * and the 10-minute advance granularity. An observed maximum is not a
         * bound: a cap sized from a typical run declares a long, live run dead.
         */
        staleDispatchMinutes: z.number().int().positive().default(420),
        /**
         * The EXACT command the runner executes for each required check, keyed
         * by check name. Stated in the brief so an agent scaffolding a project
         * from nothing knows the contract it will be judged against.
         *
         * Without it a scaffold can ship `lint`, `test` and `build` scripts —
         * conventional, and three of the four right — but no `typecheck`, so
         * the `types` check fails with "Missing script" and auto-merge refuses
         * a PR whose code is otherwise fine.
         *
         * Mirrors the checks step of programme-build.yml. It is a duplicate of a
         * contract owned elsewhere, so if that step changes, change this in the
         * same PR — a brief that names the wrong command is worse than one that
         * names none.
         */
        checkCommands: z
          .record(z.string(), z.string().min(1))
          .default({
            types: "npm run typecheck",
            lint: "npm run lint",
            unit: "npm test",
            build: "npm run build",
          }),
        /**
         * Model escalation ladder, indexed by attempt number (attempt 1 → index
         * 0). The evidence gate never relaxes, so a cheaper first rung costs
         * retries, never correctness; the last rung repeats for attempts past
         * the end. Empty means "leave it to the runner's default model".
         */
        modelLadder: z.array(z.string().min(1)).default([]),
        /**
         * Per-task-kind override of the ladder's FIRST rung (e.g. screen tasks
         * start on the capable model). Kinds: scaffold | design-bindings |
         * data-layer | screen | integration | e2e.
         */
        modelByTaskKind: z.record(z.string(), z.string().min(1)).default({}),
        exploreWorkflowFile: z.string().min(1).default("programme-explore.yml"),
      })
      .prefault({}),
    autoMerge: z
      .object({
        // A SECOND switch, independent of the top-level `enabled`: dispatch
        // can run for weeks with humans merging before anyone flips this.
        // Absent means off.
        enabled: z.boolean().default(false),
        requiredEvidencePhases: z.array(evidencePhaseSchema).default(["red", "green", "checks"]),
        requiredChecks: z.array(z.string().min(1)).default([]),
        requireAcMatrixGreen: z.boolean().default(true),
        requireHeadShaMatch: z.boolean().default(true),
      })
      .prefault({}),
    milestoneReview: z
      .object({
        approverPermission: z.string().min(1).default("programme.milestone.approve"),
        /**
         * `gate`: every milestone parks the programme until a human clicks.
         * `notify`: autopilot — the card is posted, the milestone waits in
         * IN_REVIEW, but the programme keeps BUILDING; ONE final review card
         * parks it before HARDENING and approving it approves every pending
         * milestone. Default is the conservative one.
         */
        mode: z.enum(["gate", "notify"]).default("gate"),
        /**
         * A milestone cannot reach EVIDENCE_COMPLETE until an
         * `exploratory-sweep: passed` checks bundle exists for its head SHA.
         * Fail-closed: no preview URL → no sweep → milestone stays IN_PROGRESS
         * with a named reason.
         */
        requireExploratorySweep: z.boolean().default(true),
      })
      .prefault({}),
    hardening: z
      .object({
        labelPrefix: z.string().min(1).default("hardening_"),
        requireZeroOpenFindings: z.boolean().default(true),
      })
      .prefault({}),
    /**
     * Where the backend OpenAPI document lives and which operation families
     * are withheld from build agents. Absent means no API contract is
     * snapshotted and briefs carry none — the build instructions then forbid
     * backend calls outright rather than permitting invented ones.
     */
    apiContract: z
      .object({
        repoSlug: z.string().regex(/^[^/]+\/[^/]+$/),
        path: z.string().min(1),
        ref: z.string().min(1).default("master"),
        excludeTagPatterns: z.array(z.string().min(1)).default([]),
        /** Base URL the rebuilt apps call; travels in the brief. Empty → not stated. */
        baseUrl: z.string().default(""),
        /**
         * Authentication origin, which may be a DIFFERENT host from the core
         * API (for example `api.example.com` and `auth.example.com`).
         * Modelled explicitly because an auth flow built against the core
         * base URL fails in a way that looks like a broken login rather than
         * a wrong hostname. Empty → the brief says no auth host is stated and
         * the agent must not guess one.
         */
        authBaseUrl: z.string().default(""),
        /**
         * The pair the app must use when it is SERVED FROM the preview host,
         * which is a different backend stack from staging — not a variant
         * spelling of the same one.
         *
         * A preview origin is often CORS-allowed only by a preview auth host
         * that sets its cookies on the preview domain; the staging pair is
         * NOT granted for that origin, so an app that hardcodes it renders on
         * the preview and then fails every call — including unauthenticated
         * lookups on the login and signup forms, which is where an
         * exploratory sweep hits it first.
         *
         * Both pairs travel in the brief because the app resolves its bases
         * from its own hostname (the preview case is checked BEFORE the
         * production/staging branch) and must never hardcode either. Stating
         * only one is what makes hardcoding look correct.
         *
         * Empty → the brief states no preview stack and the agent implements
         * the staging pair alone, which is right for a rebuild with no
         * separate preview stack.
         */
        previewBaseUrl: z.string().default(""),
        previewAuthBaseUrl: z.string().default(""),
        /**
         * Operation families that stay behind FIXTURES in the rebuild (money in
         * motion cannot be e2e-tested against production with demo accounts).
         * Substring match on tags/paths; the brief lists the matching paths.
         */
        fixtureOnlyPatterns: z.array(z.string().min(1)).default([]),
        /**
         * Supplementary API documentation: prose
         * that says WHICH contract operation serves which journey, how each
         * behaves at runtime, and which ones are broken, duplicated or unsafe —
         * what the OpenAPI document alone left agents confused about. Every
         * brief carries each one by reference (served, like the contract, by
         * `GET /api/programme/api-references/:index/:sha`), and the
         * `prepare_technical_spec` digest reports whether each is readable.
         *
         * The contract stays the only list of callable endpoints: a reference
         * narrows or explains it, never extends it. Read with the GitHub App,
         * so its installation must cover `repoSlug`. `ref` is verbatim — a
         * branch is convenient and moves; pin a sha when that matters. The
         * brief pins the blob it saw, so one attempt reads one version.
         */
        referenceDocs: z
          .array(
            z.object({
              title: z.string().min(1),
              repoSlug: z.string().regex(/^[^/]+\/[^/]+$/),
              path: z.string().min(1),
              ref: z.string().min(1).default("main"),
            }),
          )
          .max(8)
          .optional(),
      })
      .optional(),
    /**
     * Read-only design sources. Figma file keys
     * that may be SNAPSHOTTED without a prototype binding — the real
     * production designs. Writes to these files remain forbidden; this list
     * widens reads only.
     */
    designSources: z
      .object({
        allowedFileKeys: z.array(z.string().min(1)).default([]),
      })
      .prefault({}),
    /**
     * Reference (existing production) repo per rebuild repo key, for the parity
     * inventory the rebuild must match or exceed.
     *
     * Optional: leave it empty when no production parity floor applies.
     */
    referenceRepos: z.record(z.string(), z.string().min(1)).default({}),
    /**
     * Prototype INTENT reference per rebuild repo key. Distinct from
     * `referenceRepos`: that one was a production parity floor; this one is a
     * read-only checkout the build agent may use for journeys and flows.
     * Briefs instruct a REBUILD of the UI, not verbatim component ports.
     *
     * `repoKey` must be registered in repos.yaml. `ref` is verbatim.
     * `paths` is an advisory reading order for a large tree.
     */
    uiSources: z
      .record(
        z.string(),
        z.object({
          repoKey: z.string().min(1),
          ref: z.string().min(1).default("main"),
          paths: z.array(z.string().min(1)).default([]),
        }),
      )
      .prefault({}),
    /**
     * Business-spec seeding for rebuild programmes.
     * Active only in the rebuild Slack channel: productSpecDomains defaults
     * here and OpenSpec is refused when `banOpenSpec` is true. `path` is the
     * product spec's root file (`PRODUCT_SPEC.md`); `ref` overrides the repo
     * defaultBranch when the productSpec port reads it.
     */
    businessSpec: z
      .object({
        repoKey: z.string().min(1),
        ref: z.string().min(1).default("master"),
        path: z.string().min(1).default("PRODUCT_SPEC.md"),
        banOpenSpec: z.boolean().default(true),
      })
      .optional(),
  })
  .strip();

export type ProgrammePolicy = z.infer<typeof programmePolicySchema>;

export function loadProgrammePolicy(path: string = PROGRAMME_POLICY_PATH): ProgrammePolicy {
  const raw = readFileSync(path, "utf-8");
  return parseProgrammePolicy(raw);
}

/**
 * Branch names a programme may never use as its working base. Mirrors the
 * governance rule (protected-branches.ts) closely enough to fail at BOOT
 * rather than at the first auto-merge: a base named here would make every
 * merge verdict pass and every merge refuse, which reads as a broken gate.
 */
const TRUNK_BASE_BRANCH = /^(main|master|develop|dev|trunk|stable|qa|staging|production|prod|release)$/i;

export function parseProgrammePolicy(raw: string): ProgrammePolicy {
  const parsed = load(raw);
  const result = programmePolicySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid programme policy:\n${issues}`);
  }
  const policy = result.data;
  for (const [key, settings] of Object.entries(policy.programmes.repoSettings)) {
    if (!policy.programmes.allowedRepoKeys.includes(key)) {
      throw new Error(
        `Invalid programme policy: programmes.repoSettings names ${key}, which is not in programmes.allowedRepoKeys.`,
      );
    }
    if (settings.baseBranch?.trim() && settings.workingBranchPrefix) {
      throw new Error(
        `Invalid programme policy: programmes.repoSettings.${key} sets both baseBranch and workingBranchPrefix; pick one.`,
      );
    }
    // `release/` and `release-` both, matching protected-branches.ts's shared
    // release lines, so the mistake fails at boot, not at the first stuck merge.
    if (settings.workingBranchPrefix && /^release[/-]/i.test(settings.workingBranchPrefix)) {
      throw new Error(
        `Invalid programme policy: programmes.repoSettings.${key}.workingBranchPrefix "${settings.workingBranchPrefix}" names release branches.`,
      );
    }
    const base = settings.baseBranch?.trim() ?? "";
    if (base && (TRUNK_BASE_BRANCH.test(base) || /^release\//i.test(base))) {
      throw new Error(
        `Invalid programme policy: programmes.repoSettings.${key}.baseBranch "${base}" is a trunk or default branch. ` +
          `Programmes do not land code on those; name a working branch (e.g. feat/web-rebuild).`,
      );
    }
  }
  return policy;
}

/** Effective per-key settings, with every optional resolved to its default. */
export function repoSettingsFor(
  policy: ProgrammePolicy,
  repoKey: string,
): {
  baseBranch: string | null;
  workingBranchPrefix: string | null;
  requireExploratorySweep: boolean;
  requireTechnicalSpec: boolean;
  autoMergeMilestoneTechnicalSpecs: boolean;
  autoPlanQueuedMilestones: boolean;
  existingTechnicalSpecPath: string | null;
  featureSpecDir: string | null;
  trackingIssue: boolean;
} {
  const settings = policy.programmes.repoSettings[repoKey];
  return {
    baseBranch: settings?.baseBranch?.trim() || null,
    workingBranchPrefix: settings?.workingBranchPrefix || null,
    requireExploratorySweep:
      settings?.requireExploratorySweep ?? policy.milestoneReview.requireExploratorySweep,
    requireTechnicalSpec: settings?.requireTechnicalSpec ?? false,
    autoMergeMilestoneTechnicalSpecs: settings?.autoMergeMilestoneTechnicalSpecs ?? false,
    autoPlanQueuedMilestones: settings?.autoPlanQueuedMilestones ?? false,
    existingTechnicalSpecPath: settings?.existingTechnicalSpecPath?.trim() || null,
    featureSpecDir: settings?.featureSpecDir || null,
    trackingIssue: settings?.trackingIssue ?? false,
  };
}

/**
 * The working branch a NEW programme on this key targets, or null to work on
 * the repository's default branch. A fixed `baseBranch` is shared by every
 * programme; a `workingBranchPrefix` gives each programme its own, dated so a
 * programme re-created later under the same key does not land on a branch a
 * previous one left behind. The key is already a lowercase slug, so the name
 * is git-safe. Resolved once, at creation; the programme stores the result.
 */
export function programmeWorkingBranch(
  settings: { baseBranch: string | null; workingBranchPrefix: string | null },
  programmeKey: string,
  now: Date,
): string | null {
  if (settings.baseBranch) return settings.baseBranch;
  if (!settings.workingBranchPrefix) return null;
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const branch = `${settings.workingBranchPrefix}${programmeKey}-${day}`;
  // Unreachable while the name ends in -YYYYMMDD; pinned so a change to the
  // format cannot quietly produce a trunk name.
  if (TRUNK_BASE_BRANCH.test(branch)) {
    throw new Error(`Working branch "${branch}" is a trunk or default branch name.`);
  }
  return branch;
}
