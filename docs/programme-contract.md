# The programme build contract

A rebuild programme lets Lexi rebuild an app milestone by milestone. It turns a
spec and a design into a graph of build tasks, dispatches ready tasks to coding
agents in parallel, checks each one against the test evidence it posts back,
merges what passes when you allow auto-merge, and asks a person to approve
each milestone in Slack. This page is for the repository that hosts the
rebuild: what its workflows receive, what they must send back, and what stays
stable between releases. To switch the programme on in the server, see
[getting started](getting-started.md#the-rebuild-programme).

The wire contract between the orchestrator and the reusable programme
workflows in `.github/workflows/`: `programme-build.yml` (one build task),
`programme-explore.yml` (the exploratory sweep of a preview),
`programme-verify-web.yml` (post-merge e2e and accessibility against a
preview) and `programme-feature-intake.yml` (one feature of a live product
into one implementation issue). A rebuild repository carries a thin caller
(see `examples/workflows/programme-*.yml`) and delegates everything to these
workflows, pinned by ref.

## Versioning promise

- Rebuild repositories call `.github/workflows/programme-build.yml` of this
  repository (github.com/deriv-com/lexi) at a pinned ref and pass the same
  ref as `lexi_ref`, so the composite actions in `actions/`
  come from the same revision as the workflow.
- The brief, result and evidence shapes are versioned: any change to the brief
  schema, the result schema, the evidence fields these workflows emit, or the
  dispatch input set ships as a new release, and callers migrate by changing
  one line. Behavioural fixes that keep every shape identical may land in an
  existing release.
- The schemas in `schemas/` are the normative wire shapes; the TypeScript
  sources of truth are `packages/contracts/src/programme.ts` and
  `packages/contracts/src/run-evidence.ts`. If they disagree, the contracts
  package wins and the schema gets a fix.

## Inputs and secrets the caller provides

| Name | Kind | Used for |
|---|---|---|
| `enabled` | input | Kill switch. Callers normally pass a repository variable such as `PROGRAMME_BUILD_ENABLED`. Off skips every job. |
| `orchestrator_url` | input | Base URL evidence is POSTed to (`<orchestrator_url>/api/evidence`). |
| `model_base_url` | input | Model gateway URL (`ANTHROPIC_BASE_URL`). |
| `default_model` | input | Model used when the brief names none. |
| `branch_prefix` | input | Task branches are `<branch_prefix><task>`; must match the orchestrator. Default `lexi/`. |
| `lexi_repository`, `lexi_ref` | input | Where the composite actions come from. The publishing job re-checks-out the exact commit the build job used and refuses to run if it differs. |
| `claude_code_version` | input | Exact Claude Code CLI version installed on the runner (`programme-build.yml`, `programme-explore.yml`). Pinned by default; override to move. |
| `app_id`, `app_private_key` | secret | The builder GitHub App: pushes and pull requests (minted in the `publish` job with `contents: write` and `pull_requests: write` only), and the optional UI-source read token (minted before any agent phase, `contents: read`, one repository, revoked after the clone). |
| `model_api_key` | secret | Sent to the gateway as `ANTHROPIC_AUTH_TOKEN`. |
| `brief_token` | secret | Bearer for the brief and every document it references. |
| `evidence_token` | secret | Bearer for evidence POSTs. |
| `access_client_id`, `access_client_secret` | secret | Optional service token when the orchestrator sits behind an identity-aware proxy. |

`brief_url` (a dispatch input, not a caller setting) must be **exactly**
`<orchestrator_url>/api/programme/briefs/<attempt_id>`, with `attempt_id`
matching `^[A-Za-z0-9_-]{1,100}$` and `orchestrator_url` an `https://` URL
with no query, fragment or credentials. Anything else is refused before the
brief token or the access-proxy secret is sent. Every document the brief
references (`parityInventory.url`, `apiContract.url`, `designContext.url`,
`apiReferences[n].url`) must be under `<orchestrator_url>/api/programme/`;
one that is not is never fetched with the token.

## The dispatch + evidence handshake

`programme-build.yml` runs three jobs. `gate` validates the dispatch.
`build` runs the agent and holds only what the agent may have: the model key,
and the brief token (used before the first agent phase). `publish` holds the
evidence token, the access-proxy secret and the App private key, runs on a
fresh runner, and never executes the agent or anything it wrote. It receives
only data from `build`: job outputs set before the agent started, and a
`programme-handoff` artifact (a git bundle of the task's commits, each
phase's evidence inputs, and the run state), which it validates field by
field before acting on it.

Every artifact `build` uploads (the hand-off's JSON files and the drafted
technical spec) is redacted in place first by
[`redact-output.mjs`](../app-build/redact-output.mjs), from a copy sealed
before the first agent phase: by value for the model key, by shape for GitHub
tokens, model keys, Slack tokens and webhooks, private keys and credentials in
URLs. If redaction fails, that upload is skipped and `publish` works from the
hand-off before it, if any, or reports that nothing was handed off. The git bundle is not redacted; it holds the
commits, which `publish` pushes anyway. `programme-explore.yml` and
`programme-feature-intake.yml` redact their agent job's screenshots, hand-off
and logs the same way (a screenshot that holds a credential is deleted).

```
orchestrator              build job (agent)          publish job (no agent)     orchestrator
     |                           |                            |                      |
     |-- workflow_dispatch ----->|                            |                      |
     |   {attempt_id,            |                            |                      |
     |    build_task_id,         |                            |                      |
     |    brief_url, workdir?}   |                            |                      |
     |                           |-- GET brief_url ---------------------------------->|
     |                           |   Bearer brief_token (only to                     |
     |                           |   <orchestrator_url>/api/programme/...)            |
     |                           |<- BuildTaskBrief (v1) -----------------------------|
     |                           |   validate + quarantine    |                      |
     |                           |                            |                      |
     |                           |   RED: failing tests bound |                      |
     |                           |   to acceptanceCriteria ids|                      |
     |                           |   -> hand-off uploaded     |                      |
     |                           |   GREEN: implement until   |                      |
     |                           |   red tests pass           |                      |
     |                           |   checks: types, lint,     |                      |
     |                           |   unit, build              |                      |
     |                           |   -> final hand-off        |                      |
     |                           |   (bundle + evidence       |                      |
     |                           |    inputs + state)         |                      |
     |                           |--------------------------->|                      |
     |                           |                            |-- POST /api/evidence (red, green, checks)
     |                           |                            |   Bearer evidence_token ---------->|
     |                           |                            |   mint App token; push            |
     |                           |                            |   <prefix><task>; open PR,        |
     |                           |                            |   request auto-merge (squash)     |
     |                           |                            |   upload programme-evidence,      |
     |                           |                            |   programme-result                |
     |<-- deterministic merge executor reads evidence + verdicts -------------------------------->|
```

Because the bundles are posted by `publish`, they arrive when `build` ends,
not phase by phase. RED is not lost if `build` stops early: the hand-off is
uploaded straight after RED, and `publish` runs on any outcome, posts what
the hand-off proves, and preserves the branch.

Rules the handshake depends on:

- `attemptId` is echoed from the dispatch input onto **every** bundle. It is
  a correlation key, never authority — the bearer token is the authority.
- Every bundle names the posting repository (`repository`, from
  `GITHUB_REPOSITORY`). The orchestrator refuses (403) a bundle whose
  `repository` is missing, malformed, or not the attempt's repository
  (case-insensitive). This **binds** evidence to the attempt; it does not
  authenticate the sender. `evidence_token` is one secret shared by every
  rebuild repository and the claim is self-asserted, so a holder of the token
  can still post evidence for any attempt by naming that attempt's
  repository. Per-repository tokens or OIDC would close that; neither is in
  place.
- Red must be received **before** the first green (the orchestrator checks
  receive order, not sender timestamps). A red bundle with no failing tests
  is a contradiction the orchestrator surfaces.
- Evidence POSTs are best-effort (3 retries, warn on non-2xx). The
  `programme-evidence` artifact is the fallback read path and is enforced at
  *.json files, ≤512KB each, ≤50 files, ≤10MB zip.
- `checks` bundle check names are exactly `types`, `lint`, `unit`, `build` —
  the same names `programme-policy.yaml` requires and the same names
  the rebuild repos' `ci.yml` jobs carry, so branch protection and the
  auto-merge gate see one vocabulary. The bundle carries one additional,
  informational check, `token-usage` (below); it is never a required check.
- The evidence `commitSha` must equal the PR head SHA for the auto-merge
  gate to pass (`requireHeadShaMatch`).

## `uiSource` — an intent reference

Every other brief input is a document the orchestrator serves. `uiSource` is a
**git repository the runner checks out itself**, because a React app is
thousands of files plus assets and no JSON snapshot carries its components,
CSS, layout logic and responsive behaviour faithfully.

```
uiSource: { repoSlug: "acme/web-prototype", ref: "main", paths?: ["src","public"] }
```

The orchestrator ([`packages/programme`](../packages/programme)) treats it as
a reference for **intent and flow**, not code to copy. The programme's tracking
issue lists it as "intent reference only — rebuild, do not port"; the agent's
`start_app_rebuild` tool tells the model not to port components verbatim and to
rebuild the UI to WCAG 2.2 AA; planning uses its routes as the screen
inventory. Rebuilds are judged against the spec and the prototype's intent, not
against the prototype's code.

The build workflow does not say the same yet. The prompt in
[`programme-build.yml`](../.github/workflows/programme-build.yml) still tells
the agent to port the UI from the checkout, invent no UI it lacks, and report
what it ported. Until the two agree, expect build agents to reuse code from the
checkout. Whichever way the agent works, its output is held to WCAG 2.2 AA and
production quality (typed, no mock data or prototype-only shortcuts,
loading/empty/error states, tests), and its summary names what it took from
the source, what it changed to meet that bar, how it verified accessibility,
and what it could not close.

Mechanics:

- Checked out to **`.lexi/ui-source/`** at the repository root. Workspace-
  relative so the shared prompt prefix stays byte-stable across a programme's
  tasks; an absolute `$RUNNER_TEMP` path there would miss the cache every run.
- **Structurally uncommittable.** The step appends `/.lexi/ui-source/` to
  `.git/info/exclude`, so `git add -A` cannot see it. The commit steps already
  strip `.lexi/brief` with an explicit `git reset`; relying on a second reset
  would leave thousands of cloned files one forgotten line from shipping in
  the PR. `.git/info/exclude` is local to the checkout, so nothing is added to
  the repository to make that true.
- Read-only by construction — a **different** repository from the one the task
  commits to.
- Its own **short-lived App token**, scoped to that one repo with
  `contents: read`. The run's default `GITHUB_TOKEN` is scoped to the calling
  repository and cannot read another. It is minted by `actions/app-token`
  (no post step, so the App private key never reappears in the agent's job)
  before any agent phase, and revoked after the clone. The push token is
  minted in the separate `publish` job.
- `ref` is verbatim. `--depth 1 --branch` handles a branch or tag and rejects a
  raw sha, so a pinned ref falls through to a blobless clone plus checkout. A
  branch is convenient and **not reproducible** — two attempts of one task can
  see different source and the evidence will not say so. Pin a sha in
  `programme-policy.yaml uiSources` when that matters.

**Three ways this fails the run rather than degrading**, all for one reason:
a run that silently lost the reference it was given would spend a full run of
tokens building without it.

| Failure | Message names |
|---|---|
| Token could not be minted | Install the App on that repo with `contents:read` |
| Clone or ref checkout failed | The ref may not exist, or the App is not installed |
| Checkout is empty | An empty source is indistinguishable from no source, so the agent would invent the UI |

When `uiSource` is absent the design context is the UI source, exactly as
before. It is deliberately absent for **mobile**: a React prototype cannot be
reused by a Flutter build, and whether that conversion is possible is an open
question — a brief claiming otherwise would be inventing a capability.

When it is present, the design-context line changes meaning: it becomes a
cross-check on what the source already does, not a second source to build
from.

## `workdir` — one repo holding more than one app

`workdir` is an optional dispatch input naming the repository-relative
directory that holds the app a task builds. It defaults to `""`, meaning the
repository root, which is every caller that existed before it: their runs are
byte-for-byte unaffected.

It exists for a repository that carries **two** apps — say `web/` and
`mobile/` — because platform detection in this workflow tests for a manifest
(`pubspec.yaml`, `package.json`) at the path it is given. Dispatched with no
workdir against such a repo, the root holds neither, so all four required
checks would record as `skipped — skeleton repo` and the auto-merge gate
would be satisfied by a run that compiled nothing. The input is what makes
detection look in the right place; a value naming a directory that does not
exist **fails the run** rather than degrading to that silent skip.

What it moves, and what it deliberately does not:

| Resolved inside `workdir` | Stays at the repository root |
|---|---|
| `<workdir>/.lexi/repo.json` — `platform` and `previewUrl` differ per app, so the manifest is per-folder (falling back to a root manifest, so a single-app repo is unchanged) | `.lexi/brief/` — this task's inputs. Keeping one path keeps the shared prompt prefix cacheable, and the commit steps already strip it from the PR |
| `<workdir>/.lexi/testids.json`, `<workdir>/.lexi/ac-bindings.json` — named to the agent at these paths in both phases | `$RUNNER_TEMP/evidence/`, `$RUNNER_TEMP/result/` — the artifacts are written outside the checkout, so their paths never needed changing |
| The GREEN verification run and every `checks` command, executed from inside the directory | The task branch (`<branch_prefix><task_id>`), the PR, and the evidence `commitSha` — one repo, one branch namespace |

The agent is told the directory explicitly, in the cacheable prompt prefix
both phases share, along with the instruction that sibling app directories
are off limits. Non-empty `workdir` is echoed onto `result.json` so a
consumer reading only the artifact can still tell which app a run built; it
is absent for a root build.

`workdir` scopes where a task builds. It is **not** an isolation boundary —
the agent runs with `--dangerously-skip-permissions` over one checkout, so
the prompt is a convention, not a sandbox. Two apps that must not be able to
touch each other belong in two repositories.

## Brief fields beyond the core (briefVersion 1)

`schemas/programme-build-brief.schema.json` is normative and mirrors
`BuildTaskBrief` in the orchestrator's `packages/contracts/src/programme.ts`
exactly — a brief the schema rejects is a brief the runner refuses.

Required alongside the original core fields:

| Field | Meaning |
|---|---|
| `attempt` (integer ≥ 1) | 1-based attempt ordinal for this build task; `dispatch.maxTaskAttempts` bounds it. |
| `taskKind` | One of `scaffold`, `design-bindings`, `data-layer`, `screen`, `integration`, `e2e`. |

Optional, and what the runner does with each:

| Field | What the runner does with it |
|---|---|
| `model` (string) | Model for BOTH Claude Code phases (and the exploratory sweep). Resolution: `brief.model` if non-empty, else the `default_model` input. The chosen model is logged and recorded in `token-usage`; the token never is. |
| `apiContract {documentId, url, title, version, operationCount, baseUrl?, fixtureOnlyPaths?}` | `url` is fetched with bearer `brief_token` into `$RUNNER_TEMP/brief/api-contract.json` before RED. The prompts tell the agent to implement ONLY against endpoints in that document and never invent an endpoint. When `baseUrl` (https) is present it is exported to both phases as `LEXI_API_BASE_URL` and the prompt states that it is a staging host and that the agent must authenticate only with the test-account credentials the repository provides and never hard-code one. When `fixtureOnlyPaths` is non-empty the prompt lists them as fixture-only — untestable with a test account, to be implemented behind typed fixtures and never called live. |
| `designContext {documentId, url, nodeIds}` | `url` fetched into `$RUNNER_TEMP/brief/design-context.json`. Screens, copy and selectors are rendered from it (plus `.lexi/testids.json`); inventing either is forbidden. |
| `parityInventory {documentId, url, referenceRepoSlug, routeCount, featureCount}` | `url` fetched into `$RUNNER_TEMP/brief/parity.json`. The inventory of `referenceRepoSlug` is a **floor**: every route/feature it lists must exist in the rebuild — match or exceed, never fewer. `programme-explore.yml` asserts every entry is reachable in the preview. |

A fetch failure is a **warning, not a run failure**. The prompt then states
that input is unavailable and forbids guessing in its place — in particular
**no backend calls without the contract** (stub behind fixtures, record the
gap) and no invented copy/selectors without the design context.

Test-account secrets are the caller's; this workflow neither names nor logs
them. It exports only `LEXI_API_BASE_URL`.

## The `token-usage` check

Both phases run `claude -p --output-format json`; the usage fields of each
result are read with defaults (`// 0`, cost `null` when absent) so a missing
field never fails a run. The `checks` bundle then carries one extra check:

```json
{ "name": "token-usage", "status": "passed", "detail": "<JSON string>" }
```

where `detail` parses to

```json
{
  "model": "claude-sonnet-5",
  "phases": [
    { "phase": "red",   "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "costUsd": null },
    { "phase": "green", "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "costUsd": null }
  ]
}
```

`inputTokens` ← `usage.input_tokens`, `outputTokens` ← `usage.output_tokens`,
`cacheReadTokens` ← `usage.cache_read_input_tokens`, `cacheWriteTokens` ←
`usage.cache_creation_input_tokens`, `costUsd` ← `total_cost_usd` (number or
`null`). `programme-explore.yml` emits the same check with a single phase named
`sweep`. `status` is always `passed`; the check is telemetry, not a gate.

## The exploratory sweep (`programme-explore.yml`)

Inputs: `attempt_id` (required), `preview_url` (required, https, no
credentials), `commit_sha` (required — the head SHA the sweep is judging),
`brief_url` (optional — supplies `model` and `parityInventory.url`; when set
it is bound exactly as in `programme-build.yml`), `preview_allowed_hosts`
(optional — see below), and the pinned tool versions `claude_code_version`,
`playwright_version`, `axe_core_version`. Secrets: `model_api_key`,
`evidence_token`, `brief_token`, `turnstile_bypass_user_agent` (optional).

Two jobs. `explore` runs the agent with `contents: read`, the model key and
(when bound) the brief token; it hands its raw findings, coverage and output
to `report` as the `sweep-handoff` artifact. `report` runs on a fresh runner,
re-checks-out the Lexi actions at the commit `explore` used, files the
issues and posts the evidence. A sweep whose `explore` job did not finish is
reported failed.

**The turnstile bypass.** The bypass user agent is sent only when
`preview_url`'s host is in `preview_allowed_hosts` (comma- or space-separated;
`*.example.com` matches subdomains, not the apex). Otherwise the sweep runs
without it. When it is used, the value is written to a 0600 file outside the
checkout, never into the agent's environment or prompt, and the provided
`applyBypass(page)` helper presents it only on requests to the preview's own
origin. The agent runs as the same user, so it can still read that file; the
allowlist, not the file, is what keeps the value off other hosts.

The sweep is Claude Code + Playwright + axe-core driving the preview against
an explicit adversarial checklist: every route/screen at viewports 375 and
1440, form validation, empty/loading/error states, back/forward navigation,
keyboard-only navigation, console errors, failed network calls, a11y
violations, broken links, and — when the parity inventory is available —
reachability of every inventoried feature. Each finding becomes one GitHub
issue labelled with the `findings_label` input in the **calling** repo (repro steps + screenshot
path; screenshots are the `sweep-screenshots` artifact), capped at 50 per run.

Evidence bundle: `phase: "checks"`, `commitSha: <commit_sha input>`,

```json
"checks": [
  { "name": "exploratory-sweep", "status": "passed" | "failed",
    "detail": "<n> findings: #123 title; #124 title" },
  { "name": "token-usage", "status": "passed", "detail": "<JSON string>" }
],
"artifacts": [ { "type": "report", "uri": "<sweep-report artifact url>", "label": "sweep-report.json" } ]
```

`exploratory-sweep` passes **only** when findings == 0 **and** the agent
actually ran. A sweep that could not run (no model credentials, agent crash
or timeout, no findings file) is reported `failed` with the reason appended
to `detail` — an un-run sweep must never read as a clean one.

The orchestrator takes `preview_url` from the rebuild repo's
`.lexi/repo.json` `previewUrl` (a stable preview environment tracking
`main`) and refuses to sweep while it is empty. In a
repo carrying more than one app the manifest is **per app** —
`<workdir>/.lexi/repo.json` — because two apps deploy to two preview URLs;
a single root manifest would point every sweep at whichever one was written
there.

## Post-merge verification (`programme-verify-web.yml`)

Two jobs. `verify` checks out the merged code, runs its Playwright suite and
`@axe-core/cli` (exact version from the `axe_core_version` input) against
`preview_url`, and holds no secrets. `report` re-validates the checks it was
handed (a `verify` job that did not finish reads as errored), checks out the
Lexi actions at `lexi_ref`, and posts the evidence. The repository's own code
never runs where `evidence_token` is.

## Supply chain

Every third-party action in the programme workflows is pinned to a full
commit SHA with its tag in a comment. Claude Code, Playwright and
`@axe-core/cli` are installed at exact versions, each overridable by an input
(`claude_code_version`, `playwright_version`, `axe_core_version`).
`programme-feature-intake.yml` installs Claude Code through the app-build
tooling, which does not pin it yet.

## Ruleset prerequisites (org admins, before first dispatch)

Sequenced; the enable variable comes **last**:

1. Create a builder GitHub App (contents: write, pull requests: write) and
   install it **only** on the rebuild repositories (plus any UI-source
   repository it must read, with contents: read). Every token is minted with
   an explicit permission set: the push token asks for contents and pull
   requests write, the UI-source token for contents read; `actions/app-token`
   refuses to mint without one. `programme-feature-intake.yml` files issues
   with contents and issues write, and `rebase-branch.yml` pushes with
   contents write only (so it cannot push a branch whose commits change
   `.github/workflows/`).
2. Provision the secrets above on the rebuild repositories (or the org,
   scoped) and fill in the caller's `orchestrator_url` and `model_base_url`.
3. Rulesets on every rebuild repository:
   - **No direct push to the default branch** — for everyone, including the
     App. `contents: write` cannot express "except main"; only a ruleset can.
   - **A push ruleset on `<branch_prefix>*`** — the builder App may create and
     update only those refs. Branch naming is otherwise enforced only by the
     workflow, which is not an enforcement control.
   - **Required checks on the default branch**: `types`, `lint`, `unit`,
     `build`, plus a conformance status the ORCHESTRATOR posts from a
     **different App credential** than the one that pushes, which is what
     double-gates auto-merge.
4. Only after all of the above: set the caller's enable variable (for example
   `PROGRAMME_BUILD_ENABLED=true`). Every job is skipped until then.

## Handback semantics

An agent failure, a refused brief (quarantine or validation), or tests still
red after GREEN never fail the run: the run finishes green with
`result.json.status = "handback"` and a `handbackReason`. A run that fails
outright (missing credentials, infrastructure) reports `status = "failed"`.
The orchestrator treats HANDBACK/FAILED → READY retries as legal only under
`dispatch.maxTaskAttempts`.


## Working-branch programmes, the technical spec and memory

Four optional brief fields and one workflow input, all backward compatible:
a brief without them and a caller without the input behave exactly as before.

- **`base_branch` (workflow input)** — the branch the task PR targets and the
  run was dispatched against. The orchestrator sends it only for programmes
  whose `programme-policy.yaml programmes.repoSettings.<key>.baseBranch` is
  set, because a caller that does not declare the input would refuse the
  dispatch. When set, `programme-build.yml` does NOT enable GitHub auto-merge on the
  PR: a working branch has no required checks, so `--auto` would merge on the
  spot and bypass the orchestrator's evidence gate. The orchestrator's merge
  executor lands it. `brief.baseBranch` carries the same value for the prompt.
- **`brief.taskKind == "technical-spec"`** — a document, not code. The
  workflow runs ONE `DRAFT` phase: the agent writes `brief.technicalSpec.path`
  with exactly `brief.technicalSpec.sections` as level-2 headings (a missing
  heading is a handback, not a warning), appends to the build log, and the PR
  is opened WITHOUT auto-merge and with a body that says merging it is the
  approval. No RED/GREEN/checks run and no evidence is posted, so the
  orchestrator's gate can never pass it — a person merges. The orchestrator
  folds the merge and re-assigns criteria to screen tasks from the document's
  `## Acceptance criteria by screen` table (`| Screen | Criteria |`).
- **`brief.technicalSpec`** on every OTHER task — read from the checkout,
  never fetched: it was merged into the working branch. Present in the prompt
  as the architecture to build to; absent from the checkout is a stated
  refusal in the prompt, not a guess.
- **`brief.priorLearnings`** — the orchestrator's memory for the task, written by the
  brief action to its own file (`prior-learnings.md`) and named in the prompt
  as ADVISORY. It is never concatenated with the trusted instruction and never
  written to `GITHUB_OUTPUT`.
- **`brief.buildLogPath`** — the append-only log in the rebuild repo the agent
  reads first and appends to in the same PR; the repository is the memory the
  runner can see without the orchestrator.
- **`brief.trackingIssue`** — cited in PR bodies as `Programme: <url>`.

`result.json` gains an optional `taskKind` so a reader can tell a drafted
specification from a shipped build.

### What `publish` requires before it opens a pull request

The run state in the hand-off (`pending`, `handback` or `drafted`) and the
evidence files beside it were written by the job that ran the agent and the
repository's own commands, so `publish` treats them as claims to check, not
as a verdict:

- **The task kind is the brief's**, read by `build` before the first agent
  phase and passed as a job output. The `taskKind` in the hand-off is never
  read.
- **`drafted` is accepted for `technical-spec` only.** `drafted` means no RED,
  GREEN or checks ran. On any other kind the hand-off writer turns it into a
  hand-back and `publish` refuses it: no pull request, no GREEN or checks
  bundle posted, the branch preserved, `result.json` `failed`. A
  `technical-spec` run that ends `pending` is refused the same way.
- **A code task needs all three phases, bound to the pushed commit.** RED
  evidence on a commit the pushed head descends from; GREEN and checks evidence
  whose `sha` is the pushed head; and a checks bundle that names `types`,
  `lint`, `unit` and `build` (run or skipped). Anything missing or bound to
  another commit is refused as above, with the gap named in `handbackReason`.
- **`result.json` `status` is `shipped`, `handback` or `failed`.** `drafted`
  is never a result; the orchestrator discards a payload that carries it, and
  decides whether a task is a document from its own record, not from
  `taskKind` in the result.

Inside `build`, every step that runs the agent or the repository's commands
(DRAFT, RED, GREEN, the test run and the checks) ends by stopping what they
left running and emptying `GITHUB_ENV`, `GITHUB_PATH` and `GITHUB_OUTPUT`
(`agent-sandbox.sh`, from a copy sealed before the first phase), and writes
its own state and outputs only after that. The steps that compute the run
state and the evidence call `jq` and `git` from the system directories
(`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`), so a runner
must have both installed there.

What this does not prove: that the tests and checks were run honestly. They
run in the same job as the agent, as the same user, and on a GitHub-hosted
runner that user has `sudo`; an agent that sets out to forge `green.json` and
`checks.json` for its own commit can still do so. The evidence is bound to the
commit, not to a trusted execution of it. Require checks from a workflow the
agent's job cannot influence (branch protection on the base branch, or a
separate verification run on the pushed head) before treating a merge as
verified.


## A phase's work outlives its verdict

A hand-back must not throw away finished work. The rules
`programme-build.yml` enforces:

- **The task branch is resumed, not recreated.** `Derive task branch` checks
  out `<branch_prefix><task>` from the remote when it exists and merges the dispatch ref
  into it (falling back to a clean base only if that conflicts). A retry
  therefore continues the previous attempt instead of paying for it again, and
  the phase prompt tells the agent to revise the document in place.
- **A hand-back still pushes the branch.** The `publish` job's `Preserve the
  branch on a hand-back or a failed phase` step pushes the hand-off bundle's
  head to `<branch_prefix><task>` with no pull request, so no gate is touched
  and the orchestrator still reads a hand-back — but the work is on GitHub for
  the next attempt and for a person to read. It is skipped when nothing was
  committed.
- **The artifact is written before any gate.** The drafted document is copied
  to `programme-drafted-technical-spec` as soon as it exists, not after it passes.
- **A phase produced something exactly when the branch moved.** Never when the
  index is dirty: an agent that commits its own work leaves a clean index, and
  that read as "no changes" and discarded the commit.
- **The agent does not run git.** The prompt says to leave changes in the
  working tree; the workflow owns every commit, push and pull request.
