# Governance model

Use this page to decide who may ask Lexi to do what, and to see what stops
it doing anything else. You list people and teams in your own
`authorization.yaml`; Lexi checks every tool call against it for the person
who asked, keeps writes off until you switch them on, and reports whether each
action actually ran.

Lexi lets a model decide *what* to do, and makes deterministic code decide
*whether* it may. This page describes those checks as the code implements
them, including where they stop. The [capability matrix](capability-matrix.md)
lists every tool the agent can call and the permission it requires.

The short version:

1. A tool the registry does not know is refused.
2. A tool that changes anything must declare a permission, and the person who
   asked must hold it. Anything other than an explicit yes is a no. In the
   server, reads of GitHub and app-build status need a permission too.
3. Even when authorized, a write reaches GitHub or Slack only if the
   deployment's write switch is on and dry-run is off.
4. Each tool re-checks its own target and arguments against current state.
5. Every result says whether the action actually executed, and the agent is
   told to report exactly that.

## Roles and permissions

Roles, their permissions and who holds them live in `authorization.yaml` in
the directory named by `GOVERNANCE_CONFIG_DIR`. The example is
[`examples/config/authorization.yaml`](../examples/config/authorization.yaml);
the schema and evaluator are in
[`packages/governance/src/authorization`](../packages/governance/src/authorization).

The example ladder:

| Role | Inherits | Adds, among others |
|---|---|---|
| `viewer` | | `issue.read`, `actions.read`, `memory.recall`, `memory.remember`, `programme.read` |
| `qa` | `viewer` | `issue.comment`, `issue.update`, `issue.close`, `work_item.create`, `slack.post_channel`, spec drafting |
| `engineer` | `viewer` | `issue.comment`, `issue.close`, `code_task.trigger`, `pr.create`, `pr.merge`, `pr.close`, `branch.create`, `branch.rebase`, `app_build.stop`, `app_build.feedback`, `programme.task.retry`, `programme.decision.record`, `spec.approve` |
| `qa_lead` | `qa`, `engineer` | `batch.execute` |
| `team_lead` | `engineer` | `project.write`, `issue.reassign`, `spec.supersede`, `app_build.trigger`, `memory.forget_team`, the programme commands (create, cancel, pause, dispatch, rescope, `programme.milestone.approve`, `programme.hardening.conclude`) |
| `security_reviewer` | `viewer` | `security.read` |
| `platform_admin` | `team_lead`, `qa_lead` | `authorization.grant`, `rollback.execute` |

How evaluation works (`AuthorizationService.evaluate`):

- **Identity.** The key is a Slack user ID. The registry passes the turn's
  `actorId`, which the Slack surface takes from the event's `user` field. The
  model never supplies it.
- **Permissions are exact strings.** No wildcards or prefix matches. A role's
  effective set is its own permissions plus every inherited role's, resolved
  once at load.
- **Unlisted people.** With `defaults.unknownUserRole: denied` (the default and
  the example), anyone not under `users:` is refused every governed action,
  reads included. The Slack handler refuses them before the model runs. The
  refusal names the permission, says that access is deliberately limited, and
  names `defaults.accessContact`; without one it points them at a platform
  admin without naming anyone. A listed person missing a permission is told
  the contact or, without one, every `platform_admin` by name. `authenticatedRole` applies only when
  `unknownUserRole` is `viewer`, and then to every unlisted ID: the service
  cannot tell a workspace member from anyone else.
- **Scopes fail closed.** A user entry may carry `scopes.teams` and
  `scopes.repositories`. A scoped grant allows a call only when the call's
  resource names the scoped attribute and its value is in the scope: a team
  scope needs the target repository's `team` (from `repos.yaml`), a repository
  scope needs the repository. A call that names neither is refused to a scoped
  person: a repository with no team, org-wide memory (team recall, team
  conventions), a product-knowledge search not restricted to one repository, a
  post to a channel other than the one asked in, and a milestone approval or
  hardening click (those report no resource yet). The exception is a call
  confined to the caller (`callerOnly`): their own preferences, the thread
  they asked in, a post to that channel. Programme tools resolve the
  programme to its target repository and team. Unscoped grants are unaffected.
  The example scopes Alice's `team_lead` to `home` and Bob's to `p2p`.
