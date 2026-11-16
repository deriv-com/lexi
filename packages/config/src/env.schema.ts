import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().optional().default(""),

  // Legacy personal access token. OPTIONAL: every GitHub call now goes through
  // the Octokit client, so a deployment with GITHUB_APP_ID +
  // GITHUB_APP_PRIVATE_KEY needs no PAT at all. Retained as the local-dev and
  // rollback path — createOctokitClient still throws when neither the App
  // credentials nor a token are present.
  GITHUB_TOKEN: z.string().optional().default(""),
  /**
   * User PAT used only to mint signed GitHub attachment CDN URLs (issue
   * `body_html` / GFM). Installation tokens cannot do this. Falls back to
   * GITHUB_TOKEN when that value is still a user PAT (`ghp_` / `github_pat_`).
   */
  GITHUB_EVIDENCE_TOKEN: z.string().optional().default(""),
  // GitHub App credentials. When GITHUB_APP_ID and
  // GITHUB_APP_PRIVATE_KEY are both set, the Octokit client authenticates as an
  // App installation and GITHUB_TOKEN is ignored entirely; when either is
  // absent it falls back to the PAT.
  GITHUB_APP_ID: z.string().optional().default(""),
  /**
   * PEM private key for the App. Secrets are injected as env vars and multi-line
   * env values are fragile, so store the PEM block on one line with literal
   * "\n" escape sequences in place of its line breaks.
   * The Octokit factory normalises the escapes back into real newlines.
   */
  GITHUB_APP_PRIVATE_KEY: z.string().optional().default(""),
  // Optional. Pins the installation id and skips the runtime lookup, which is
  // more predictable (and one fewer API call) once the id is known.
  GITHUB_APP_INSTALLATION_ID: z.string().optional().default(""),
  GITHUB_OWNER: z.string().min(1, "GITHUB_OWNER is required"),
  GITHUB_REPO: z.string().min(1, "GITHUB_REPO is required"),
  BUGHUNT_LABEL: z.string().default("bug"),
  GITHUB_API_BASE_URL: z.string().optional().default(""),
  // Comma-separated GitHub org/owner names (besides GITHUB_OWNER, which is always trusted)
  // whose issues/PRs CrossOrgClosureChecker is allowed to treat as closure evidence -- e.g.
  // "acme" if fixes for GITHUB_OWNER's bug reports commonly land there. A link to any
  // owner NOT in this list is ignored, even if closed/merged, to prevent an external reporter
  // from fabricating "already fixed" evidence via an arbitrary unrelated repo they control.
  CROSS_ORG_TRUSTED_OWNERS: z.string().optional().default(""),

  SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN is required"),
  SLACK_SIGNING_SECRET: z.string().min(1, "SLACK_SIGNING_SECRET is required"),
  SLACK_APP_TOKEN: z.string().optional().default(""),
  SLACK_DEFAULT_CHANNEL: z.string().default("lexi"),

  /**
   * Model API key when the model is reached directly. Optional because a
   * deployment behind a gateway sets LITELLM_API_KEY instead; a piece that needs
   * a model and finds neither key refuses its requests rather than failing boot.
   */
  OPENAI_API_KEY: z.string().optional().default(""),
  /**
   * Preferred name for the Decision Engine's model group. Takes precedence over
   * OPENAI_MODEL, which is retained only so a rename does not require the code
   * and the secret to be updated in the same deploy — the fallback keeps a pod
   * that still has the old key working instead of silently resolving a default.
   */
  CLAUDE_MODEL: z.string().optional().default(""),
  /**
   * @deprecated Use CLAUDE_MODEL. The gateway routes on model-group name, not vendor.
   * Last fallback in the `LITELLM_CLAUDE_MODEL || CLAUDE_MODEL || OPENAI_MODEL` chains,
   * so keep it on the same model as LITELLM_CLAUDE_MODEL.
   */
  OPENAI_MODEL: z.string().default("claude-sonnet-5-5"),
  OPENAI_BASE_URL: z.string().optional().default(""),

  // Optional LiteLLM (or other OpenAI-API-compatible) gateway in front of the model provider.
  LITELLM_BASE_URL: z.string().optional().default(""),
  // Virtual API key issued by the LiteLLM gateway (not a raw Anthropic API key).
  LITELLM_API_KEY: z.string().optional().default(""),
  // LiteLLM model group name for the agent / unattended fallback. Despite the
  // historical CLAUDE_ name, this is the deployment's default model group —
  // not Claude-only. Claude groups still work via the Anthropic Messages
  // client when the value starts with `claude-`.
  //
  // This default governs the unattended consumers (duplicate adjudication,
  // reproduction judging, image and video description) plus the Slack agent
  // when SLACK_AGENT_MODEL is empty.
  LITELLM_CLAUDE_MODEL: z.string().default("claude-sonnet-5-5"),

  /**
   * Masks personal data (emails, phone numbers, card numbers, IBANs, IP
   * addresses) out of everything the agent loop and the decision engine send to
   * a model. On unless set to exactly `false`: a typo keeps the protection.
   */
  MODEL_PII_MASKING: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v.trim().toLowerCase() !== "false"),
  /**
   * The deployment's own patterns to mask as `[redacted]`, e.g. customer or
   * employee ids. Regular expressions, one per line or separated by `||`;
   * `/body/flags` sets flags. One that does not compile is skipped with a
   * warning at boot.
   */
  MODEL_PII_EXTRA_PATTERNS: z.string().optional().default(""),

  OWNERSHIP_CONFIG_PATH: z.string().default("config/ownership.yaml"),
  QUICK_FIX_OWNERS_CONFIG_PATH: z.string().default("config/quick-fix-owners.yaml"),

  REPRODUCTION_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  REPRODUCTION_MIN_RUNTIME_MS: z.coerce.number().int().positive().default(2000),
  REPRODUCTION_MAX_RUNTIME_MS: z.coerce.number().int().positive().default(8000),
  // Deterministic mock-provider timing. Set both to 0 in tests and certification
  // runs: a non-zero delay routes the job through BullMQ's delayed set, whose
  // promotion latency makes pipeline timing non-reproducible. Unset in
  // dev/prod, where the random min–max jitter is the desired simulation.
  REPRODUCTION_DELAY_MS: z.coerce.number().int().nonnegative().optional(),
  REPRODUCTION_WORK_MS: z.coerce.number().int().nonnegative().optional(),
  // Which ReproductionProvider adapter to wire up: mock | slack | claude | bre
  REPRODUCTION_PROVIDER: z.enum(["mock", "slack", "claude", "bre"]).default("mock"),
  // Channel or bot-DM channel id where the reproduction bot is mentioned/replies in-thread.
  REPRODUCTION_SLACK_CHANNEL: z.string().optional().default(""),
  // The reproduction bot's own Slack user id -- only its thread replies are treated as status updates.
  REPRODUCTION_BOT_USER_ID: z.string().optional().default(""),
  // Comma-separated, case-insensitive substrings that mark a reply as "bug reproduced".
  REPRODUCTION_REPRODUCED_KEYWORDS: z.string().default("reproduced,verified"),
  // Comma-separated, case-insensitive substrings that mark a reply as "could not reproduce".
  // Includes the phrasings people use ("not reproduced", "unable to reproduce"),
  // not only a bot's structured `Reproduced: No` label, so a human verdict is
  // not scored as an in-progress note. The free-text ambiguity guard is co-occurrence-based,
  // so "unable to reproduce" still demotes to inconclusive when the same reply
  // also reports being blocked.
  REPRODUCTION_CANNOT_REPRODUCE_KEYWORDS: z
    .string()
    .default(
      "cannot reproduce,could not reproduce,couldn't reproduce,can't reproduce,cant reproduce," +
        "unable to reproduce,not reproducible,not reproduced,no repro",
    ),
  // Comma-separated, case-insensitive substrings that mark a reply as a bot-side failure.
  REPRODUCTION_FAILED_KEYWORDS: z.string().default("error,failed"),
  // Local directory where screenshots/logs attached to the bot's thread replies are downloaded to.
  EVIDENCE_STORAGE_PATH: z.string().default("./data/evidence"),


  // Gates the daily automation sweep. Defaults to true so existing
  // deployments are unaffected; set false to stop the sweep without taking
  // the whole scheduler down (it posts issue comments, which email watchers).
  DAILY_AUTOMATION_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  SCHEDULER_DAILY_AUTOMATION_CRON: z.string().default("0 6 * * *"),
  SCHEDULER_BACKLOG_CLEANUP_CRON: z.string().default("0 2 * * 0"),
  SCHEDULER_RETRY_QUEUE_CRON: z.string().default("*/15 * * * *"),
  SCHEDULER_PENDING_CLOSURE_CRON: z.string().default("0 8 * * *"),
  SCHEDULER_INTAKE_WATCHER_CRON: z.string().default("*/10 * * * *"),
  INTAKE_WATCHER_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  /**
   * The multi-turn intake coaching loop (`IntakeConversationService`).
   *
   * Default OFF. When on, `@Lexi file a bug` opens a persisted draft and
   * coaches the reporter through the missing fields, then runs the full
   * duplicate/regression decision against the live issues corpus.
   * It fails closed: if the corpus is unreadable, has never synced, or the
   * duplicate adjudicator is the uncalibrated heuristic, intake refuses to
   * decide rather than filing a possible duplicate. See
   * `intake-decision-dependencies.ts`.
   */
  INTAKE_CONVERSATION_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  SCHEDULER_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),

  METRICS_PREFIX: z.string().default("lexi_"),

  // Policy engine — auto-close gates (tunable without redeploy when set via env)
  POLICY_AUTO_CLOSE_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.85),
  POLICY_AUTO_CLOSE_MIN_SCENARIO_FIT: z.coerce.number().min(0).max(1).default(0.75),

  // GitHub intake webhook. Ships OFF: the route accepts an unauthenticated
  // webhook body until a token is set, and the controller 503s while either of
  // these is unset.
  GITHUB_ADLC_INTAKE_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  ADLC_INTAKE_WEBHOOK_TOKEN: z.string().optional().default(""),

  // Governed writes: the master switch and dry-run mode for every pipeline write.
  GOVERNED_WRITES_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  GOVERNED_DRY_RUN: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  PENDING_CLOSURE_ENABLED: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v === "true"),
  // Semantic duplicate search. Default off: requires pgvector infrastructure.
  // Turn on only with a real, populated pgvector index.
  DUPLICATE_SEMANTIC_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  // LLM-based duplicate adjudication. Default off: uses heuristic when disabled.
  DUPLICATE_LLM_ADJUDICATION_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  // Human adjudication for medium-confidence duplicates. Default off.
  DUPLICATE_HUMAN_ADJUDICATION_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  // Information consolidation before duplicate closure. Default on: this is a safety invariant.
  DUPLICATE_CONSOLIDATION_ENABLED: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v === "true"),
  // Slack channel for duplicate adjudication requests.
  DUPLICATE_ADJUDICATION_CHANNEL: z.string().optional().default(""),
  // Embedding model for pgvector index (OpenAI-compatible model name).
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  // Embedding model version for drift detection.
  EMBEDDING_MODEL_VERSION: z.string().default("v3-small-2024"),
  // Embedding dimensions (must match EMBEDDING_MODEL output).
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  // API key for embedding generation (defaults to OPENAI_API_KEY if not set).
  EMBEDDING_API_KEY: z.string().optional().default(""),
  // Base URL for embedding API (defaults to OPENAI_BASE_URL or LiteLLM gateway).
  EMBEDDING_BASE_URL: z.string().optional().default(""),
  // Closed-issue duplicate semantics (reopen / regression / canonical chain).
  // Default off: these paths create and reopen GitHub issues, so they require
  // certification cases before being enabled.
  CLOSED_ISSUE_SEMANTICS_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  INTAKE_API_TOKEN: z.string().optional().default(""),
  /**
   * Local-development escape hatch ONLY. When true, the intake API accepts
   * unauthenticated requests. Never enable in any shared or production
   * environment — an unauthenticated intake endpoint is an open write path
   * into issue creation and an open read path over submitted issue content.
   */
  INTAKE_ALLOW_UNAUTHENTICATED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Free-form label for the deployed config revision, reported by diagnostics
   * so operators can tell which config a running instance has. Not a secret.
   */
  CONFIG_REVISION: z.string().optional().default(""),
  GOVERNANCE_CONFIG_DIR: z.string().default("config"),
  // Daily digest delivery targets. Empty/0 means "persist only" — the digest is
  // never sent to a guessed channel or issue.
  DIGEST_SLACK_CHANNEL: z.string().optional().default(""),
  DIGEST_GITHUB_ISSUE: z.coerce.number().int().nonnegative().optional().default(0),
  SLACK_AGENT_ENABLED: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  // LiteLLM model group for Slack conversational agent (defaults to LITELLM_CLAUDE_MODEL when empty).
  SLACK_AGENT_MODEL: z.string().optional().default(""),
  // Slack user id (e.g. "U0TEST09", NOT a display name) mentioned when the
  // agent exhausts every path and has nothing to say. Empty means the agent
  // keeps its old impersonal fallback rather than posting a broken "<@>"
  // mention -- so this is config, not a source-level constant: who gets
  // escalated to is a per-deployment decision, and a hardcoded person would
  // silently outlive their ownership of this bot.
  SLACK_AGENT_HELP_CONTACT_USER_ID: z.string().optional().default(""),

  // `post_channel_message` — a standalone (non-threaded) Slack post. Schema
  // default stays FALSE (a deployment sets it true to enable it), the
  // same split ISSUE_CLOSE_ENABLED uses: a deployment that forgets the variable
  // gets the capability withheld, not granted. The default is false rather than
  // true because a thread reply is read by the people already in the
  // conversation and a channel post is read by everyone in the channel — the
  // second is not a louder version of the first.
  SLACK_CHANNEL_POST_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  // Comma-separated Slack CHANNEL IDs (C…/G…, never a D… DM or a U… user) the
  // tool may post to. Empty is not "anywhere" — it means the current channel
  // only, which is the whole of the use case this shipped for (broadcasting a
  // handover into the channel the thread is already in). Widening it is a
  // deliberate operator act, and the tool still refuses a channel absent here.
  SLACK_CHANNEL_POST_ALLOWLIST: z.string().optional().default(""),

  // Batch and notification hardening — all default off until certification passes.
  AGENT_BATCH_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  AGENT_PROACTIVE_NOTIFICATIONS_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  AGENT_OWNER_MENTIONS_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  AGENT_BATCH_MAX_ISSUES: z.coerce.number().int().positive().default(50),
  AGENT_BATCH_CONCURRENCY: z.coerce.number().int().positive().default(5),
  AGENT_NOTIFICATION_MIN_PRIORITY: z.string().optional().default("P2"),
  AGENT_NOTIFICATION_DEDUP_WINDOW_MS: z.coerce.number().int().nonnegative().default(300_000),
  AGENT_OWNER_MENTION_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),

  // Evidence-First Pipeline — off until live validation passes.
  EVIDENCE_PIPELINE_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  EVIDENCE_PIPELINE_LLM_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  EVIDENCE_PIPELINE_ENGINEERING_INVESTIGATION_ENABLED: z.string().optional().default("true").transform((v) => v === "true"),

  // Corpus synchronization
  SCHEDULER_CORPUS_SYNC_CRON: z.string().default("*/15 * * * *"),
  CORPUS_SYNC_ENABLED: z.string().optional().default("true").transform((v) => v === "true"),

  // Engineering intelligence: GitHub Projects reads and writes.
  PROJECTS_V2_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  PROJECTS_V2_WRITES_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  // Lets the agent's create_pull_request tool open a PR in a product repo from a
  // branch that already exists. Defaults off, matching how every other write
  // aimed at a product repo (QUICK_FIX_TRIGGER_ENABLED, STALE_PR_CHASE_ENABLED)
  // ships: the code lands ready and an operator flips it deliberately.
  //
  // Turning this on ALSO requires the GitHub App to hold PullRequests:write on
  // the target repo. The App's current grants cover Actions and Issues, not
  // pull requests, so flipping this alone converts a clean "disabled by feature
  // flag" refusal into a runtime permission error — which looks enabled and is
  // therefore worse. Grant the permission first.
  PR_CREATE_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  // Gates the agent's `close_pull_request` tool: a HUMAN-INVOKED close of a
  // single open PR, with a required reason posted as a comment first.
  //
  // Read this next to STALE_PR_CHASE_ENABLED below, which stays false. That flag
  // is autonomous — a nightly sweep deciding on its own which PRs to close —
  // and it is deliberately left off. This one closes nothing unless
  // a person with pr.close asks for a specific PR by number in a Slack thread,
  // and it refuses outright on a merged PR, an already-closed PR, or a failed
  // read. Enabling this does NOT enable that.
  //
  // A deployment that wants it on sets it in its own environment. The flag is
  // retained precisely so it can be turned OFF in a hurry: it is the kill
  // switch, not the rollout switch. Note what still gates a close underneath
  // it — GOVERNED_WRITES_ENABLED / GOVERNED_DRY_RUN at the mutation gateway,
  // and the pr.close permission (see its grant in authorization.yaml).
  //
  // The schema default is FALSE because it governs the case where the env var
  // is ABSENT: local dev, CI, a new environment, any harness that builds real
  // config. A destructive default there is inherited by people who never chose
  // it.
  PR_CLOSE_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  // Gates `reopen_pull_request` — the recovery half, and the reason closing is
  // no longer a one-way door. Follows PR_CLOSE_ENABLED's posture and must
  // not be turned off while that one is on: closing reachable with reopening
  // withheld is exactly the irreversibility that made a close tool hazardous.
  // Reopening restores work rather than destroying it, so it needs no `reason`
  // and sits on the `pr.reopen` rung (engineer) — the same rung pr.close now
  // holds.
  PR_REOPEN_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  // Gates `update_pull_request_branch` — catch an open PR's head up with its
  // base. Restorative (CI re-runs; the PR stays open) and cannot merge.
  // Schema default false; a deployment that wants it sets it true.
  PR_UPDATE_BRANCH_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  // Gates merge_pull_request, merge_into_branch, and update_submodule_pointer.
  // Schema default false; a deployment that wants it sets it true. Kill switch: set false and restart.
  // Requires pr.merge / branch.merge (platform_admin) and Contents:write plus
  // PullRequests:write on the target repo. Unattended merge (stale-PR chase,
  // issue-workflow automation) stays prohibited independently of this flag.
  PR_MERGE_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  // Gates create_branch. Schema default false; a deployment opts in.
  BRANCH_CREATE_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  // Gates `trigger_rebase_branch`, which dispatches the product repo's
  // rebase-branch.yml. That workflow replays a feature branch onto its base
  // across the nested stack and force-pushes each level with lease.
  //
  // Separate from BRANCH_CREATE_ENABLED and PR_MERGE_ENABLED even though all
  // three move refs: those two only ever ADD commits, so their worst case is a
  // revertable merge. This one rewrites history, so its worst case is a commit
  // no ref reaches. Kill switch: set false and restart.
  //
  // It gates the trigger_rebase_branch Slack tool, the only path left that
  // force-pushes a branch.
  BRANCH_REBASE_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  /**
   * Gates delete_branch. Defaults false: ref deletion is the one branch write
   * that destroys commits, so a deployment opts in rather than inherits it.
   */
  BRANCH_DELETE_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  // Gates `close_issue` — person-requested close of one GitHub issue in the
  // bug corpus, with a required reason posted as a comment first. Schema
  // default false; a deployment that wants it sets it true. Kill switch: set false and restart.
  ISSUE_CLOSE_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  // Gates `trigger_code_task` — the non-bug sibling of `trigger_direct_fix`.
  // Dispatches the same direct-fix.yml workflow into the same product repos, so
  // the mechanical blast radius is identical, but the authority is broader: a
  // chore or feature request has no reproduction to anchor it and its scope is
  // whatever the asker described. Kept as its own flag rather than folded into
  // QUICK_FIX_TRIGGER_ENABLED precisely so "Lexi may fix reproduced bugs" and
  // "Lexi may change product code on request" can be revoked independently.
  CODE_TASK_TRIGGER_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  /**
   * Bearer token for `POST /api/evidence` — the structured return channel from
   * a dispatched `direct-fix.yml` run.
   *
   * Empty by default and the endpoint fails CLOSED on empty (503). An unset token is a misconfiguration, never
   * "auth disabled": this endpoint is the only inbound path that can attach
   * test evidence to an attempt, so accepting unauthenticated posts would let
   * anyone fabricate a green check suite against a real attempt id.
   */
  EVIDENCE_WEBHOOK_TOKEN: z.string().optional().default(""),
  /**
   * Withholds the ingest endpoint entirely while off — a 404-equivalent 503
   * rather than an advertised route that always refuses. Separate from the
   * token so the route can be dark in an environment that nonetheless has a
   * token provisioned.
   */
  EVIDENCE_INGEST_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),




  // Quick-fix trigger: catches a bug reported in a Slack thread and dispatches
  // the target product repo's existing direct-fix.yml workflow (which
  // investigates, fixes, and opens the PR itself — Lexi is the front door,
  // not the author). Off by default: code ships ready, nothing dispatches
  // against acme/web-app or acme-internal/mobile-app until an
  // operator flips this.
  QUICK_FIX_TRIGGER_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  SCHEDULER_QUICK_FIX_POLL_CRON: z.string().default("*/5 * * * *"),
  // Stale-PR chase: nudge/close PRs trigger_direct_fix opened that sit
  // unreviewed, and enforce the per-reviewer open-PR cap. A DELIBERATELY
  // SEPARATE flag from QUICK_FIX_TRIGGER_ENABLED (which is already true in
  // production) — this auto-CLOSES real pull requests, a materially
  // different and more destructive capability than dispatching a workflow,
  // so it must not silently activate just because dispatch already is on.
  // Off by default; both this flag and QUICK_FIX_TRIGGER_ENABLED must be true.
  STALE_PR_CHASE_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  SCHEDULER_STALE_PR_CHASE_CRON: z.string().default("57 9 * * *"),

  // ---- Work items, specs, memory and cost --------------------------------
  // Every flag below defaults OFF. Each is enabled as its own deliberate
  // decision; nothing here turns itself on because a green build landed.

  // Lifts runProgressCheck() out of the dormant runDailyAutomation()
  // into its own scheduler job, so issue tracking can run WITHOUT enabling
  // the full daily sweep (which posts issue comments and emails watchers).
  // Keep this mutually exclusive with DAILY_AUTOMATION_ENABLED — the
  // orchestrator's own runProgressCheck() is still called by the daily sweep,
  // so both on means subjects get notified twice.
  PROGRESS_CHECK_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  SCHEDULER_PROGRESS_CHECK_CRON: z.string().default("13 9 * * 1-5"),
  // The 7-day stale-PR *nudge*, split out from the chase sweep. The
  // 14-day auto-close path is permanently fenced and is NOT reachable
  // from this job — nudging is a comment, closing is prohibited.
  STALE_PR_NUDGE_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  // Posts a Lexi PR's test link into its thread: the PR's own preview for a
  // PR into main, the umbrella PR's once a PR into a working branch merges
  // (config/repos.yaml products.<key>.previewLink). Runs inside the quick-fix
  // poll tick, so it also needs QUICK_FIX_TRIGGER_ENABLED.
  PREVIEW_LINK_RELAY_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  SCHEDULER_STALE_PR_NUDGE_CRON: z.string().default("27 9 * * 1-5"),

  // Memory subsystem (working/episodic/semantic/hierarchical). Read and
  // write paths both no-op while this is off; config/memory-policy.yaml
  // carries its own `enabled` key which this flag overrides at boot.
  MEMORY_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  // Per-turn cost ledger. Observability only — it never blocks, caps,
  // or downgrades a request. Off means no rows are written.
  COST_LEDGER_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  // create_issue as a governed planning tool. Withheld from the model
  // payload entirely while off, rather than advertised and then refused.
  WORK_ITEM_CREATE_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  SPEC_SESSIONS_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  SPEC_WRITES_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  SPEC_APPROVAL_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  // Model routing: a more capable model reserved for spec drafting and
  // task breakdown. Empty means "use the policy's capableModel".
  SPEC_DRAFT_MODEL: z.string().optional().default(""),
  // Exit gate: spec conformance verification. Reconstructs expectations
  // from the APPROVED spec revision and compares them with what was built.
  //
  // Reports drift; it never blocks. There is no code path in
  // @lexi/workflows/spec-conformance that fails a PR, closes anything, or gates
  // a deploy, and that is asserted structurally rather than promised.
  //
  // AND-ed with config/feature-policy.yaml: verification.specConformanceEnabled
  // (see isSpecConformanceEnabled) — either half false stops the feature, so it
  // can be killed from the environment without a config deploy.
  //
  // Off by default. The WRITE half (provenance at dispatch) ships separately;
  // until it lands nothing carries provenance, so every report would be
  // `unverifiable`.
  SPEC_CONFORMANCE_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  // Bounds on the diff the exit gate hands its judge. A large PR's diff blows
  // the model's context, so it is capped by files and by characters — and the
  // cap is disclosed in the artefact, never applied silently: a truncated diff
  // that reads as complete produces a confident `conforms` over code nobody
  // looked at, which is worse than `indeterminate`.
  //
  // Config rather than literals in the poller because the right budget is a
  // property of the deployment's model and context window, and because a cap
  // nobody can change is a cap nobody can raise when a legitimately large PR
  // keeps coming back inconclusive.
  SPEC_CONFORMANCE_DIFF_MAX_FILES: z.coerce.number().int().positive().default(40),
  SPEC_CONFORMANCE_DIFF_MAX_CHARS: z.coerce.number().int().positive().default(60000),
  // Fail boot when config/run-budgets.yaml cannot resolve every unified
  // budget key. Off by default — an unresolvable budget degrades to the
  // legacy default rather than taking the pod down, until an operator opts in.
  BUDGET_STRICT_MODE: z.string().optional().default("false").transform((v) => v === "true"),

  // Scheduled digest: the daily formatted report to Slack, on top of the manual
  // digest command. Off by default; posts to DIGEST_SLACK_CHANNEL, and the
  // digest service also no-ops without a channel.
  DIGEST_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  SCHEDULER_DIGEST_CRON: z.string().default("3 9 * * *"),



  // Rebase runs are minutes, not hours — the workflow caps at 30 and installs
  // no Flutter toolchain — so this polls more often than its siblings. A
  // force-push whose outcome is not reported leaves the requester unsure
  // whether their branch was rewritten.
  SCHEDULER_REBASE_POLL_CRON: z.string().default("*/2 * * * *"),

  /** LLM classification of which reproduction workflow an issue needs. */
  WORKFLOW_CLASSIFICATION_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),

  // ── Server app (apps/server) ────────────────────────────────────────────
  /** The agent's display name, used in Slack replies and logs. */
  AGENT_NAME: z.string().default("Lexi"),
  /**
   * Bearer token for the HTTP action endpoints (POST /process and friends).
   * Empty means every request to those endpoints is refused: an unset token
   * never means "open".
   */
  PROCESS_API_TOKEN: z.string().optional().default(""),
  /**
   * Wall-clock limit for one Slack turn. When it passes the turn is aborted
   * through its AbortSignal and whatever the runner returns is still posted.
   */
  SLACK_TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  /**
   * How long to wait for an aborted turn to return before posting a timeout
   * notice. A real answer that arrives after the notice is still posted.
   */
  SLACK_TURN_ABORT_GRACE_MS: z.coerce.number().int().nonnegative().default(30_000),
  /**
   * Turns one person may start per SLACK_USER_TURN_WINDOW_MS, checked before
   * any model call. Empty means 12 per 10 minutes; 0 turns the limit off.
   * Kept as text: a malformed value falls back to the default instead of
   * failing boot or switching the limit off.
   */
  SLACK_USER_TURN_LIMIT: z.string().optional().default(""),
  SLACK_USER_TURN_WINDOW_MS: z.string().optional().default(""),
  /** Comma-separated hosts whose masked links keep their label in replies, besides github.com. */
  SLACK_LINK_HOSTS: z.string().optional().default(""),
  /** Follow-ups that may wait behind a busy thread before new ones are refused. */
  SLACK_THREAD_QUEUE_MAX: z.coerce.number().int().nonnegative().default(5),
  /** Earlier thread messages passed to the agent as history. */
  SLACK_THREAD_HISTORY_LIMIT: z.coerce.number().int().nonnegative().default(30),

  /** Offer the builder-crew tools (start, stop, steer and read app builds). Needs repos.yaml. */
  APP_BUILD_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  /** Repository key or owner/name used when a request names none. Empty: the request must name one. */
  APP_BUILD_DEFAULT_REPOSITORY: z.string().optional().default(""),
  /** Fixed ref to dispatch the app-build caller workflow from. Empty: the repository's default branch. */
  APP_BUILD_WORKFLOW_REF: z.string().optional().default(""),

  /** Run the rebuild programme engine and offer its tools. Needs repos.yaml and programme-policy.yaml. */
  PROGRAMME_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  /** Let the engine dispatch build tasks to the reusable workflows. Off: it plans but never dispatches. */
  PROGRAMME_DISPATCH_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  /** Let the engine merge task PRs that pass the auto-merge gate, in autonomous repositories only. */
  PROGRAMME_AUTO_MERGE_ENABLED: z.string().optional().default("false").transform((v) => v === "true"),
  /** Public base URL the build runners fetch briefs from, e.g. https://lexi.example.com. */
  PROGRAMME_PUBLIC_BASE_URL: z.string().optional().default(""),
  /** Channel milestone-review cards and digests post to. */
  PROGRAMME_REVIEW_CHANNEL: z.string().optional().default(""),
  /** Bearer token build runners present to fetch briefs. Empty: every brief route refuses. */
  PROGRAMME_BRIEF_TOKEN: z.string().optional().default(""),
  /** owner/repo of a shared findings repository read during hardening. Optional. */
  PROGRAMME_FINDINGS_REPO: z.string().optional().default(""),
  /** How often the engine advances live programmes, in milliseconds. */
  PROGRAMME_TICK_MS: z.coerce.number().int().positive().default(300_000),

});

