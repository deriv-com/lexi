#!/usr/bin/env bash
#
# usage: run-agent-segment.sh <segment> <last segment>
#
# Runs one segment of the agent-fix coding agent, then stops everything it
# left running.
#
# WHY SEGMENTS
#   A GitHub App installation token lasts an hour and a run can last several.
#   The token is minted in its own step just before each segment, with the App
#   private key in that step only, and a segment is never longer than
#   SEGMENT_MINUTES (at most 55), so the token outlives it. Segment 1 starts the
#   conversation; later segments resume it (`claude --resume`) with a short
#   note that only the credentials changed.
#
# WHAT A SEGMENT ENDS WITH, whatever happened
#   1. Every process of this user that started after this script did is
#      stopped (agent-sandbox.sh), however it detached.
#   2. GITHUB_ENV, GITHUB_PATH and GITHUB_OUTPUT are truncated, so nothing the
#      agent wrote there reaches a later step.
#   3. Only then does this script write AGENT_CONTINUE for the workflow.
#   If a process survives, the step fails and no further token is minted.
#
# The workflow runs this from a copy whose digest it recorded before any agent
# or repository code ran. The body is one function, so bash has read all of it
# before the agent starts, and an edit to the file during the run changes
# nothing.
#
# Environment (from the workflow step): MODEL, MODEL_BASE_URL, MODEL_API_KEY,
# MAX_TURNS, SKILL, BRANCH_PREFIX, SEGMENT_MINUTES, and LEXI_JOB_DIR: the
# directory the workflow created for this job alone. Nothing is read from or
# written to a fixed path under /tmp, which every job on a self-hosted runner
# host shares.
#
# Files, all in $LEXI_JOB_DIR: agent-fix-deadline-epoch (read), ctx.json (read
# by the agent), announcement.txt and handback.txt (the result), run.jsonl (the
# transcript, appended), agent-fix-session (the conversation to resume).