- **Not supported.** Slack user groups grant nothing: the schema still accepts
  a `groups:` block, but nothing evaluates it. Runtime grants
  (`replaceRuntimeAssignments`) exist on the service but nothing in the server
  calls them, so the YAML file is the only source of roles.

### Which tool needs which permission

The [capability matrix](capability-matrix.md) is the list: every tool, whether
it changes anything, and the permission it declares. It is generated from
[`all-tool-modules.ts`](../apps/server/src/capability/all-tool-modules.ts) by
`npm run docs:capability-matrix`, and a spec fails when it is stale, so it
cannot drift from the code.

What the server adds on top of the matrix:

- **Reads are governed.** The server passes `readPermission: "issue.read"`
  to the default tool modules, which gives it to every read tool that declares
  no permission of its own (the GitHub reads, `get_agent_run_result`,
  `list_repositories`, `get_thread_context`), and `actions.read` to
  `get_app_build_status`
  ([`runtime-wiring.ts`](../apps/server/src/wiring/runtime-wiring.ts)). The
  matrix is rendered with the same permissions, so no tool in it shows `—`.
- **Not registered.** The label tools (`add_labels`, `remove_labels`) need a
  label allowlist, which the server does not pass. The spec tools need a spec
  executor, which it does not pass. `search_product_knowledge` needs a
  knowledge index, which it does not pass.
- **Opt-in.** The app-build tools appear only with `APP_BUILD_ENABLED=true`;
  the programme tools only with `PROGRAMME_ENABLED=true`. The matrix shows them
  as if both were on.

The `POST /process` HTTP path does not use `authorization.yaml` at all: the
bearer token is its only authorization.

## Fail-closed rules

Each of these is enforced in code, not by convention.

| Situation | Behaviour | Where |
|---|---|---|
| The model calls a tool that is not registered | Refused: "There is no tool named …". | `ToolRegistry.invoke` |
| A mutating tool has no `requiredPermission` | Registration throws; the server does not start with it. | `ToolRegistry.register` |
| Arguments are not a JSON object | Refused before authorization. | `ToolRegistry.invoke` |
| No authorizer configured | `DENY_ALL` refuses every governed call. | [`authorizer.ts`](../packages/agent/src/tools/authorizer.ts) |
| The turn has no actor | Refused: no identifiable person. | `ToolRegistry.authorize` |
| The authorizer throws, rejects, or returns anything but `allowed: true` | Refused, with the reason. | `ToolRegistry.authorize` |
| `authorization.yaml` missing, unreadable, invalid, version 0 or no roles | A deny-all service; every governed call, reads included, is refused; `/health/ready` is `not_ready`. The agent can still answer from what it knows. | [`load-authorization.ts`](../apps/server/src/authorization/load-authorization.ts) |
| Unknown person | Refused every governed call, reads included (with `unknownUserRole: denied`). | `AuthorizationService.evaluate` |
| A repository not in `repos.yaml` (or without the `code` role, for writes and dispatch) | Refused by the tool's `RepoScope`; nothing is guessed. | [`repo-scope.ts`](../packages/agent-tools/src/shared/repo-scope.ts) |
| A tool throws | Turned into an error result; a mutating tool's outcome says it did not execute. | `ToolRegistry.invoke` |
| No model key (neither `LITELLM_API_KEY` nor `OPENAI_API_KEY`) | Every Slack turn fails with `NotWiredError`; `/process` answers 501. The server still boots. | `runtime-wiring.ts` |
| No GitHub credentials | GitHub tools are not registered; `/process` answers 501; app-build and the programme stay off. | `runtime-wiring.ts`, `programme-wiring.ts` |
| `PROCESS_API_TOKEN` unset | Every `/process`, `/reprocess`, `/retest` request is refused with 403. | [`bearer-token.guard.ts`](../apps/server/src/http/bearer-token.guard.ts) |
| Programme off, or `PROGRAMME_BRIEF_TOKEN` unset | Every brief and document route is refused with 403. | [`programme-token.guard.ts`](../apps/server/src/http/programme-token.guard.ts) |
| `EVIDENCE_INGEST_ENABLED` off, or `EVIDENCE_WEBHOOK_TOKEN` unset | `POST /api/evidence` is refused with 403. | `programme-token.guard.ts` |
| `programme-policy.yaml` missing or invalid | The programme stays off. | `programme-wiring.ts` |
| `GOVERNED_WRITES_ENABLED` unset or not exactly `true` | Writes are off. | [`packages/config`](../packages/config/src/env.schema.ts) |

