# agent-fix and rebase-branch

Someone reports a bug in a Slack thread and asks Lexi to fix it. A coding agent
investigates in your repository, files or reuses an issue, opens a fix pull
request, waits for your real CI, and ends with one result: shipped, or handed
back to a person with what it found. Lexi reads that result back into the
thread. This page sets up a repository for that, and for keeping the agent's
pull requests rebased on their base branch.

Two reusable GitHub workflows that let Lexi hand a bug report from a chat
thread to a coding agent, and keep the resulting pull request up to date.

| Workflow | What it does | Result |
|---|---|---|
| [`agent-fix.yml`](../.github/workflows/agent-fix.yml) | Investigates the report, files an issue, fixes it on a branch, opens a PR, waits for real CI | `SHIPPED` or `HANDBACK` |
| [`rebase-branch.yml`](../.github/workflows/rebase-branch.yml) | Rebases one agent branch onto its base and force-pushes with lease | `REBASED`, `ALREADY_CURRENT`, `CONFLICT` or `HANDBACK` |

Neither workflow talks to chat. Lexi dispatches them, reads the result, and
relays it to the thread.

## Set up a repository

1. **Create a separate workflow App.** Do not reuse the App Lexi's server
   uses: the agent can read every token this App mints, so it must hold only
   what the agent needs. Give it Contents, Pull requests and Issues: read and
   write; Checks and Actions: read; and **no Actions write and no Workflows
   permission**. Install it only on the repositories the agent works on. A
   `GITHUB_TOKEN` will not do: a pull request it opens triggers no workflows,
   so CI never runs.
