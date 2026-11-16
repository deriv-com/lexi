# Getting started

By the end of this guide you can @mention Lexi in your own Slack workspace, ask
it about an issue or a CI run in your GitHub organisation, and get an answer in
the thread. You also send it a first bug report through `POST /process`. You
run the server locally and start with every write switched off, so you can
watch what the agent would do before it does anything.

Read [governance-model.md](governance-model.md) before you switch writes on, and
[threat-model.md](threat-model.md) before you deploy it anywhere shared. The
[capability matrix](capability-matrix.md) lists every tool the agent can call
and the permission each one needs.

## What you need

- Node.js 20 or later (`.nvmrc` pins the version CI uses) and npm. The
  repository uses npm workspaces; there is no pnpm or yarn lockfile.
- Docker, for the example Compose file (Postgres with pgvector, plus the
  server built from your checkout).
- A Slack workspace where you can create apps.
- A GitHub organisation where you can create and install a GitHub App.
- A model endpoint and key. The agent loop speaks the Anthropic Messages API to
  models whose name starts with `claude-`, and the OpenAI chat API to anything
  else ([`packages/agent/src/llm/llm-factory.ts`](../packages/agent/src/llm/llm-factory.ts)).
  The issue workflow's decision engine uses an OpenAI-compatible endpoint
  ([`packages/ai`](../packages/ai)). A gateway such as LiteLLM can serve both
  from one URL.

## 1. Create the Slack app

1. Go to <https://api.slack.com/apps>, choose **Create New App**, then
   **From a manifest**, and paste
   [`examples/slack-manifest.yml`](../examples/slack-manifest.yml).
2. Install the app to the workspace. Copy the **Bot User OAuth Token**
   (`xoxb-…`) into `SLACK_BOT_TOKEN`.
3. Copy the **Signing Secret** (Basic Information) into `SLACK_SIGNING_SECRET`.
   Socket Mode does not use it, but configuration validation requires it.
4. Under **App-Level Tokens**, create a token with the `connections:write` scope
   and copy it (`xapp-…`) into `SLACK_APP_TOKEN`.

The app runs in Socket Mode: the server opens the connection to Slack, so it
needs no public URL. The manifest asks for these bot scopes: `app_mentions:read`,
`chat:write`, `channels:history`, `groups:history`, `im:history`, `im:read`,
`im:write`, `reactions:write` and `users:read`. It subscribes to `app_mention`
and `message.im` only.

## 2. Create the GitHub App

The server authenticates as a GitHub App installation when `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` are set, and falls back to a personal access token in
`GITHUB_TOKEN` otherwise
([`apps/server/src/wiring/infrastructure.ts`](../apps/server/src/wiring/infrastructure.ts)).
Use an App.

Repository permissions the server's tools and workflow engine call, derived
from [`packages/github/src/octokit-github.provider.ts`](../packages/github/src/octokit-github.provider.ts)
and the tool modules:

| Permission | Access | Why |
|---|---|---|
| Metadata | Read | Required by every App; default branch lookups. |
| Issues | Read and write | Read issues and comments; comment, close, reopen, assign, create issues. |
| Pull requests | Read and write | Read PRs, files and reviews; open, merge, close and reopen PRs. |
| Contents | Read and write | Read files and PR templates; create branches; merge. |
| Actions | Read and write | Read runs, job logs and artifacts; dispatch the agent-fix, rebase-branch, app-build and programme workflows. |
| Checks | Read | `merge_pull_request` and the programme's auto-merge gate refuse to merge when they cannot read the checks. |

Do **not** grant the **Workflows** permission. Nothing in the server needs it,
and without it GitHub itself refuses any push that changes `.github/workflows/`.

Install the App only on the repositories you want the agent to reach. The
agent's tools are further limited to the repositories in `repos.yaml` (see
below), but the installation is the outer boundary.

Put the App ID in `GITHUB_APP_ID`, the private key in `GITHUB_APP_PRIVATE_KEY`
(one line, with literal `\n` in place of line breaks), and optionally the
installation ID in `GITHUB_APP_INSTALLATION_ID`.