/**
 * Cross-field invariants that a per-field schema cannot express.
 *
 * Kept as a function rather than a `.refine()` so `envSchema` stays a ZodObject
 * and `.shape` remains readable — two specs enumerate the shape to check the
 * example env file and the model defaults stay in step with it.
 *
 * Throws, deliberately. These are deployment mistakes that produce quiet
 * double-acting behaviour at runtime, which is far harder to notice than a pod
 * that refuses to start and says why.
 */
export function assertConfigInvariants(cfg: Pick<EnvConfig, "DAILY_AUTOMATION_ENABLED" | "PROGRESS_CHECK_ENABLED">): void {
  // Two staleness ladders exist: WorkflowOrchestrator.runProgressCheck (reached
  // only from the daily sweep) and ProgressCheckService. They anchor on
  // different timestamps — the row's own updatedAt versus last *human* activity
  // — and use different thresholds, so both enabled means every stale subject is
  // notified twice by two ladders that disagree about what stale means. This was
  // documented as a comment on PROGRESS_CHECK_ENABLED and enforced by nothing,
  // and re-enabling the daily sweep is on the roadmap.
  if (cfg.DAILY_AUTOMATION_ENABLED && cfg.PROGRESS_CHECK_ENABLED) {
    throw new Error(
      "Config invariant violated: DAILY_AUTOMATION_ENABLED and PROGRESS_CHECK_ENABLED are mutually exclusive. " +
        "The daily sweep runs its own staleness ladder, so enabling both notifies every stale subject twice. Pick one.",
    );
  }
}

export type EnvConfig = z.infer<typeof envSchema>;