2. **Add secrets** to the repository: `LEXI_APP_ID` and `LEXI_APP_PRIVATE_KEY`
   (the workflow App's), and `LEXI_MODEL_API_KEY`.
3. **Copy the callers** from [`examples/workflows/`](../examples/workflows/)
   into `.github/workflows/`, and uncomment the inputs your project needs
   (at least `setup_command`).
4. Optionally add **`.lexi/fix.md`** with project-specific instructions for the
   agent (how to run tests, which areas are fragile), and
   **`.lexi/protected-paths`** to replace the default protected list.

Pin `uses:` to a tag or commit SHA, and set `lexi_ref` to the same ref, so the
workflow and the scripts it checks out always match.

## How a run goes

1. A fallback hand-back and a deadline are written first, so the run always
   ends with exactly one result even if setup fails. They, and every other
   file the job keeps (the request, the token, the result, the transcript), go
   in a directory created for this job alone under `RUNNER_TEMP`
   (`$LEXI_JOB_DIR`, readable by the runner's user only), never at a fixed
   path under `/tmp`. See [Running several at once](#running-several-at-once).
2. The request is validated (`normalize-payload.sh`). `brief` and `requester`
   are required; resume numbers must be positive integers.
3. The **duplicate guard** looks for earlier work on the same thread by the
   exact line `lexi-thread: <thread_ref>` in issue and PR bodies. One open PR
   means "continue that PR". Several open PRs, or a leftover issue with no PR,
   stop the run.
4. A token is minted (`gh-token-mint.sh`) and written to a file in the job's
   directory (mode 600) that git and `gh` read through a credential helper and
   a shim; nothing caches it. The helper is set in a git config file of the
   job's own (`GIT_CONFIG_GLOBAL`, which needs git 2.32 or newer and includes
   the user's `~/.gitconfig`), not in `~/.gitconfig` itself. App
   tokens last an hour and a run can last two, so the agent runs in
   **segments** of at most `segment_minutes` (default 50, at most 55). Before
   each segment a step of its own mints a fresh token and revokes the previous
   one; the segment then resumes the same conversation (`claude --resume`).
   The App private key is only ever in those minting steps, which run while
   nothing of the agent's is alive.
5. The **push guards** are installed (see below) and `check-brief.sh` refuses a
   brief that names a protected file before any model time is spent.
6. The agent runs the `fix` skill ([`skills/fix/SKILL.md`](../skills/fix/SKILL.md)),
   or the repository's own `.claude/skills/fix` if it has one. Each segment
   ends by stopping every process the agent started, however it detached
   (`agent-sandbox.sh`), and discarding anything it wrote to the step's
   `GITHUB_ENV`, `GITHUB_PATH` or `GITHUB_OUTPUT`. If a process cannot be
   stopped the run hands back and no further token is minted.
7. The result is checked (`check-output-contract.sh`: exactly one non-empty
   announcement or hand-back), published, redacted and uploaded.
8. If `evidence_command` is set and a PR exists, it runs best-effort and its
   screenshots are redacted and uploaded as `agent-fix-visuals-<run_id>`.

## Reading the result

- The `result` output of the reusable workflow: `shipped` or `handback`.
- The job log, between fixed markers:

  ```text
  ===== AGENT_FIX_RESULT: SHIPPED =====
  Fixed the empty cart total. PR: https://github.com/acme/web/pull/123
  ===== END_AGENT_FIX_RESULT =====
  ```

- The artifact `agent-fix-<run_id>`, holding `announcement.txt` or
  `handback.txt`, the agent's investigation notes, and its full transcript
  (`run.jsonl`). The transcript can quote source code and issue text, so it
  follows the repository's artifact retention and access rules.

  `::add-mask::` hides a secret from the log, not from a file, so every
  uploaded file is redacted in place first by
  [`redact-output.mjs`](../app-build/redact-output.mjs) (sealed with the other
  scripts before the agent runs): by value for the model key and the current
  token, in raw, JSON-escaped and URL-encoded forms, and by shape for every
  other GitHub token, model key, Slack token or webhook, private key and
  credential in a URL. A screenshot that holds one is deleted. If redaction
  fails, nothing is uploaded.

`rebase-branch.yml` prints `REBASE_RESULT: <value>` and sets the `result`
output; on `CONFLICT` it lists the conflicting files in the step summary and
pushes nothing.

## What bounds the agent

The agent runs headlessly with tool permissions skipped. It can run any command
the runner allows, including reading the GitHub token file and calling the API
directly, so treat it as able to do anything the token can do. The limits that
actually hold are the ones outside the job:

- **Token scope.** The App token covers this repository (plus
  `extra_repositories`) and exactly the permissions the workflow names:
  contents, pull requests and issues write, checks and actions read. Every
  minting step sets them, and `gh-token-mint.sh` refuses to mint without a
  permission set, because GitHub would otherwise grant everything the
  installation has. It lasts at
  most an hour; a long run mints one per segment, each mint revokes the token
  before it, and the last one is revoked when the job ends. Every token is
  masked in the log.
- **No private key in reach.** The key is passed only to the minting steps.
  The scripts that handle it are sealed (archived with their digest recorded)
  before any repository or agent code runs, and each minting step checks the
  digest and unpacks a fresh copy, so an edited script is refused. The job's
  shell skips `~/.bashrc` and `BASH_ENV`, and the minting script resets `PATH`
  and `HOME`, so nothing the agent planted runs while the key is in memory.
  The limits: the sweep needs Linux `/proc`; on a GitHub-hosted runner the
  agent can use passwordless `sudo` to start a process as another user, which
  the sweep cannot stop. See [threat-model.md](threat-model.md).
- **Branch protection** on the repository, which the token cannot change. This
  is the control that keeps agent work off protected branches: require pull
  requests and reviews on your default branch.
- **The App's permissions.** Grant no `Workflows` permission, so the token
  cannot change files under `.github/workflows/` whatever the agent tries, and
  no Actions write, so it cannot start other workflows.

Two further guards keep a well-behaved agent on track. They are not a security
boundary, because the agent can bypass them (`git push --no-verify`, or the API):

- **Agent-only pre-push hook.** Installed through `core.hooksPath` for the
  job only, so human developers are unaffected. It refuses any branch that does
  not start with `branch_prefix` (default `lexi/`) and any push that changes a
  protected path. It reads its settings from a file beside itself rather than
  from the environment. The repository's own `.githooks/pre-push` still runs
  first.
- **Protected paths.** By default: every `*.yml`, `*.yaml` and `*.toml` file
  (workflows, deployment manifests, dependency manifests), `.github/production*`
  and `.github/release*`, and anything named `production`. A repository's
  `.lexi/protected-paths` replaces the list. The definition lives in one file,
  [`protected-paths.sh`](../agent-fix/scripts/protected-paths.sh), shared by the
  hook and the brief check.
- **Time.** The job timeout (`budget_minutes`), and a deadline file the agent
  checks before each wait; it hands back with five minutes left.
- **Concurrency.** One run per thread at a time; a second request waits.

The rebase workflow refuses protected branch names, release and hotfix
branches, and anything without an allowed prefix. It never resolves a conflict;
that is a code change, which goes back through agent-fix.

## Running several at once

Two calls can run side by side in two ways: on a self-hosted runner host where
several runners work as one user, or within one run when the caller fans the
workflow out (a matrix, or two jobs that both call it).

- **Files.** Each job keeps its files in a directory created for it under
  `RUNNER_TEMP` and its git credential helper in a config file there, so one
  job does not read another's token, overwrite its result or answer its git.
  The agent is told the directory in its prompt, and has it as
  `$LEXI_JOB_DIR`; a repository's own copy of the `fix` skill that still names
  files under `/tmp` keeps working, because the prompt maps those names to the
  directory. This removes the shared, guessable paths. It does not make
  same-user runners a boundary: a process can still read any file of its own
  user that it goes looking for, so jobs that must not trust each other need
  separate users or ephemeral runners.
- **Artifacts.** Artifact names are shared by a whole run. `agent-fix-<run_id>`
  and `agent-fix-visuals-<run_id>` are therefore the same for every call in
  one run: the second upload fails and that call's files are lost. A caller
  that fans out sets `artifact_suffix` to a different value per call (for
  example `-web`, `-api`), which is appended to both names. The result is then
  read from the job log or the `result` output: a dispatcher that looks for
  the artifact by its plain name does not find a suffixed one.
- **Rebase.** `rebase-branch.yml` keeps its result the same way and uploads no
  artifact.

## Inputs worth knowing

All inputs are documented in the workflow file. The ones most repositories set:

| Input | Default | Notes |
|---|---|---|
| `setup_command` | empty | Installs dependencies, e.g. `npm ci`. |
| `runs_on` | `"ubuntu-latest"` | JSON, so a runner group or label list also works. |
| `budget_minutes` | `120` | The last ten are reserved for publishing. |
| `model` / `model_base_url` | `claude-sonnet-5-5` / provider | Set `model_base_url` to route through a gateway. |
| `branch_prefix` | `lexi/` | Must match what your dispatcher and rebase caller expect. |
| `extra_repositories` | empty | Same-owner repositories the token also covers, e.g. submodules. |
| `evidence_command` | empty | Writes screenshots to `$EVIDENCE_DIR`. Never fails the run. Its processes are stopped like the agent's. |
| `segment_minutes` | `50` | Agent time per token, 10 to 55. A run gets at most seven segments. |
| `claude_code_version` | `2.1.319` | Exact Claude Code version installed. Change it deliberately. |
| `artifact_suffix` | empty | Set only when one run calls the workflow more than once; see [Running several at once](#running-several-at-once). |

## Testing the scripts

The helper scripts are plain bash (3.2-compatible, so they run on macOS) and
have tests that run them as subprocesses:

```bash
npx vitest run agent-fix
```