main() {
  set -uo pipefail
  local N=${1:?segment number} LAST=${2:?last segment number}
  local HERE MARK
  HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  # shellcheck source=agent-sandbox.sh
  source "$HERE/agent-sandbox.sh"
  # Before anything is started: every later process of this user is the agent's.
  MARK=$(sandbox_mark)

  local RUN="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
  # No fallback to a shared path: without the job's own directory there is no
  # request to read and nowhere safe to put a result.
  local JOB=${LEXI_JOB_DIR:-}
  if [ -z "$JOB" ] || [ ! -d "$JOB" ]; then
    echo "::error::run-agent-segment: LEXI_JOB_DIR is not set to this job's directory." >&2
    finish 1 false
    return
  fi
  local SESSION_FILE=$JOB/agent-fix-session
  local SEG_LOG=$JOB/agent-fix-segment.jsonl
  local DEADLINE REMAINING SEG LIMIT RC=0 CONTINUE=false SID="" STOP_RC=0

  has_result() { [ -s "$JOB/announcement.txt" ] || [ -s "$JOB/handback.txt" ]; }
  handback() { # text — only when the agent wrote no result of its own
    has_result && return 0
    printf '%s\nRun: %s\n' "$1" "$RUN" > "$JOB/handback.txt"
  }

  DEADLINE=$(cat "$JOB/agent-fix-deadline-epoch" 2>/dev/null || echo 0)
  case "$DEADLINE" in ''|*[!0-9]*) DEADLINE=0 ;; esac
  REMAINING=$(( DEADLINE - $(date +%s) ))
  SEG=$(( ${SEGMENT_MINUTES:-50} * 60 ))

  if [ "$N" = 1 ]; then
    rm -f "$JOB/announcement.txt" "$JOB/handback.txt"
  fi

  if [ "$REMAINING" -lt 60 ]; then
    if [ "$N" = 1 ]; then
      handback "Agent-fix setup used the whole budget before the agent could start; check runner and setup time, then retry."
    else
      handback "Agent-fix ran out of time before the agent wrote a result. Any branch or PR it pushed is still there; read the agent log before retrying."
    fi
    finish 1 false
    return
  fi
  LIMIT=$SEG
  [ "$REMAINING" -lt "$LIMIT" ] && LIMIT=$REMAINING

  if [ -n "${MODEL_BASE_URL:-}" ]; then
    export ANTHROPIC_BASE_URL="$MODEL_BASE_URL"
    export ANTHROPIC_AUTH_TOKEN="$MODEL_API_KEY"
  else
    export ANTHROPIC_API_KEY="$MODEL_API_KEY"
  fi
  unset MODEL_API_KEY
  export LEXI_AGENT_SCRIPTS="${GITHUB_WORKSPACE}/.lexi-agent/agent-fix/scripts"

  # The skill names its files under /tmp; the prompt says where they are for
  # this job, so a repository's own copy of the skill keeps working unchanged.
  local WHERE="Your working files for this run are in the directory ${JOB} (also in \$LEXI_JOB_DIR), not in /tmp: wherever the skill or these instructions name a file /tmp/<name>, use ${JOB}/<name> instead."
  local PROMPT
  local -a RESUME=()
  if [ "$N" = 1 ]; then
    PROMPT="/${SKILL} ${WHERE} Read ${JOB}/ctx.json first. 'brief' is a symptom or a request, not a specification: investigate and localise the cause before writing code. Follow the repository's CLAUDE.md or AGENTS.md, and .lexi/fix.md if it exists. Branches are always '${BRANCH_PREFIX}<topic>'; issues are always unassigned. If resume_pr_number is set, check out that PR and continue on its branch; do not open a second PR. If resume_issue_number is set, reuse that issue and keep its lexi-thread anchor instead of creating another. Otherwise file the issue right after investigating, before any code. Open the PR with 'Closes #N' only when resume_pr_number is empty, then wait for real CI with 'gh pr checks'; never call a PR green on your own local run. Fix failures your change caused, with at most two CI-fix iterations; re-run a suspected flake once before treating it as real, and disclose any tolerated flake in the result. Before each wait or fix iteration, read ${JOB}/agent-fix-deadline-epoch and hand back when fewer than five minutes remain. Write exactly one of ${JOB}/announcement.txt or ${JOB}/handback.txt and verify it with \$LEXI_AGENT_SCRIPTS/check-output-contract.sh before exiting. Run nothing in the background that you expect to outlive your turn: the workflow stops every process you started when you exit or are paused."
  else
    SID=$(cat "$SESSION_FILE" 2>/dev/null || true)
    if [ -z "$SID" ]; then
      handback "Agent-fix could not resume the agent's conversation after refreshing its credentials, so it stopped. Any branch or PR it pushed is still there."
      finish 1 false
      return
    fi
    PROMPT="You were paused so the workflow could give you fresh GitHub credentials; nothing else changed, and git and gh pick them up on their own. Processes you had running were stopped: start again anything you still need. Carry on with the same task from where you stopped, under the same rules: your working files are still in ${JOB}, read ${JOB}/agent-fix-deadline-epoch before each wait or fix iteration and hand back when fewer than five minutes remain, and write exactly one of ${JOB}/announcement.txt or ${JOB}/handback.txt, verified with \$LEXI_AGENT_SCRIPTS/check-output-contract.sh, before exiting."
    RESUME=(--resume "$SID")
  fi

  echo "Agent segment ${N} of at most ${LAST}: up to $(( LIMIT / 60 )) minutes."
  : > "$SEG_LOG"
  # setsid: the agent leads its own session, so a stray terminal signal to the
  # step does not reach it half-way. The sweep afterwards does not rely on it.
  local -a DETACH=()
  if command -v setsid >/dev/null 2>&1; then DETACH=(setsid -w); fi
  ${DETACH[@]+"${DETACH[@]}"} timeout --signal=TERM --kill-after=30s "${LIMIT}s" claude -p "$PROMPT" \
    ${RESUME[@]+"${RESUME[@]}"} \
    --dangerously-skip-permissions \
    --model "$MODEL" \
    --max-turns "$MAX_TURNS" \
    --verbose \
    --output-format stream-json < /dev/null | tee -a "$JOB/run.jsonl" "$SEG_LOG"
  RC=${PIPESTATUS[0]}

  # Everything that runs a command from PATH happens before the sweep: a
  # binary the agent planted on PATH would otherwise start after it.
  SID=$(jq -R -r 'fromjson? | .session_id // empty' "$SEG_LOG" 2>/dev/null | tail -n 1)
  if [ -n "$SID" ]; then printf '%s' "$SID" > "$SESSION_FILE"; fi

  if has_result; then
    CONTINUE=false
  elif { [ "$RC" -eq 124 ] || [ "$RC" -eq 137 ]; } && [ "$LIMIT" -eq "$SEG" ] && [ -n "$SID" ]; then
    # The segment's own limit ended it, with run time left: go on.
    if [ "$N" -ge "$LAST" ]; then
      handback "Agent-fix used all ${LAST} agent segments without a result. Any branch or PR the agent pushed is still there; read the agent log before retrying."
    else
      CONTINUE=true
      RC=0
      echo "Segment ${N} reached its ${SEGMENT_MINUTES:-50}-minute limit; the next segment resumes after a fresh token."
    fi
  fi

  sandbox_stop "$MARK" || STOP_RC=$?
  if [ "$STOP_RC" -ne 0 ]; then
    handback "Agent-fix stopped: the agent left processes running that could not be stopped, so no further credentials were issued."
    finish 1 false
    return
  fi
  finish "$RC" "$CONTINUE"
}

finish() { # exit code, continue
  sandbox_reset_file_commands
  if [ -n "${GITHUB_ENV:-}" ]; then
    echo "AGENT_CONTINUE=$2" >> "$GITHUB_ENV"
  fi
  FINISH_RC=$1
}

FINISH_RC=1
main "$@"; exit "${FINISH_RC:-1}"