### A second App for the workflows

The reusable workflows run in your product repositories with App credentials
stored as repository secrets (`LEXI_APP_ID`, `LEXI_APP_PRIVATE_KEY`). **Create
a separate App for them; do not reuse the server's.** Give it only what the
workflows need (Contents, Pull requests and Issues: read and write; Checks and
Actions: read; see [agent-fix.md](agent-fix.md) and [app-build.md](app-build.md)),
**never Actions: write and never Workflows**, and install it only on the
repositories the workflows build in.

Why: the workflow agent runs with its tool permissions skipped, reads untrusted
issue and PR text, and can read its own token and, likely, the App private key
from the job's environment ([threat-model.md](threat-model.md#known-gaps)). If
that key belonged to the server's App, a prompt-injected run would hold Actions:
write on every repository the server reaches: it could dispatch any workflow on
any branch, including the agent workflows themselves with inputs of its choosing.
With a separate App, the most a compromised run gets is the narrow workflow App
on the repositories it is installed on.

## 3. Copy the environment file

```bash
cp .env.example .env
```

Fill in at least:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | The Compose file overrides it for the container. |
| `GITHUB_OWNER`, `GITHUB_REPO` | Required. The default repository for issue actions. |
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` | From step 1. |
| `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `LITELLM_CLAUDE_MODEL` | The agent loop's endpoint, key and model. `SLACK_AGENT_MODEL` overrides the model. |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | The decision engine's key, endpoint and model. |
| `MODEL_PII_MASKING`, `MODEL_PII_EXTRA_PATTERNS` | Personal data is masked out of everything sent to a model (default `true`; `false` turns it off). Extra patterns are your own regexes, separated by `\|\|`, masked as `[redacted]`. See [What goes to the model](governance-model.md#what-goes-to-the-model). |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | From step 2. |
| `SLACK_AGENT_ENABLED` | `true` to connect to Slack. |
| `PROCESS_API_TOKEN` | A long random string, to enable `POST /process`. Empty refuses every request. |
| `GOVERNANCE_CONFIG_DIR` | Directory holding the policy files. `.env.example` sets `examples/config`. |

Both model keys are optional, and each side falls back to the other
([`runtime-wiring.ts`](../apps/server/src/wiring/runtime-wiring.ts)):

- The agent loop uses `LITELLM_API_KEY`, or `OPENAI_API_KEY` when that is
  empty, against `LITELLM_BASE_URL` (or `OPENAI_BASE_URL`).
- The decision engine behind `POST /process` uses `OPENAI_API_KEY` with
  `OPENAI_BASE_URL`, or `LITELLM_API_KEY` with `LITELLM_BASE_URL` when
  `OPENAI_API_KEY` is empty. Its model is always `OPENAI_MODEL`.

A deployment behind one gateway can set only the `LITELLM_*` values. With no
key at all the server still boots: Slack turns fail with an error reply, and
the issue actions answer 501.

Configuration is validated at boot by [`packages/config`](../packages/config);
a missing required value stops the server with a message that names it.

`.env.example` lists more flags than the server reads. Many belong to library
components (schedulers, intake, duplicate detection, spec sessions) that are
not wired into `apps/server`. The server reads:

- the database, Slack and GitHub credentials, and the model settings above,
  including `MODEL_PII_MASKING` and `MODEL_PII_EXTRA_PATTERNS`;
- `GOVERNED_WRITES_ENABLED`, `GOVERNED_DRY_RUN`, `GOVERNANCE_CONFIG_DIR`;
- `SLACK_AGENT_ENABLED`, `SLACK_CHANNEL_POST_ENABLED`,
  `SLACK_CHANNEL_POST_ALLOWLIST`, the `SLACK_TURN_*` and `SLACK_THREAD_*`
  limits;
- `SLACK_USER_TURN_LIMIT` and `SLACK_USER_TURN_WINDOW_MS`: turns one person
  may start per window (default 12 per 600000 ms; `0` turns the limit off),
  and `SLACK_LINK_HOSTS`: comma-separated hosts whose masked links keep their
  label in replies, besides github.com. These three are read directly from the
  environment, not through the validated config;
- `AGENT_NAME`, `PROCESS_API_TOKEN`, `CONFIG_REVISION`, `PORT`, `LOG_LEVEL`;
- the optional features below: `APP_BUILD_*`, `PROGRAMME_*`,
  `EVIDENCE_INGEST_ENABLED` and `EVIDENCE_WEBHOOK_TOKEN`.

Memory needs no environment flag: it is switched on and off by `enabled` in
`memory-policy.yaml`, and stores what it keeps in the same Postgres database.

### Start with writes off

Two switches sit in front of every GitHub write and every Slack post the server
makes on its own account (agent posts, issue-workflow notifications, programme
review cards):

- `GOVERNED_WRITES_ENABLED` (default `false`): the master switch. Off, the
  mutation gateways refuse the write and the tool reports that nothing changed.
- `GOVERNED_DRY_RUN` (default `false`): when `true`, writes are refused even if
  the master switch is on, and each refusal is logged as
  `Would execute GitHub mutation: …` or `Would execute Slack mutation: …`.

Leave `GOVERNED_WRITES_ENABLED=false` for your first runs. Authorization is
still evaluated, so you can see who would be allowed to do what, and the agent
says plainly that nothing was changed. Turn writes on once `authorization.yaml`
lists only the people you intend, and you have read
[governance-model.md](governance-model.md).

## 4. Edit the policy files

[`examples/config/`](../examples/config/) holds policy and registry files for a
fictional organisation, Acme. Copy the directory, point `GOVERNANCE_CONFIG_DIR`
at the copy, and replace the people, channels and repositories with your own.
Every ID in the examples (`U0TEST01`, `C0TEST01`, `acme/web-app`) is a
placeholder.

What the server reads:

| File | What it controls |
|---|---|
| `authorization.yaml` | Roles, the permissions each grants, and which Slack user holds which role. Every governed tool call, reads included, is checked against it. |
| `repos.yaml` | The repositories the agent may touch. Read tools cover every listed repository; write and dispatch tools cover only those with the `code` role, and never a `placeholder: true` entry. |
| `ownership.yaml` | Who an issue is routed to and which Slack channel the issue workflow notifies. Used by `POST /process`. |
| `memory-policy.yaml` | Whether the agent remembers anything, for how long, and who can recall it. Without the file, memory is off. |
| `programme-policy.yaml` | Read only when `PROGRAMME_ENABLED=true`. See [the rebuild programme](#the-rebuild-programme). |

The other files (`run-budgets.yaml`, `escalation-policy.yaml`,
`spec-policy.yaml` and the rest) configure library components the server does
not consult. [`examples/config/README.md`](../examples/config/README.md)
describes each one.

### authorization.yaml

The file is loaded once at boot by
[`apps/server/src/authorization/load-authorization.ts`](../apps/server/src/authorization/load-authorization.ts).
If it is missing, unreadable, invalid, has `version: 0` or defines no roles,
the server still starts, but every governed action is refused and
`/health/ready` reports `not_ready`.

The shape:

```yaml
version: 1
defaults:
  unknownUserRole: denied          # people not under `users:` get nothing
  authenticatedRole: viewer        # used only when unknownUserRole is viewer
  accessContact: "Grace (#acme-platform)"   # optional; named in refusals
roles:
  viewer:
    permissions: [issue.read, actions.read, memory.recall, memory.remember]
  engineer:
    inherits: [viewer]
    permissions: [issue.comment, pr.create, code_task.trigger]
users:
  U0TEST03:            # Slack user ID
    name: Carol
    roles: [engineer]
  U0TEST01:
    name: Alice
    roles: [team_lead]
    scopes:            # optional; narrows the grant
      teams: [home]
```

Things to know before you rely on it:

- **Keys are Slack user IDs.** The person asking is the Slack event's `user`
  field; nothing in a message can change it.
- **Reads need a permission too.** The server gives every read tool that has
  no permission of its own `issue.read`, and the app-build status tool
  `actions.read`. The example grants both to `viewer`, the lowest role.
- **With `unknownUserRole: denied`, people not listed under `users:` are denied
  every governed action, reads included.** The agent refuses them before it
  calls the model at all. The refusal says that access is deliberately limited
  and names `accessContact` (or, without one, asks them to contact a platform
  admin; an unlisted person is never told who the admins are). `authenticatedRole` is used only when `unknownUserRole` is
  `viewer`; the service does not tell a workspace member from any other
  unlisted ID
  ([`authorization.service.ts`](../packages/governance/src/authorization/authorization.service.ts)).
- **List people individually.** Slack user groups grant nothing; the schema
  still accepts a `groups:` block, but it is never evaluated.
- **Permissions are exact strings.** No wildcards, no prefixes. A role's
  effective permissions are its own plus every inherited role's.
- **A scoped grant covers only what it can check.** A `teams` scope allows a
  call only when its target repository has a `team` in `repos.yaml` and that
  team is in the scope; a `repositories` scope only when the call names a
  repository in the scope. A call that names neither (org-wide memory, a post
  to another channel, a milestone approval click) is refused to a scoped
  person, except calls confined to them: their own memory, the thread they
  asked in, a post to the channel they asked in. Give every repository in
  `repos.yaml` a team if you use team scopes. In the example, Alice holds
  `team_lead` for `home` and Bob for `p2p`.

[governance-model.md](governance-model.md) explains the checks, and the
[capability matrix](capability-matrix.md) maps each permission to the tools
that need it.

## 5. Run it

```bash
docker compose -f examples/docker-compose.yml up
```

The first start installs dependencies, generates the Prisma client, creates the
schema with `prisma db push`, and builds, so it takes a few minutes. Postgres
listens on `127.0.0.1:5432` with trust authentication, for local development
only. This is not a production deployment; build an image for that.

Check it is up:

```bash
curl http://localhost:3000/health         # live as long as HTTP is served
curl http://localhost:3000/health/ready   # database reachable and policy loaded
```

The log names the authorization file it loaded and the tool modules it
registered, for example
`Agent tools: github-read (8), github-write (8), agent-fix (3), work-items (2), slack (2), memory (5)`.
The label tools are left out because the server passes no label allowlist, and
`search_product_knowledge` because no knowledge index is wired. A module whose
dependency is missing (no GitHub credentials, no repository registry) is left
out rather than registered in a broken state.

## 6. First @mention

Invite the bot to a channel (`/invite @lexi`) and mention it:

> @lexi what are the open pull requests on acme/web-app?

The bot reacts with :eyes: while it works, answers in the thread, then swaps the
reaction for :white_check_mark: (answered) or :x: (anything else). A direct
message works too. Ask as someone listed in `authorization.yaml`: an unlisted
person is refused even this read.

Try a write as a user who holds `issue.comment`:

> @lexi comment "looking into this" on acme/web-app#12

With writes off, the reply says the write was authorized but not performed. Ask
as a user without the permission, and it says which permission is missing and
whom to ask.

One turn runs at a time per thread. Follow-ups wait behind it (up to
`SLACK_THREAD_QUEUE_MAX`, default 5); a follow-up that waits more than ten
minutes is not answered late. A turn is aborted after `SLACK_TURN_TIMEOUT_MS`
(default 15 minutes).

## 7. POST /process

`POST /process` runs the issue workflow for one GitHub issue. It is meant for a
scheduler or an operator, not for chat users.

```bash
curl -X POST http://localhost:3000/process \
  -H "Authorization: Bearer $PROCESS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repository": "acme/issues", "issueNumber": 12}'
```

- `repository` is optional; omitted, it is `GITHUB_OWNER/GITHUB_REPO`. It must be
  that repository or one listed in `repos.yaml`.
- `POST /reprocess` cancels any active cycle for the issue and starts again.
  `POST /retest` re-runs verification. Both take the same body.

| Status | Meaning |
|---|---|
| 200 | The workflow ran; the body is the workflow execution record (or `{ "ok": true }`). |
| 400 | Invalid body, or a repository the deployment does not manage. |
| 401 | Missing or wrong bearer token. |
| 403 | `PROCESS_API_TOKEN` is not set, so the API is disabled. |
| 501 | The workflow engine is not wired: no GitHub credentials, or no model key. |

The bearer token is the only authorization on these routes; they do not consult
`authorization.yaml`. The server has no reproduction worker: it uses
`NoopReproductionProvider`, which records every issue as "not reproduced, no
reproduction attempted". See [architecture.md](architecture.md#post-process)
for what the workflow then does.

`/health`, `/health/ready` and `/metrics` need no token. Do not expose the port
beyond the network your scheduler and Prometheus live on.

## Optional features

Both are off by default. Each one is left out, with a warning in the log, when
its switch is on but GitHub credentials or `repos.yaml` are missing.

### App builds

Set `APP_BUILD_ENABLED=true` to give the agent the four app-build tools
(`start_app_build`, `stop_app_build`, `send_app_build_feedback`,
`get_app_build_status`). They dispatch and watch the `app-build.yml` caller in
a product repository; copy it from
[`examples/workflows/app-build.yml`](../examples/workflows/app-build.yml) and
see [app-build.md](app-build.md).

- `APP_BUILD_DEFAULT_REPOSITORY`: the repository used when a request names none.
- `APP_BUILD_WORKFLOW_REF`: the ref to dispatch on. Empty means the
  repository's default branch.

The tools reach only repositories with the `code` role in `repos.yaml`. Dispatches,
stops and feedback are recorded as rows in the `AuditLog` table.

### The rebuild programme

A programme rebuilds an app in an agent-owned repository, milestone by
milestone, by dispatching the `programme-*` workflows
([programme-contract.md](programme-contract.md)). It is wired in
[`programme-wiring.ts`](../apps/server/src/wiring/programme-wiring.ts) and
needs all of:

- `PROGRAMME_ENABLED=true`, and `enabled: true` in `programme-policy.yaml`;
- GitHub credentials and `repos.yaml`;
- a target repository listed in `programme-policy.yaml`
  `programmes.allowedRepoKeys` that is also, in `repos.yaml`, a non-placeholder
  repository with the `code` role and `autonomyTier: autonomous`. The example
  lists only a placeholder, so it allows none.

The other settings:

| Variable | What it does |
|---|---|
| `PROGRAMME_DISPATCH_ENABLED` | Lets the programme dispatch build workflows. |
| `PROGRAMME_AUTO_MERGE_ENABLED` | Lets the programme merge a task PR once its auto-merge gate passes. Also needs `autoMerge.enabled` in the policy. |
| `PROGRAMME_PUBLIC_BASE_URL` | This server's public URL, written into briefs and review cards so build runners can fetch documents from it. |
| `PROGRAMME_REVIEW_CHANNEL` | The Slack channel milestone review cards are posted to. |
| `PROGRAMME_BRIEF_TOKEN` | Bearer token for the brief and document routes (the workflows' `brief_token`). |
| `EVIDENCE_INGEST_ENABLED`, `EVIDENCE_WEBHOOK_TOKEN` | Turn on `POST /api/evidence` and set its bearer token (the workflows' `evidence_token`). |
| `PROGRAMME_FINDINGS_REPO` | Optional second repository (`owner/name`) whose hardening findings count alongside the target repository's. |
| `PROGRAMME_TICK_MS` | How often the server advances live programmes (default five minutes). |

When it is on, the server registers the programme agent tools, a Slack handler
for the review-card buttons, and a ticker that advances live programmes. The
HTTP routes the runners call are always present, and each refuses while its
feature is off or its token is unset. Milestone approval is a button a person
clicks on the review card, never an agent tool, and the server re-checks that
person's permission.

## Next

- [architecture.md](architecture.md): packages and request lifecycles.
- [governance-model.md](governance-model.md): roles, permissions, write gates and limits.
- [capability-matrix.md](capability-matrix.md): every tool and the permission it needs.
- [threat-model.md](threat-model.md): what is mitigated and what is not.
- [agent-fix.md](agent-fix.md): set up a repository so the agent can open fix PRs.