## The two write gates

A write has to pass two independent checks, in this order.

1. **Authorization**, in the registry, before the tool runs: does this person
   hold the tool's permission for this resource?
2. **The write switch**, in the mutation gateway, when the tool tries to
   write. `GitHubMutationGateway`
   ([`packages/github/src/github-mutation-gateway.ts`](../packages/github/src/github-mutation-gateway.ts))
   and `SlackMutationGateway`
   ([`packages/slack/src/slack-mutation-gateway.ts`](../packages/slack/src/slack-mutation-gateway.ts))
   refuse the write when `GOVERNED_WRITES_ENABLED` is not `true` or
   `GOVERNED_DRY_RUN` is `true`. The refusal is logged
   (`Would execute GitHub mutation: …`) and the tool reports
   `executed: false` with the reason.

The gates are independent: the first knows who is asking, the second knows
nothing about people and stops everything. Turning writes off is a single
switch that does not depend on the policy file being right.

Two narrower checks sit inside the GitHub gateway regardless of the switch:
`dispatchWorkflow` refuses release, production and publish pipelines
(`release.yml`, `production*.yml`, `publish*.yml`, anything under `release/` or
`production/`), even in dry-run
([`protected-workflows.ts`](../packages/github/src/protected-workflows.ts)).

The issue workflow's Slack notifications, the programme's review cards and
posts, and the programme's dispatches and merges all go through the same
gateways, so the switches stop them too.

What the switches do **not** cover:

- The agent's own reply in the thread, its reactions, and the ephemeral answer
  to a review-card click. These are the agent speaking, posted directly.
