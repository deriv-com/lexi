# Threat model

This is written for a security review of Lexi as it exists in this
repository. For each threat it names the mitigation that exists in code, with
the file, and then the risk that remains. Where something is not mitigated, or
is built but not wired into the server, it says so. The [known gaps](#known-gaps)
section collects those in one place.

Read [architecture.md](architecture.md) for the request paths,
[governance-model.md](governance-model.md) for the controls in detail, and the
[capability matrix](capability-matrix.md) for every tool the agent can call and
the permission it requires.

## Scope

In scope:

- `apps/server`: the Slack surface, the agent runtime and its tools, the HTTP
  API, and the rebuild programme when it is switched on.
- The reusable workflows in `.github/workflows/` (`agent-fix`, `rebase-branch`,
  `app-build`, `programme-*`) and the scripts they check out.
- The example configuration in `examples/`.

Out of scope: `apps/build` (Lexi·Build), a local tool that runs agent CLIs on
the operator's own machine. Its bridge listens on loopback, refuses any request
whose `Host` is not loopback on its port (DNS rebinding), and checks the
`Origin` of browser WebSocket upgrades ([`apps/build/bridge/guards.mjs`](../apps/build/bridge/guards.mjs));
anything that can reach it runs agents with full tool access in its workspace.

## Assets

| Asset | Where it lives |
|---|---|
| Server GitHub App private key and installation tokens (holds Actions: write) | Server environment (`GITHUB_APP_PRIVATE_KEY`). |
| Workflow GitHub App private key (a separate App, no Actions: write) | Repository secrets in the target repositories (`LEXI_APP_PRIVATE_KEY`). Assume a workflow agent can read it. |
| Slack bot and app-level tokens | Server environment. |
| Model API keys | Server environment; repository secrets for the workflows. |
| `PROCESS_API_TOKEN` | Server environment and whatever scheduler calls the API. |
| `PROGRAMME_BRIEF_TOKEN`, `EVIDENCE_WEBHOOK_TOKEN` | Server environment; repository secrets (`brief_token`, `evidence_token`) for the programme workflows. |
| Source code, issues, PRs, Actions logs and artifacts | GitHub, reachable through the App installation. |
| Slack thread content | Slack; read per turn and sent to the model provider. |
| Issue workflow state, decisions, notifications, audit rows | Postgres (`DATABASE_URL`). |
| Memory: personal preferences and team conventions people taught the agent | Postgres, when `memory-policy.yaml` enables memory. |
| Programme state, briefs, design and API documents, run evidence | Postgres, when the programme is on. |
| The integrity of default branches and release pipelines | GitHub. |

## Actors

- **Slack users.** Anyone who can post in a channel the bot is in, or send it a
  direct message. That includes guests, and people from other organisations in
  a Slack Connect channel the bot has joined. With the example policy, only
  people listed in `authorization.yaml` can use governed tools, reads
  included, and anyone else is refused before the model runs.
- **The model.** Chooses tools and arguments. Treated as untrusted: it can be
  wrong, and it can be steered by text it reads.
- **Authors of content the agent reads.** Anyone who can write an issue, a PR, a
  comment, a file, a commit message or a CI log line in a reachable repository,
  or a message in the thread. This is a much wider group than Slack users.
- **Coding agents in the workflows.** Run headlessly with tool permissions
  skipped, inside a GitHub Actions job, with a write token.
- **HTTP callers.** Anyone who can reach the server's port. With
  `PROCESS_API_TOKEN` they can run the issue workflow; with the programme tokens
  they can read briefs and documents and submit evidence.
- **Programme build runners.** Workflow jobs that fetch briefs from the server
  and POST evidence back. Their evidence decides whether a task PR may be
  auto-merged.
- **Operators.** Hold the environment, the policy files and the GitHub App.
  Trusted.

## Trust boundaries

1. **Slack → server.** Events and review-card button clicks arrive over
   Socket Mode, on a connection the server opens with the app-level token.
   There is no inbound webhook. The acting person is the event's `user` field,
   or the clicking user for a button.
2. **Server → model provider.** The system prompt, the thread history, the
   message and every tool result leave the server.
3. **Model → tools.** Every tool call crosses the `ToolRegistry`, which looks
   the tool up, authorizes the asking person, and dispatches.
4. **Tools → GitHub and Slack.** Writes cross `GitHubMutationGateway` or
   `SlackMutationGateway`, which enforce the write switches.
5. **Server → workflows.** `dispatch_agent_fix` and `rebase_branch` send
   `workflow_dispatch` inputs to a caller workflow in the target repository.
   From there on, the server has no control; the workflow holds its own
   credentials.
6. **Workflow → agent.** Inside the job, the agent can run any command as the
   runner user.
7. **HTTP → server.** `POST /process`, `/reprocess`, `/retest` behind a shared
   bearer token; the programme's `/api/programme/*` reads behind
   `PROGRAMME_BRIEF_TOKEN` and `POST /api/evidence` behind
   `EVIDENCE_WEBHOOK_TOKEN`. `/health`, `/health/ready` and `/metrics` are open.
8. **Server → database.** Prisma over `DATABASE_URL`.

Untrusted input, everywhere it enters: issue and PR text and comments, file
contents, workflow logs and artifacts, Slack thread history (including other
people's messages), remembered team conventions, dispatch inputs, evidence
bodies, and HTTP request bodies.

## Threats

### Prompt injection through issue, PR, file, log or thread text

An attacker writes instructions into something the agent will read: an issue
body, a code comment, a CI log line, or an earlier message in the thread.

Mitigations in code:

- **Identity cannot be injected.** The actor is the Slack event's `user`,
  carried in `ToolCallContext.actorId`; tools never take a user argument.
  History authors are shown to the model for context only
  ([`slack-thread-history.ts`](../apps/server/src/slack/slack-thread-history.ts),
  [`agent-runtime.ts`](../packages/agent/src/runtime/agent-runtime.ts)).
- **Authorization is per person, per call.** Injected text can only make the
  agent do what the person who asked is already allowed to do
  ([`tool-registry.ts`](../packages/agent/src/tools/tool-registry.ts)).
- **Targets are bounded.** Repositories resolve through `RepoScope`; channel
  posts go only to the conversation's channel or an allowlist; broadcast
  mentions are refused; merges re-check state and refuse the default branch;
  release, production and publish workflows cannot be dispatched
  ([`repo-scope.ts`](../packages/agent-tools/src/shared/repo-scope.ts),
  [`slack-module.ts`](../packages/agent-tools/src/slack/slack-module.ts),
  [`github-write-module.ts`](../packages/agent-tools/src/github/github-write-module.ts),
  [`protected-workflows.ts`](../packages/github/src/protected-workflows.ts)).
- **The write switch** stops every governed write when off, whatever the model
  was told.
- **The prompt says so.** The default system prompt tells the model that tool
  output, files, tickets and chat messages are data, not instructions
  ([`default-system-prompt.ts`](../packages/agent/src/prompt/default-system-prompt.ts)).
  `get_thread_context` says the same in its description.
- **In agent-fix**, the brief is written to a file and the agent is told it is
  a symptom, not a specification; the push guards and token scope bound what
  it can change ([`agent-fix.yml`](../.github/workflows/agent-fix.yml)).

Residual risk:

- This is a confused-deputy problem, and the mitigations bound it rather than
  remove it. When an engineer asks the agent to look at an issue, injected text
  in that issue can lead it to comment, close an issue, open or merge a PR into
  a non-default branch, or dispatch agent-fix with a brief of the attacker's
  choosing, all as that engineer. There is no confirmation step before a write.
- Content is not isolated or sanitised before it reaches the model. A module
  for that exists (`packages/governance/src/platform/prompt-isolation.ts`) but
  the agent path does not use it. The defence is the prompt instruction plus
  the controls above.
- Injection can exfiltrate: the agent can be led to quote private code or
  issues into the thread, or into a comment on another repository in scope.
  Replies are posted with link and media unfurls off, broadcast and user-group
  mentions are turned into plain text, and a masked link keeps its label only
  for github.com and `SLACK_LINK_HOSTS`, so a reply cannot page a channel or
  disguise where a link goes
  ([`slack-mrkdwn.ts`](../apps/server/src/slack/slack-mrkdwn.ts)); a plain URL
  is still clickable.
- Anyone in a thread can add a message that becomes history for the next
  person's turn.
- Anyone with `memory.remember` (the example grants it to `viewer`) can store a
  team convention that the agent recalls in other people's turns. Memory is
  advisory and attributed, and never authorizes an action, but its text
  reaches the model like any other content. Removing conventions needs the
  separate `memory.forget_team` (the example grants it to `team_lead`), so a
  viewer cannot clear them all.

### Identity spoofing

Mitigations in code:

- Socket Mode means no inbound endpoint to forge events against; the connection
  is authenticated with the app-level token
  ([`slack-surface.ts`](../apps/server/src/slack/slack-surface.ts)).
- The handler ignores events without a human `user`, events with a `bot_id`,
  and the bot's own messages, so another bot or integration cannot drive it
  ([`slack-conversation.handler.ts`](../apps/server/src/slack/slack-conversation.handler.ts)).
- `authorization.yaml` is keyed by Slack user ID, not display name; unknown IDs
  are denied every governed action
  ([`authorization.service.ts`](../packages/governance/src/authorization/authorization.service.ts)).

Residual risk:

- A compromised Slack account has that person's permissions.
- The HTTP API has no per-caller identity: anyone with `PROCESS_API_TOKEN` is
  the same caller, and its requests are not checked against
  `authorization.yaml`.
- Slack Connect and guest users are accepted as actors. Unless listed (and
  while `unknownUserRole` is `denied`), they are refused before any model call,
  and the refusal names `accessContact`, never the admins.

### Privilege escalation through tool arguments

Mitigations in code:

- Tools do not accept an actor; `requiredPermission` is fixed in code and never
  visible to the model.
- The registry refuses unknown tools and non-object arguments, and treats an
  authorizer error or malformed verdict as a denial.
- The resource used for scoped authorization is derived from the arguments only
  after resolving them through the operator's repository list, so the model
  cannot name a repository outside it.
- Write tools validate their arguments (branch names, positive integers, body
  sizes, label allowlist) and refuse rather than coerce.

Residual risk:

- Scopes are only as good as the resource a tool reports. They fail closed
  (a call that names no team or repository is refused to a scoped person), so
  a tool that wrongly marks a call `callerOnly` would widen a scoped grant.
  Milestone approval and hardening clicks report no resource yet, so a scoped
  lead is refused them rather than limited to their team's programmes.
- `code_task.trigger` delegates more than it says. The person who dispatches
  agent-fix does not need `pr.create` or `branch.create`; the workflow's agent
  has contents, pull requests and issues write on the target repository,
  bounded only by the workflow's guards and branch protection.
- `resume_pr_number` lets a dispatch point the agent at any open PR in the
  repository. Its push guard refuses branches without the `lexi/` prefix, but
  that guard is bypassable (next section).

### Token theft and lifetime

Server:

- The server holds the App private key and the Slack and model keys in its
  environment. The model has no shell or file tool, so it cannot read them.
- Provider errors pass through `redactProviderError` before they reach a chat
  thread; it strips GitHub and Slack token shapes, bearer headers and
  `token=`/`key=`/`secret=` values
  ([`result.ts`](../packages/agent-tools/src/shared/result.ts)). The GitHub
  client factory logs only `error.message`, never the error object
  ([`infrastructure.ts`](../apps/server/src/wiring/infrastructure.ts)). Model
  errors are summarised by HTTP status, never by body.
- Residual: the installation token the server uses carries every permission
  the installation has. Narrow the App's permissions and its installed
  repositories; that is the boundary.

#### Workflow agents

Both workflows expect their own GitHub App, separate from the server's, with
no Actions write and no Workflows permission, installed only on the
repositories they work on. The agent can reach every token minted from it.

agent-fix ([`agent-fix.yml`](../.github/workflows/agent-fix.yml),
[`gh-token-mint.sh`](../agent-fix/scripts/gh-token-mint.sh),
[`run-agent-segment.sh`](../agent-fix/scripts/run-agent-segment.sh),
[`agent-sandbox.sh`](../agent-fix/scripts/agent-sandbox.sh)):

- Tokens are scoped to the repository (plus same-owner `extra_repositories`)
  and to contents, pull requests and issues write, checks and actions read.
  No `workflows` permission.
- The App private key is passed only to minting steps, each of which mints one
  token and exits. The agent runs in segments of at most 55 minutes, inside a
  token's hour; before each segment a minting step writes a fresh token to a
  `0600` file and revokes the previous one. git and `gh` read the file per call
  through a credential helper and a shim; the token is never put in a remote
  URL or on a command line. Every token is registered with `::add-mask::`, and
  the last one is revoked when the job ends.
- Each segment (and the `evidence_command`) ends by stopping every process of
  the runner user that started after it did, found by start time in `/proc`,
  so `nohup`, `setsid` or a cleared environment do not escape. A process that
  cannot be stopped fails the run, and no further token is minted. It then
  truncates the step's `GITHUB_ENV`, `GITHUB_PATH` and `GITHUB_OUTPUT`, so the
  agent cannot set `LD_PRELOAD`, `PATH` or a step output for a later step.
- The scripts that handle the key are archived, with their digest recorded,
  before any repository or agent code runs; each minting step checks the digest
  and runs a fresh copy. The job's shell skips `~/.bashrc` and `BASH_ENV`, and
  the minting script resets `PATH` and `HOME` and runs `curl -q`, so a binary,
  rc file or `.curlrc` the agent planted is not used while the key is in
  memory.

Residual risk:

- **The agent can read the token.** It runs as the same user, with permissions
  skipped, and the token file is on disk. It can therefore call the GitHub API
  directly, or run `git push --no-verify`, and bypass the pre-push hook's branch
  prefix and protected-path checks. What still holds: the token's repository
  and permission scope, the missing `workflows` permission, and your branch
  protection. **Protect your default and release branches with rules the App
  cannot bypass.** A token the agent read stays valid until the next segment
  revokes it, at most 55 minutes.
- **`sudo` defeats the sweep.** On GitHub-hosted runners the runner user has
  passwordless `sudo`, so an agent can start a process as another user (or
  read any process's memory), which the sweep does not stop. Such a process
  could read the key from the next minting step. Keeping the key out of reach
  of an agent with root would need the minting in a separate job or on a
  separate runner; the workflows do not do that. On a self-hosted runner,
  deny the runner user `sudo`.
- **The sweep is Linux-only.** On a runner without `/proc` it warns and stops
  nothing.
- **Self-hosted runners shared between jobs.** The sweep leaves processes that
  carry another job's `RUNNER_TRACKING_ID`, so an agent that sets a forged one
  survives it there. GitHub-hosted runners stop every process regardless.
- `setup_command` and `evidence_command` run repository code and are swept
  the same way. The first token, minted before `setup_command` so the
  duplicate guard can read issues, is readable from the token file while it
  runs; it is revoked when segment 1 mints its own.

app-build ([`app-build.yml`](../.github/workflows/app-build.yml),
[`segment.sh`](../app-build/segment.sh), [`assess.sh`](../app-build/assess.sh)):

- The builder runs with the job's own `GITHUB_TOKEN` (contents, issues and pull
  requests read) and the model token. App tokens are minted in steps of their
  own, between segments, by the same one-shot script as agent-fix; checkouts
  do not persist credentials. Each mint names its permissions: read-only for
  the setup and assessment fetches, contents and pull requests write (issues
  read) for the pushes between segments, and issues write only where a report
  is commented (see [app-build.md](app-build.md#the-workflow-app)). Pushes are
  refused if a commit contains the configured staging credentials
  ([`push.sh`](../app-build/push.sh),
  [`redact-output.mjs`](../app-build/redact-output.mjs)).
- Each segment, and each part of the assessment (the checks run the builder's
  code; the review reads its diff), ends with the same sweep and file-command
  reset as agent-fix, and puts back `.git/config`, `.git/hooks` and the user's
  git configuration if the builder changed them. The builder tools are sealed
  before the first segment and every later step runs a verified copy. A step
  whose sweep failed shows as `failure`, and every later step that mints a
  token, posts to Slack or holds an `actions: write` token is skipped.
- The Slack webhook is never in a step that runs the builder or the gate
  reviewer: the gate queues its verdict and a later step posts it.
- Staging and Mailisk credentials reach only build-phase segments, not the
  planning phases.
- Feedback comes only from the build PR in the repository itself (not a fork
  PR), and `"*"` in `feedback_authors` admits only owners, organisation
  members and collaborators.

Residual risk:

- The model token, and in build-phase segments the staging credentials, are in
  the builder's environment. Use test accounts.
- The builder writes the `PHASE` file, so it can move itself to the build phase
  and receive the staging credentials early. The gating is against accidental
  exposure, not a determined builder.
- There is no protected-path check on what the builder commits; its push
  tokens carry contents write on the repository (gap 2).
- The `sudo`, Linux-only and shared-runner limits of the agent-fix sweep apply
  here too.

Programme workflows ([`programme-build.yml`](../.github/workflows/programme-build.yml),
[`programme-explore.yml`](../.github/workflows/programme-explore.yml),
[`programme-verify-web.yml`](../.github/workflows/programme-verify-web.yml),
[`programme-feature-intake.yml`](../.github/workflows/programme-feature-intake.yml)):

- The agent and the secrets that outlive it are in **different jobs**. The
  job that runs the agent holds the model key and, where it needs one, the
  brief token (used before the first agent phase). The evidence token, the
  access-proxy secret and the App private key for pushing, opening PRs or
  filing issues live in a later job on a fresh runner that never runs the
  agent or its code, and takes only validated data from it: a hand-off
  artifact (a git bundle, evidence inputs, run state, or findings) and job
  outputs set before the agent started. The agent runs as the runner's user
  with permissions skipped, and with sudo on GitHub-hosted runners, so
  nothing later in its own job (step environments, post steps, the runner's
  own binaries) was out of its reach; the job boundary is.
- The only App tokens minted in an agent's job are read tokens for a UI
  source or a reference repository: minted before the agent starts by
  [`actions/app-token`](../actions/app-token/action.yml), which has no post
  step (so the private key never reappears in the job), scoped to one
  repository with `contents: read`, masked, and revoked after the clone.
- The publishing jobs that use Lexi's actions check them out afresh, at the
  commit the agent's job recorded before the agent ran where there is one,
  and refuse to run if the checkout differs. `lexi-agent.sh` is rewritten
  read-only before each agent phase.
- After every agent phase the agent's whole process tree is stopped, on a
  normal exit as well as on a timeout: descendants of the wrapper and any
  process carrying the run's marker variable, then a sweep step. The agent
  runs without `GITHUB_ENV`, `GITHUB_OUTPUT`, `GITHUB_PATH` and
  `GITHUB_STATE` in its environment.
- `brief_url` must be exactly `<orchestrator_url>/api/programme/briefs/<attempt_id>`
  and every referenced document must be under `<orchestrator_url>/api/programme/`;
  the brief token and the access-proxy secret are sent nowhere else
  ([`actions/brief`](../actions/brief/action.yml)).
- The exploratory sweep's turnstile bypass is sent only when `preview_url`'s
  host is in the caller's `preview_allowed_hosts`, only on requests to that
  origin, and is kept out of the agent's environment and prompt.
- Residual: a self-hosted runner that is reused across jobs does not give the
  job boundary; use ephemeral runners. The sweep agent can read the bypass
  value from its file (same user). What the publishing job pushes is the
  agent's work, with a token narrowed to contents and pull requests write but
  no protected-path check (gap 2). The pass/fail
  status and token usage in the result and evidence are still reported by
  the agent's job, as data.

Programme runners:

- The brief and document routes and evidence ingest each take their own
  bearer token, compared in constant time, and refuse everything while the
  token is unset ([`programme-token.guard.ts`](../apps/server/src/http/programme-token.guard.ts)).
  Evidence for an attempt the server does not know is refused, and so is
  evidence whose `repository` is not the attempt's repository
  ([`run-evidence.prisma.ts`](../packages/programme/src/prisma/run-evidence.prisma.ts)).
- Residual: each token is shared by every runner in every repository that
  holds it. A leaked `PROGRAMME_BRIEF_TOKEN` reads any brief, design document
  or API contract by ID; a leaked `EVIDENCE_WEBHOOK_TOKEN` can submit evidence
  for a known attempt, and evidence feeds the auto-merge gate. The repository
  check binds evidence to its attempt but does not authenticate the sender:
  the repository is self-asserted, so a holder of the token can name the
  right one. Per-repository tokens or OIDC would close that.

### Workflow injection through inputs

Mitigations in code:

- The reusable workflows pass inputs to shell steps through `env:`; no `run:`
  script interpolates `${{ inputs.* }}` or `${{ github.event.* }}`. In
  agent-fix the full payload is written with `toJSON(inputs)` to a file,
  validated by `normalize-payload.sh`, and only its keys are printed, never the
  brief
  ([`agent-fix.yml`](../.github/workflows/agent-fix.yml),
  [`rebase-branch.yml`](../.github/workflows/rebase-branch.yml)).
- Branch names are checked with `git check-ref-format` and against prefix and
  protected lists; `branch_prefix`, `skill` and `extra_repositories` are matched
  against strict patterns before use.
- The server refuses briefs over 50,000 characters and dispatches only to
  repositories in scope, always on an explicit ref
  ([`agent-fix-module.ts`](../packages/agent-tools/src/agent-fix/agent-fix-module.ts)).

Residual risk:

- The brief is free text by design and reaches the agent's prompt. See prompt
  injection above.
- Anyone with `actions: write` on a target repository can dispatch its caller
  workflow directly, without going through Lexi or its authorization.

### Supply chain

Mitigations in code:

- `package-lock.json` and `npm ci` in CI; a runtime-dependency licence check
  (`scripts/check-licenses.mjs`); a leak scan for internal identifiers
  (`scripts/leak-scan.mjs`), over the files and over what is published with
  them (commit messages and emails, and a pull request's branch, title and
  description); and gitleaks over the full history
  ([`ci.yml`](../.github/workflows/ci.yml)).
- The docs tell callers to pin `uses:` and `lexi_ref` to the same tag or SHA,
  so a workflow and the scripts it checks out match.

Residual risk:

- Every workflow (agent-fix, app-build, app-build-tests, rebase-branch, the
  programme workflows and ci) pins third-party actions to a full commit SHA,
  with the tag in a comment.
- Tools installed at run time are pinned to exact versions, each overridable
  by an input: Claude Code (`claude_code_version`; app-build's install script,
  which `programme-feature-intake.yml` also uses, reads
  `LEXI_CLAUDE_CODE_VERSION`), Playwright, Playwright MCP, `@axe-core/cli`
  and the scoring packages. A pinned version still trusts npm for that
  version's contents.
- The example callers use `@main` and `lexi_ref: main` until a release exists.
- No SBOM or provenance is produced.
- `ci.yml` and `app-build-tests.yml` run a pull request's own code (npm
  install scripts, the build, the tests) on GitHub-hosted runners, where the
  runner user has passwordless `sudo`, so that code runs as root on a
  throwaway VM. That is accepted because nothing privileged shares its job:
  the token is `contents: read`, checkouts keep no credential, fork PRs get no
  secrets, and the one secret CI uses (the private leak-scan patterns) is in a
  separate job that installs nothing and, on a pull request, runs the base
  branch's scanner rather than the PR's. Do not add a secret or a write token
  to a job that runs PR code.

### Data exposure in logs and artifacts

Mitigations in code:

- Personal data is masked before anything is sent to a model, on by default:
  emails, phone numbers, Luhn-valid card numbers, checksum-valid IBANs, IP
  addresses and the deployment's own `MODEL_PII_EXTRA_PATTERNS`, in the agent
  loop (system prompt, messages, thread history, tool results) and in the
  decision engine (issue text, comments, evidence). See
  [What goes to the model](governance-model.md#what-goes-to-the-model).
- The Slack handler logs the actor ID, channel, thread and message length, not
  the message text ([`slack-conversation.handler.ts`](../apps/server/src/slack/slack-conversation.handler.ts)).
- Model and provider errors are never echoed to a thread verbatim.
- agent-fix prints request keys, not the brief; app-build redacts its
  credentials from check output, reports and feedback excerpts.
- `::add-mask::` hides a secret from the log, not from a file, so every file a
  workflow uploads from an agent's job (agent-fix, app-build, and the
  programme build, explore and feature-intake jobs) is redacted in place first
  by [`redact-output.mjs`](../app-build/redact-output.mjs): by value for every
  secret the agent held, in raw, JSON-escaped and URL-encoded forms, and by
  shape for GitHub tokens, model keys, Slack tokens and webhooks, AWS key ids,
  PEM private keys, bearer headers and credentials in URLs. A binary file (a
  screenshot) that holds one is deleted, as is any entry whose name holds one.
  If redaction fails the upload is skipped. The redacting step runs a copy
  sealed before the agent, and is given no secret the agent did not already
  hold: App tokens, the App private key and the Slack webhook are caught by
  shape instead.

Residual risk:

- Everything the agent reads (thread history, issue text, file contents, logs)
  is sent to the model provider configured in the environment; which provider
  that is, and where it processes data, is the deployment's choice. Masking is
  pattern-based: it does not catch names, addresses or other personal data in
  free text, Slack ids and GitHub logins are sent as-is by design, images are
  not masked, and `MODEL_PII_MASKING=false` turns it off.
- The coding agents in the GitHub Actions workflows (agent-fix, app-build,
  programme builds) and the local `apps/build` bridge are not covered by the
  masking: they run a coding-agent CLI against the repository with their own
  model credentials.
- The agent-fix artifact holds the agent's full transcript (`run.jsonl`) and
  investigation notes, which can quote source code, issue text and anything the
  agent printed. It follows the repository's artifact access and retention; the
  workflow sets no retention period.
- Redaction catches known values and known shapes. A secret the agent
  transformed (base64, split across lines), a credential of an unknown shape
  that the redacting step was not given (the brief token and the access-proxy
  secret are never given to a step after the agent), or one drawn into a
  screenshot's pixels is not caught. `branch.bundle` in the programme hand-off
  is not redacted: it holds the commits, which are pushed anyway.
- The logger has no redaction configuration; what is safe to log depends on
  each call site.
- The database stores issue titles and bodies, the decision engine's
  reasoning, remembered preferences and conventions, and programme documents,
  unencrypted at the application layer. The Compose file's Postgres
  uses trust authentication on `127.0.0.1` and is for local development only.
- `/metrics` and `/health/ready` are unauthenticated and reveal operational
  detail (including `CONFIG_REVISION`, if set).

### Denial of service and cost

Mitigations in code:

- Per thread: one turn at a time, a bounded queue (`SLACK_THREAD_QUEUE_MAX`),
  and stale follow-ups dropped after ten minutes
  ([`thread-turn-queue.ts`](../apps/server/src/slack/thread-turn-queue.ts)).
- Per person: at most `SLACK_USER_TURN_LIMIT` turns per
  `SLACK_USER_TURN_WINDOW_MS` (default 12 per 10 minutes), counted in memory;
  people the policy refuses everything get no model turn at all
  ([`slack-conversation.handler.ts`](../apps/server/src/slack/slack-conversation.handler.ts)).
- Per turn: 40 model calls, a wall-clock limit, result-size budgets, repeat
  detection, and an abort that stops in-flight model and tool calls
  ([`agent-runtime.ts`](../packages/agent/src/runtime/agent-runtime.ts)).
- Per agent-fix run: a job timeout (`budget_minutes`, default 120), a turn cap
  (`max_turns`, default 300), and one run per thread.
- The HTTP API refuses everything without the bearer token.

Residual risk:

- The per-person turn limit is per server process and resets on restart; there
  is no per-channel or global limit on turns, and no cap on how many agent-fix
  runs one person can dispatch. Many listed users can still run many turns and
  many workflow runs concurrently.
- Model spend is not metered or capped in the server (a cost ledger exists in
  the schema but is not wired).
- The HTTP API has no rate limit, and `POST /process` calls the decision engine.
- The programme ticker dispatches paid build runs on its own. Its limits are
  the policy's concurrency and attempt caps
  (`maxConcurrentTasksPerProgramme`, `maxTaskAttempts`), not a spend cap.
- The run budgets in `@lexi/governance` are not applied (see below).

## Known gaps

Not mitigated, or built but not wired into `apps/server`:

1. **Workflow agent containment depends on GitHub, not on the hooks.** The
   agent-fix agent can read its token from disk and run `git push --no-verify`
   or call the API, bypassing the pre-push hook. The real boundary is branch
   protection, the token's repository and permission scope, and the App having
   no Workflows permission. An agent that uses the runner's passwordless `sudo`
   can still start a process the sweep cannot stop, and read the App private
   key from a later minting step.
   Closed: the key is no longer in a long-lived process the agent can read
   (agent-fix and app-build mint per segment and stop the agent's processes
   first), and every token is masked and revoked when the next is minted.
2. **app-build and programme-build have no protected-path guard.** What their
   agents commit is pushed with a token that carries contents write on the
   repository (and pull requests write, plus issues write on app-build's report
   steps), so the App's installation permissions and branch protection are
   the boundary.
   Closed: push tokens no longer carry every permission. Every mint names its
   permissions (app-build's seven, programme-build's publish token, the rebase
   token, agent-fix's), none asks for `workflows` or `actions: write`, and
   `gh-token-mint.sh` and `actions/app-token` refuse to mint without a
   permission set.
3. **No audit observer.** `AgentObserver` exists, but the server passes none to
   the registry or the runtime. Tool calls, refusals and their requester are
   not recorded anywhere except the Slack thread itself; GitHub records the
   App, not the person who asked (only agent-fix's `requester` input and
   app-build's `AuditLog` rows name them).
4. **Blast radius and run budgets are not enforced.** `MutationGuard`,
   `GuardedMutationGateway` and the limits in `run-budgets.yaml` are library
   code; the server applies none of them to Slack turns, `POST /process` or the
   programme ticker.
5. **`/process`, `/reprocess` and `/retest` are authorized by one bearer token,**
   not per person, and are not checked against `authorization.yaml`. The
   programme's runner routes are the same: one shared token each.
6. **Run-time tools trust the registry.** Actions are pinned to commit SHAs
   and tools to exact versions everywhere, but nothing verifies a package's
   contents beyond npm's integrity for that version.
   Closed: tag-pinned actions and Claude Code installed at latest.
7. **The server listens on all interfaces** (`app.listen(PORT)` with no host),
   the Compose file publishes port 3000 on all host interfaces, and `/metrics`
   and `/health/ready` are unauthenticated.
8. **Reproduction is a no-op.** The server uses `NoopReproductionProvider`,
   which marks every issue "not reproduced, no reproduction attempted"; issue
   workflow decisions are made without a reproduction.
9. **`AppBuildWatcher` is not wired.** App-build reports reach Slack only when
    someone asks `get_app_build_status`.
10. **No confirmation before writes.** An authorized write runs as soon as the
    model calls it.
11. **No content isolation for untrusted text** in the agent path
    (`prompt-isolation.ts` exists but is not used).
12. **No cost cap, and rate limiting only per person on Slack turns.** There
    is no limit on dispatches, the programme or the HTTP API.
13. Closed: scoped grants no longer fail open; an action that names no team or
    repository is refused to a scoped person.
14. **In-memory state.** The per-thread queue and event de-duplication are lost
    on restart, and a restart drops the turn in flight without a reply.
15. **The programme's UI source wording disagrees.** The orchestrator treats a
    `uiSource` as an intent reference, not code to copy, but
    `programme-build.yml` still tells the build agent to port the UI from it
    (see [programme-contract.md](programme-contract.md#uisource--an-intent-reference)).

## Recommendations for a deployment

- Start with `GOVERNED_WRITES_ENABLED=false`; list a handful of people in
  `authorization.yaml`; turn writes on deliberately.
- Keep `unknownUserRole: denied` so unlisted people, including Slack Connect
  and guest users, get no governed tool at all.
- Give the server's GitHub App the minimum permissions in
  [getting-started.md](getting-started.md#2-create-the-github-app), no
  `workflows` permission, and install it on as few repositories as possible.
- Give the workflows their own App, never the server's: no Actions: write, no
  `workflows` permission, installed only on the target repositories
  ([getting-started.md](getting-started.md#a-second-app-for-the-workflows)). A
  workflow agent can likely read that App's key; with the server's key it would
  hold Actions: write everywhere the server reaches.
- Protect default and release branches with rules that apply to the App.
- Pin workflow `uses:` and `lexi_ref` to a SHA, and review the pinned tool
  versions (`claude_code_version`, `playwright_mcp_version`) when you upgrade.
- Give the workflows their own GitHub App, with no Actions write or Workflows
  permission, installed only on the repositories they work on.
- Put the HTTP port on a private network; set long random values for
  `PROCESS_API_TOKEN`, `PROGRAMME_BRIEF_TOKEN` and `EVIDENCE_WEBHOOK_TOKEN`.
- Leave `PROGRAMME_AUTO_MERGE_ENABLED` off until you have watched the auto-merge
  gate's verdicts on real tasks.
- Set artifact retention on repositories that run agent-fix.
