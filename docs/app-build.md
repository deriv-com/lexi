# app-build

Describe an app in a `BUILD.md`, and a coding agent builds it for you over as
many sessions as it needs. You watch progress on a draft pull request, with a
report and an independent review after every session. Comment on the PR to
steer the builder, and label or close it to stop. With `APP_BUILD_ENABLED` on
the server, you can also start, steer, stop and check on a build from Slack.

A reusable GitHub workflow that lets one coding agent build a whole app on one
branch, session after session, behind a draft pull request a person can watch,
comment on and stop.

| Piece | Where |
|---|---|
| The reusable workflow | [`.github/workflows/app-build.yml`](../.github/workflows/app-build.yml) |
| Its scripts and prompts | [`app-build/`](../app-build/) (checked out from `lexi_repository` at `lexi_ref`) |
| A caller to copy | [`examples/workflows/app-build.yml`](../examples/workflows/app-build.yml) |
| Report parsers, the agent tools and the chat relay | [`packages/app-build`](../packages/app-build/) |
| The local, interactive version | [`apps/build`](../apps/build/README.md) (Lexi·Build) |

## Set up a repository

1. Write `app/web/BUILD.md` (or `app/mobile/BUILD.md`): what to build, from which
   sources, and how. The product repository owns it; the workflow is only the loop.
