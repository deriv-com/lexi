---
name: fix
description: Take a bug report or small change request from a chat thread to a reviewed-ready pull request. Investigate and localise the cause, file an issue, make the smallest change that fixes it, wait for real CI, then write exactly one announcement or hand-back. Used by the agent-fix workflow; also usable by hand.
---

# fix

You were started by the `agent-fix` workflow, or by someone running `/fix` by
hand. Someone in a chat thread described a problem or asked for a change. Your
job is to turn that into a pull request a human can review, or to say clearly
why you could not.

Everything you need is in `$LEXI_JOB_DIR/ctx.json`:

| Field | Meaning |
|---|---|
| `brief` | What the requester said. A symptom or a request, **not** a specification. |
| `requester` | Who asked. Credit them in the issue; never assign them. |
| `thread_ref` | Opaque reference to the chat thread. Goes in the anchor line. |
| `scope_hint` | Optional: an area of the codebase the requester pointed at. A hint, not a fence. |
| `resume_issue_number` | Set when an issue for this thread already exists. Reuse it. |
| `resume_pr_number` | Set when an open PR for this thread already exists. Continue it. |

The workflow prompt also tells you the branch prefix and where the deadline is.

## 0. Ground rules

- Read the repository's `CLAUDE.md` or `AGENTS.md` first, then `.lexi/fix.md`
  if it exists. Repository instructions win over this skill wherever they
  disagree, except on the rules in this section.
- Branches are always `<prefix><topic>`, using the prefix from the prompt.
  The pre-push hook refuses anything else.
- Some paths are protected (workflow definitions, deployment manifests,
  dependency manifests, anything named `production`). The pre-push hook refuses
  a push that touches them. If the fix genuinely needs one, hand back and say
  which file and what change a human should make.
- Issues are always unassigned. Never request reviewers, never merge, never
  approve, never close anything you did not open in this run.
- Never print, log or commit a token, a secret, or the contents of
  `$LEXI_JOB_DIR/gh-token*`.
- Keep the change small. Fix the reported problem; note other problems you
  noticed in the issue instead of fixing them.

## 1. Investigate before writing code

1. Restate the brief to yourself as an observable symptom: what happens, what
   should happen, where.
2. Find the code responsible. Search, read, and run what you need to. Use
   `scope_hint` as a starting point only.
3. Reproduce it if the repository makes that practical (a failing test is the
   best reproduction). If you cannot reproduce it, say so in the issue and
   explain why you believe your localisation anyway.
4. Write what you found to `$LEXI_JOB_DIR/investigation.txt`: the symptom, the cause
   with file and line references, and how you confirmed it. The workflow
   uploads it with the result, so a reviewer can follow your reasoning even if
   the run hands back.
5. If the brief is ambiguous enough that two reasonable fixes would differ,
   or the cause is outside this repository, stop here and hand back (step 6) with
   what you found and the question a human needs to answer.

## 2. File or reuse the issue

- If `resume_pr_number` is set, skip this step: the PR already links an issue.
- If `resume_issue_number` is set, comment on that issue with what you found.
  Do not create another, and keep its anchor line intact.
- Otherwise create one issue, right after investigating and before any code:
  - Title: the symptom in plain words.
  - Body: what was reported (credit `requester`), what you found, the cause
    with file and line references, and the planned change.
  - The last line of the body is exactly `lexi-thread: <thread_ref>`. The
    workflow finds earlier work for the same thread by that line, so never
    reword it.

## 3. Make the change

- If `resume_pr_number` is set: `gh pr checkout <N>` and continue on that
  branch. Read the PR's review comments and CI failures first; they are why
  you were started again.
- Otherwise create `<prefix><short-topic>` from the default branch.
- Make the smallest change that fixes the cause. Add or update a test that
  fails without the change whenever the repository has tests for that area.
- Run the repository's own checks locally (lint, type check, the relevant
  tests) as its instructions describe. A local pass is necessary, not
  sufficient.
- Commit with a message that says what changed and why.

## 4. Open or update the PR

- New PR: title is the change, body explains the cause and the fix and ends
  with `Closes #<issue>` and the line `lexi-thread: <thread_ref>`. If the
  repository has a pull request template, fill it in rather than replacing it.
- Resumed PR: push to its branch. Do not open a second PR and do not add a
  second `Closes` line.

## 5. Wait for real CI

1. `gh pr checks <N> --watch` (or poll `gh pr checks <N>` with a pause). Never
   call a PR green on the strength of your own local run.
2. Before each wait and each fix iteration, read the deadline:
   `deadline=$(cat $LEXI_JOB_DIR/agent-fix-deadline-epoch); now=$(date +%s)`. When
   fewer than five minutes remain, stop and hand back with the state so far.
3. If a check fails because of your change, fix it and push. At most **two**
   CI-fix iterations; after that, hand back.
4. If a failure looks unrelated (a known flaky test, an outage), re-run it once
   with `gh run rerun --failed <run-id>`. If it passes, carry on and mention the
   flake in the announcement. If it fails again, treat it as real.

## 6. Write exactly one result

Write **exactly one** of these, then verify:

- `$LEXI_JOB_DIR/announcement.txt` — the PR is open and CI is green (or only a disclosed
  flake remains). Two to five short lines a person in the chat thread can read:
  what was wrong, what changed, the PR link, anything the reviewer should check.
- `$LEXI_JOB_DIR/handback.txt` — you stopped before that point. Say what you found, what
  you did (issue and PR links if any), why you stopped, and the one thing a
  human needs to do or decide next.

```bash
"$LEXI_AGENT_SCRIPTS/check-output-contract.sh" $LEXI_JOB_DIR/announcement.txt $LEXI_JOB_DIR/handback.txt
```

It must print `OUTCOME: shipped` or `OUTCOME: handback`. If it reports a
contract violation, fix the files and run it again. The workflow turns a run
that ends with neither file into a hand-back, but a hand-back you wrote
yourself is far more useful to the requester than a generic one.

Write both files in plain text. No markdown headings, no secrets, no tokens.