- Anything the reusable workflows do in your repositories. They hold their own
  App credentials; the switches live in the server. Those credentials must
  belong to a separate workflow App with no Actions: write, installed only on
  the target repositories: a workflow agent may reach that App's private key,
  and the server's App can dispatch workflows
  ([getting-started.md](getting-started.md#a-second-app-for-the-workflows)).

## Tool-level guards

Authorization answers "may this person do this kind of thing". Each write tool
then checks what authorization cannot: the target, the arguments, and the
current state, read fresh rather than taken from the model.

- **Repository scope.** Every repository argument resolves through a
  `RepoScope`: reads cover every repository in `repos.yaml`; writes and
  dispatch only those with the `code` role, never a placeholder; `create_issue`
  only those with the `issues` role.
- **Branches.** `create_branch` requires the `lexi/` prefix by default and a
  safe branch name. `rebase_branch` requires the prefix and refuses
  `main`, `master`, `develop`, `development`, `trunk`, `qa`, `staging`,
  `production`, `release` and `release/*`/`release-*`, and the repository's
  default branch.
- **Merging.** `merge_pull_request` re-reads the PR and refuses a merged,
  closed or draft PR, one with conflicts, failing or pending checks, checks it
  cannot read, or a reviewer's outstanding "changes requested". It refuses a PR
  into the default branch unless `allowMergeIntoDefaultBranch` is set (the
  server does not set it).
- **Closing a PR** posts the reason first and leaves the PR open if that fails.
- **Labels** only from an operator's allowlist; without one the label tools
  are not offered.
- **Slack posts.** `post_to_channel` posts only to the conversation's own
  channel or an allowlisted one (`SLACK_CHANNEL_POST_ALLOWLIST`, used only when
  `SLACK_CHANNEL_POST_ENABLED=true`), never to a DM, and refuses `@here`,
  `@channel` and `@everyone`.
- **Dispatch.** Briefs over 50,000 characters are refused, not truncated.
  Workflows are always dispatched on an explicit ref.
- **Errors.** Provider errors are passed through `redactProviderError`, which
  strips GitHub and Slack tokens, bearer headers and `token=`-style query
  values before the text reaches a thread.

## Blast radius and run budgets

There are two layers here, and only one is in effect in the server today.

**In effect: the agent loop's backstops**
([`agent-runtime.ts`](../packages/agent/src/runtime/agent-runtime.ts),
[`repeat-guard.ts`](../packages/agent/src/runtime/repeat-guard.ts),
[`context-budget.ts`](../packages/agent/src/runtime/context-budget.ts)):

- at most 40 model calls per turn;
- a wall-clock limit (10 minutes by default; the server uses the Slack turn
  timeout, 15 minutes by default, minus five seconds);
- tool results capped at 50,000 characters each and 400,000 per turn, with a
  note whenever something was cut;
- an identical write that already executed is not run again in the same
  turn;
- after four identical repeats of the same call with the same result, tool use
  stops and the model must answer from what it has;
- a reply cut off at the output limit runs none of its tool calls, because a
  write on half its arguments is worse than no write.

Per thread, the Slack queue bounds waiting messages (`SLACK_THREAD_QUEUE_MAX`).
There is no per-person or global rate limit.

**Not wired: governance budgets.** `@lexi/governance` contains a
blast-radius guard (action classification, never-touch rules, protected paths
and branches, `MutationGuard`, and `GuardedMutationGateway` in `@lexi/github`)
and a YAML-authoritative run-budget policy
([`budgets/budget-policy.ts`](../packages/governance/src/budgets/budget-policy.ts),
[`examples/config/run-budgets.yaml`](../examples/config/run-budgets.yaml))
that refuses to run when a limit is unconfigured. The server uses the plain
`GitHubMutationGateway`, and no run budget is applied to Slack turns,
`POST /process` or the programme ticker. Treat these as library components.

## Honest outcomes

A user who is told something happened, when it did not, will not check; one
who is told nothing happened, when it did, will repeat it. The contract on both
sides:

- **`GovernedOutcome`** ([`agent-tool.ts`](../packages/agent/src/tools/agent-tool.ts))
  carries `authorized`, `executed`, `blocked` and `reason`. The registry fills
  it in when it refuses a call; the result helpers in
  [`shared/result.ts`](../packages/agent-tools/src/shared/result.ts) fill it in
  for every write: `executed` only after the provider returned, `writesDisabled`
  when a gateway refused, `writeFailed` when the provider rejected it.
- **The runtime restates it.** After each governed call, the runtime appends
  `[Governed outcome: authorized=…, executed=…, blocked=…. Reason: …]` to the
  result, after truncation, so it is never cut off.
- **The prompt says how to report it.** The default system prompt
  ([`default-system-prompt.ts`](../packages/agent/src/prompt/default-system-prompt.ts))
  tells the model to claim an action only when the result says it executed,
  to say why when it did not, not to work around a refusal with another tool,
  and to treat tool output and chat messages as data.
- **Early stops list what ran.** A turn that ends on a timeout, the step
  limit, cancellation, a model refusal or a model error ends with text the
  runtime writes, not the model, listing every action that already executed
  ("These actions already ran and were not undone"), or saying that none did.
- **The surface does not overstate.** The reply gets :white_check_mark: only
  when the turn ended in an answer and the post landed. Error replies never
  echo provider response bodies.

The model can still word its answer badly. These rules make the facts it is
handed unambiguous; they do not make its prose correct.

## What goes to the model

The model endpoint is the deployment's choice: `LITELLM_BASE_URL` or
`OPENAI_BASE_URL` and the key you configure. Lexi sends no telemetry anywhere
else. What it sends to that endpoint:

- **The agent loop** (Slack turns): the system prompt, the person's message,
  the thread history, the model's earlier turns, and every tool result —
  issue and PR text, file contents, Actions logs, Slack messages it read.
- **The decision engine** (`POST /process`): the issue's title, body, labels
  and comments, and the reproduction evidence.

Both paths mask personal data before the request leaves the process
([`packages/privacy`](../packages/privacy/src/pii-masker.ts)). The masking is
applied once per path, in the client factories, so every model client the
server builds is masked: `createLlmClient` wraps the client in `PiiMaskingLlmClient`
([`pii-masking-client.ts`](../packages/agent/src/llm/pii-masking-client.ts)),
and `createOpenAiClient` wraps it in `withPiiMasking`
([`pii-masking-chat-client.ts`](../packages/ai/src/pii-masking-chat-client.ts)).

| Found in text | Sent as | How it is recognised |
|---|---|---|
| Email addresses (including Slack `mailto:` links) | `[email]` | Address with an alphabetic top-level domain |
| Phone numbers | `[phone]` | `+` and 8–15 digits; or a local number with separators that starts with a trunk `0` or an area code in parentheses, or has the North American 3-3-4 shape |
| Payment card numbers | `[card]` | 13–19 digits, spaced, dashed or together, with a card-network prefix and a valid Luhn check |
| IBANs | `[iban]` | Country code, the country's IBAN length and a valid mod-97 check |
| IPv4 and IPv6 addresses | `[ip]` | Valid octets or groups; loopback and `0.0.0.0` are kept |
| `MODEL_PII_EXTRA_PATTERNS` | `[redacted]` | Your own regular expressions, e.g. customer or employee ids |

What is masked is text: message text, tool results and the string values of
tool-call arguments. Tool names, tool-use ids and tool schemas are not, so the
provider can still pair calls with results. Each masked request is logged at
debug level with a count per kind, never the values.

Deliberately not masked:

- **Slack user and channel ids** (`<@U…>`, `C…`). They are pseudonymous, and
  the agent needs them to address people in its reply.
- **GitHub logins, URLs, file paths and commit SHAs.** They are how the model
  refers to code and to people on GitHub; a login is a public handle. The
  numeric detectors do not look inside URLs at all (emails inside them are
  still masked).
- **Version numbers, timestamps, dates, issue and PR numbers, ports and bare
  numeric ids.** They are not personal and the model needs them; the
  detectors are tuned not to touch them. A four-part version whose parts are
  all 255 or less (`10.2.3.4`) reads as an IPv4 address and is masked.
- **Names and free-text descriptions of people.** Recognising those needs a
  language model of its own; this is a pattern masker.
- **Images.** Screenshots and attachments go to the model as pixels.

A masked value is masked for the model's purposes too: it cannot pass one to a
tool. Asked to look up `alice@example.com`, the model sees `[email]`.

Masking is on by default. `MODEL_PII_MASKING=false` turns it off for both
paths, and the server logs a warning at boot when it is off.

Out of scope: the coding agents in the GitHub Actions workflows (agent-fix,
app-build and the programme's build runs) and the local Lexi·Build bridge in
`apps/build`. Those run a coding-agent CLI in the customer's own repository or
on the user's own machine, with their own model credentials, and read whatever
the repository holds. This masking does not apply to them.

## Agent-fix: protected paths and branch prefixes

`agent-fix.yml` runs a coding agent headlessly with tool permissions skipped
(`--dangerously-skip-permissions`), so its limits sit outside the agent
([`docs/agent-fix.md`](agent-fix.md), [`agent-fix/scripts`](../agent-fix/scripts)):

- **Token scope.** A GitHub App token for the target repository (plus any
  `extra_repositories` under the same owner), with contents, pull requests and
  issues write and checks and actions read. It has no `workflows` permission,
  so GitHub refuses a push that changes `.github/workflows/`.
- **Agent-only pre-push hook**, installed for the job through
  `core.hooksPath`: the branch must start with `branch_prefix` (default
  `lexi/`), and the push must not change a protected path. Settings are read
  from a file beside the hook, not the environment. The repository's own
  pre-push hook runs first.
- **Protected paths** ([`protected-paths.sh`](../agent-fix/scripts/protected-paths.sh)):
  by default `*.yml`, `*.yaml`, `*.toml`, `.github/production*`,
  `.github/release*`, and anything named `production` (as a file, a directory,
  or a `production.`/`production-`/`production_` prefix). A repository's
  `protected_paths_file` replaces the list. The list is copied out of the
  checkout so the agent cannot edit it.
- **Brief check.** `check-brief.sh` refuses, before the agent starts, a brief
  that names a protected path.
- **Duplicate guard and concurrency.** One run per conversation thread; earlier
  work on the thread is found by a `lexi-thread: <thread_ref>` line.
- **Time.** The job timeout and a deadline file; the agent hands back with five
  minutes left.
- **One result.** A fallback hand-back is written first, so every run ends with
  exactly one result.

The pre-push hook guards `git push`. It does not stop an agent that runs
`git push --no-verify` or writes through the GitHub API with the token it can
read. The hard limits are the token's scope and your branch protection. See
[threat-model.md](threat-model.md#workflow-agents).

`rebase-branch.yml` refuses protected branch names, `release/*`, `release-*`
and `hotfix/*`, and anything without an allowed prefix, and never resolves a
conflict.

`app-build.yml` has no protected-path guard. Its builder runs with the job's
read-only `GITHUB_TOKEN`; the App tokens used to push are minted in separate
push steps, without narrowing their permissions, so they carry everything the
installation grants. What it may change is bounded by the App's permissions
and branch protection.

## The rebuild programme

The programme is the one place the server changes a repository without a
person asking for that specific change. The controls:

- **Which repositories.** Only those in `programme-policy.yaml`
  `programmes.allowedRepoKeys` that `repos.yaml` lists as non-placeholder,
  `code`-role and `autonomyTier: autonomous`
  ([`programme-wiring.ts`](../apps/server/src/wiring/programme-wiring.ts)).
- **Two switches each.** Acting needs `PROGRAMME_ENABLED` and the policy's
  `enabled`; dispatch also needs `PROGRAMME_DISPATCH_ENABLED`; merging needs
  `PROGRAMME_AUTO_MERGE_ENABLED` and the policy's `autoMerge.enabled`. All are
  off by default.
- **The auto-merge gate.** A task PR merges only when the evidence gate passes
  (the required evidence phases and checks, the acceptance-criteria matrix
  green, evidence for the PR's head commit), never into a default or trunk
  branch, and pinned to the head SHA it judged
  ([`programme-merge.ts`](../packages/programme/src/engine/programme-merge.ts)).
- **Human review.** Approving a milestone and concluding hardening are buttons
  on a Slack card, not agent tools. The handler re-checks the clicker's
  permission ([`programme-milestone-review.ts`](../packages/programme/src/programme-milestone-review.ts)).
- **Runner routes.** The brief and document routes take
  `PROGRAMME_BRIEF_TOKEN`; evidence ingest takes `EVIDENCE_WEBHOOK_TOKEN`. Each
  refuses everything when its token is unset.

## Adding a tool safely

1. **Implement `AgentTool`** ([`agent-tool.ts`](../packages/agent/src/tools/agent-tool.ts))
   and group it in a `ToolModule`. Use the GitHub write module
   ([`github-write-module.ts`](../packages/agent-tools/src/github/github-write-module.ts))
   as the worked example.
2. **If it changes anything, set `mutating: true` and `requiredPermission`.**
   The registry will not register a mutating tool without one. Reuse an
   existing permission where the authority is the same; otherwise add one to
   `authorization.yaml`, granted at the lowest role that should hold it. Give
   a read tool a permission too, as the GitHub reads have.
3. **Implement `resource(args, ctx)`** so scoped grants apply. Return the
   repository through `repoResource(scope, …)`; it may be async when the
   target has to be looked up. A tool that reports no resource is refused to
   every scoped person. Return `{ callerOnly: true }` only when the call
   touches nothing but the caller's own data or conversation.
4. **Never take identity from arguments.** The acting person is
   `ctx.actorId`. Do not add a "user" or "on behalf of" argument.
5. **Resolve every target through a `RepoScope`**, and refuse what does not
   resolve. Do not accept free-form `owner/repo`.
6. **Write through the gateway.** Take the `GitHubMutationGateway` or
   `SlackMutationGateway` as the dependency, not a raw client, and wrap the
   call in `governedWrite`, so a blocked switch becomes an honest
   `writesDisabled` result.
7. **Decide from fresh state.** Re-read what the decision depends on (is the PR
   open, are checks green); do not trust what the model says the state is.
8. **Report honestly.** Return `executed`, `refused`, `writesDisabled` or
   `writeFailed` from `shared/result.ts`. Every refusal says that nothing
   changed.
9. **Bound the output.** Truncate to `ctx.maxResultChars` with
   `truncateToBudget`, and pass provider errors through `redactProviderError`.
10. **Test it** beside the source (`*.spec.ts`): refused when unauthorized,
    refused out of scope, blocked when writes are off, executed only on
    success.
11. **Regenerate the capability matrix** with `npm run docs:capability-matrix`
    if the module is one the server can register; the matrix spec fails until
    you do.