2. Create a **separate workflow App**, not the App Lexi's server uses, with Contents,
   Pull requests and Issues: read and write, and **no Actions write and no Workflows
   permission** ([the workflow App](#the-workflow-app)). Install it only on the product
   repository and the source repositories the build reads, and store its ID and private
   key as secrets. A `GITHUB_TOKEN` will not do: a pull request it opens triggers no
   workflows.
3. Store a model token as a secret, and set `model_base_url` to an Anthropic-compatible
   endpoint (`https://api.anthropic.com`, or your gateway). The builder is Claude Code.
4. Copy the caller from [`examples/workflows/app-build.yml`](../examples/workflows/app-build.yml).
5. Set the repository variable `LEXI_APP_BUILD_ENABLED` to `true`. Until then every run
   skips its jobs.

Pin `uses:` to a tag or commit SHA, and set `lexi_ref` to the same ref, so the workflow
and the scripts it checks out always match.

## How a run goes

- One run is one **session** of up to three **segments**, with a push between segments
  so the PR preview redeploys while the builder keeps working.
- With `phases: "true"` the build is preceded by intent → spec → plan, recorded in
  `<app>/docs/build/PHASE`. Each planning phase ends at a **gate**: an independent,
  read-only reviewer whose pass is the approval. `gate_mode: advisory` judges each phase
  once and moves on, carrying the findings forward.
- After each session an **assessment** job runs the light checks and an independent
  code review. A separate **report** job, on a fresh GitHub-hosted runner that never runs
  the builder's code, publishes the redacted result to the PR. The next session fixes it
  first, but only an assessment comment posted by the workflow's own GitHub App, for the
  same app and track: marker text in anyone else's comment is ignored.
- PR comments from `feedback_authors` are delivered to the builder in bounded batches;
  a cursor file on the build branch records what was processed. List the logins whose
  comments the builder should act on. `"*"` admits anyone GitHub reports as the
  repository's owner, a member of its organisation or a collaborator, never a
  drive-by commenter. Feedback is read only from the build PR in this repository:
  a PR from a fork, even one on a branch with the same name, is ignored.
- `track` runs several builders on one app at once, each on its own branch and draft PR
  and owning only the folders `BUILD.md` gives it. `fleet_size` lets one builder lead
  sub-agents in separate worktrees inside a session.

The agent never holds an App token or the App private key. It gets the job's read-only
`GITHUB_TOKEN`, to read the PR's comments, and the model token. It commits locally; the
workflow mints a fresh App token for every push, in a step of its own, with only the
permissions that step needs.

### The workflow App

The App needs Contents, Pull requests and Issues: read and write. Checks and Actions:
read are optional; with them the builder also sees the logs of the PR's failing checks.
Never give it Actions write or Workflows. Each token is minted with an explicit
permission set (`PERMISSIONS_JSON`; `gh-token-mint.sh` refuses to mint without one, since
GitHub would otherwise grant everything the installation has):

| Mint (step id) | Used for | Permissions |
|---|---|---|
| `build` → `app`, `assess` → `app` | Fetch the branch, sources and intake issues; read the PR's feedback | contents, issues, pull requests: read (+ checks, actions: read where granted) |
| `build` → `refapp` | Clone the reference repositories | contents: read |
| `build` → `app1`, `app2` | Push between segments, open the draft PR, read the feedback again | contents, pull requests: write; issues: read (+ checks, actions: read where granted) |
| `build` → `app3` | Final push and the session report comment (only the report job publishes images) | contents, pull requests, issues: write |
| `report` → `app` | Report images and the assessment comment (a fresh job; the assess job holds no write token) | contents, pull requests, issues: write |

`chain` dispatches the next session with the job's own `GITHUB_TOKEN` (the caller grants
`actions: write`), never with an App token.

Each segment, and each part of the assessment, ends by stopping every process it
started, however it detached (`agent-sandbox.sh`), putting back the git configuration
and hooks the builder could have changed, and discarding anything it wrote to the
step's `GITHUB_ENV`, `GITHUB_PATH` or `GITHUB_OUTPUT`. The builder tools are sealed
(archived with their digest recorded) before any of the builder's code runs, and every
later step unpacks a verified copy. The saved git configuration is checked against a
digest held in memory before it is put back, and if it changed the segment fails. If a
segment cannot stop everything, the job mints no further token and posts nothing more
to Slack. The limits are in [threat-model.md](threat-model.md).

Every git command that holds an App token (`push.sh`, `report.sh`) runs with a fresh
empty `HOME`, no system or global configuration, hooks and the file-system monitor off,
and a credential helper that answers only for `https://github.com`, so configuration the
builder or a test left behind runs nothing and cannot redirect the token. Report images
are taken by file name from the checks' own screenshot and diff directories, and only
regular PNG files are published; a manifest entry pointing elsewhere is skipped.

Staging credentials are optional. They reach only build-phase segments (the planning
phases never sign in), the push steps and the checks, and every push is refused if a
new commit contains one of their values. While a build-phase segment runs, the builder
can read them; a test account is the right thing to give it.

The Slack webhook never reaches the builder or the gate reviewer: the gate queues its
verdict, and a separate step posts it after the segment has been contained.

The session and assessment logs uploaded as artifacts (the builder's transcripts, the
prompts, the gate and review output, the check logs) are redacted in place before upload
by [`redact-output.mjs`](../app-build/redact-output.mjs): by value for every secret the
builder held, in raw, JSON-escaped and URL-encoded forms, and by shape for GitHub tokens,
model keys, Slack tokens and webhooks, private keys and credentials in URLs. If the
redaction fails, the logs are not uploaded.

## Budget and stopping

Time and spend are bounded by `max_sessions`, `segments`, `segment_minutes`,
`plan_segment_minutes` and `max_gate_attempts`; session reports include what the session cost.
The loop stops when:

- `PROGRESS.md` starts with `Status: done` in the build phase,
- the PR carries the label `app-build:stop` or is closed (checked at session start and
  at every segment boundary),
- `max_sessions` is reached, a phase gate failed `max_gate_attempts` times, or a session
  made no progress at all,
- or someone cancels the run.

## Reading the result

- The workflow output `continue`: `"true"` when the caller should dispatch the next
  session (always `"false"` when `chain: "true"`, because the workflow already did).
- PR comments, each starting with a fixed marker:
  - `<!-- app-build:report -->` followed by
    `<!-- app-build:session app=<app> [track=<track>] session=<n> phase=<phase> -->`:
    the session report.
  - `<!-- app-build:assessment app=<app> [track=<track>] session=<n> -->`: the checks and
    review of that session.
- The builder trusts these markers only in comments GitHub records as posted by the
  workflow's App (`performed_via_github_app`), so the workflow passes `secrets.app_id`
  to `feedback.sh` as `LEXI_APP_ID`. Without it no report or assessment is trusted.
- [`packages/app-build`](../packages/app-build/src/report.ts) parses both, so a chat
  integration can relay them without scraping.

## Driving it from the agent

[`packages/app-build`](../packages/app-build/) gives the agent four tools
(`createAppBuildToolModule`), all backed by `AppBuildService`:

| Tool | Permission | What it does |
|---|---|---|
| `start_app_build` | `app_build.trigger` | Dispatches the caller on an explicit ref (the default branch, or a configured ref) with `app`, `session`, and optionally `max_sessions` and `restart_phase`. Refuses while that app's build is running, on a closed PR, or on a stop-labelled PR unless `resume: true` (which removes the label first). A build whose `PROGRESS.md` says done restarts at the build phase. |
| `stop_app_build` | `app_build.stop` | Labels the build PR `app-build:stop`. |
| `send_app_build_feedback` | `app_build.feedback` | Posts a person's words on the build PR, signed with their name and stripped of HTML comments so it cannot carry a loop marker. |
| `get_app_build_status` | `actions.read` in the server (the library default is none) | PR, phase, session of `max_sessions`, the run in flight, `PROGRESS.md`, what the last session did, the gate verdict, checks, cost, the latest assessment and the questions only a person can answer. |

`AppBuildWatcher` relays each new report and assessment into a chat thread per build PR,
once each. The server does not run it yet, so reports reach Slack only when someone asks
for the status. Dispatches, stops and feedback are recorded in an `AppBuildStore`: in memory
by default, or append-only rows in the `AuditLog` table with `AuditLogAppBuildStore`.

The caller in [`examples/workflows/app-build.yml`](../examples/workflows/app-build.yml)
sets a `run-name` that names the app and the cap, so the tools can tell the web and
mobile builds apart, and accepts `restart_phase`. A caller without `restart_phase`
should be configured with `callerAcceptsRestartPhase: false`.

## Inputs worth knowing

All inputs and secrets are documented in the workflow file. The ones a first caller
usually sets: `app`, `app_label`, `model_base_url`, `model`, `phases`, `max_sessions`,
`segments`, `chain` (with `caller_workflow`), `branch_prefix` (default `lexi/build-`),
`feedback_authors`, and `lexi_ref`. `claude_code_version` and `playwright_mcp_version`
pin the exact tool versions installed (defaults in the workflow file).

## Tests

```bash
bash -n app-build/*.sh
python3 -m unittest discover -s app-build/tests
```

The same checks run in CI on changes under `app-build/` (`app-build-tests.yml`).
