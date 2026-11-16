#!/usr/bin/env bash
# usage: segment.sh <segment-number>
#
# Runs one segment of the builder session.
#
# Phases. With LEXI_PHASES=true the app is built in four phases — intent, spec,
# plan, build — recorded in <app dir>/docs/build/PHASE. The planning phases run
# on LEXI_PLAN_MODEL, each in a fresh conversation, and end with a phase gate
# (gate.sh): an independent read-only reviewer that advances PHASE on a pass
# and hands its findings back on a fail. The build phase runs on LEXI_MODEL.
# With LEXI_PHASES unset or false there is only the build phase, as before.
#
# Conversations. In the build phase, with LEXI_RESUME_SEGMENTS=true, later
# segments resume the same conversation (`claude --resume`); otherwise every
# segment starts fresh from the files. A resumed conversation re-reads its
# whole history on every turn, and that history was most of the cost of a
# session (tens of millions of cached tokens per segment), so fresh is the
# default for callers that set the input.
#
# The agent writes to a file and a background tailer renders it: a renderer in
# the agent's pipeline that dies would kill the agent with EPIPE.
#
# Transport. The rendered prompt reaches `claude -p` on stdin, never as an
# argument: a prompt over ~128 KB passed as one argument exceeds the
# kernel's per-argument limit and the builder never starts. The large prompt
# parts (feedback, assessment, ...) reach the renderer as files
# (PROMPT_<NAME>_FILE), so no process carries them in its environment either.
#
# Feedback. feedback.sh prepares one bounded batch per segment. The batch is
# snapshotted with the prompt, and feedback-cursor.sh commits exactly that
# snapshot, and only once the builder demonstrably processed it (it started,
# took at least one turn, and finished, or ran into the segment's deadline).
# Any other outcome leaves the cursor where it was, so the same comments are
# delivered again. When the cursor could not be saved, the segment writes
# $RUNNER_TEMP/feedback-cursor-error (the loop stops on it) and still exits 0,
# so the session's work is pushed.
#
# Containment. The builder runs as the runner's own user with permissions
# skipped, and later steps of the job hold the GitHub App private key (to mint
# push tokens) and the Slack webhook. So a segment ends, on every path, by:
#   - stopping every process of this user started since the segment began
#     (agent-sandbox.sh), however it detached: dev servers, the prototype the
#     builder could edit, anything left by `nohup` or `setsid`;
#   - putting back .git/config, .git/hooks and the user's git config as they
#     were before the builder, so a later `git push` runs no hook it planted;
#   - truncating GITHUB_ENV, GITHUB_PATH and GITHUB_OUTPUT, so nothing it wrote
#     there reaches a later step, then writing LEXI_SEGMENT_PHASE (the phase
#     the next segment runs in; the workflow gives staging credentials only to
#     build-phase segments).
# If something cannot be stopped, the segment exits 1 and the workflow mints no
# further token in this job. The workflow runs this script from a copy it
# verified, and the body is one function, so bash has read all of it before
# the builder starts. After the builder, the tools are unpacked again from the
# verified archive (LEXI_TOOLS_SHA) before the gate or the cursor uses them.
# The gate's Slack message is only queued here ($RUNNER_TEMP/slack-outbox); a
# later step that the builder never shares posts it.
main() {
set -uo pipefail

N="$1"
TOOLS="$RUNNER_TEMP/app-build"
STREAM="$RUNNER_TEMP/segment-$N.jsonl"
SESSION_FILE="$RUNNER_TEMP/claude-session-id"
PROMPT_OUT="$RUNNER_TEMP/prompt-segment-$N.md"
DOCS_DIR="${LEXI_DOCS_DIR:-$LEXI_APP_DIR/docs/build}"
BUILD_DOCS="$GITHUB_WORKSPACE/$DOCS_DIR"
FLEET_DIR="$RUNNER_TEMP/fleet"
PHASE_FILE="$BUILD_DOCS/PHASE"
INPUTS="$RUNNER_TEMP/prompt-inputs-$N"
FEEDBACK_DIR="$RUNNER_TEMP/feedback"
BUILDER_UMASK="$(umask)"
umask 077
AGENT_PID=""
RENDER_PID=""
SEG_RC=0
SWEEP_FAILED=""
GIT_SNAPSHOT="$RUNNER_TEMP/git-snapshot-$N"
GIT_SNAPSHOT_SUM=""
# Absolute paths, taken now: the builder can put its own tools on PATH later.
SNAP_TAR="$(command -v tar || true)"
SNAP_SHA="$(command -v sha256sum || true)"
if [ -z "$SNAP_SHA" ] && command -v shasum > /dev/null; then SNAP_SHA="$(command -v shasum) -a 256"; fi
rm -rf "$GIT_SNAPSHOT"
# shellcheck source=../agent-fix/scripts/agent-sandbox.sh
source "$TOOLS/agent-sandbox.sh"
# Before anything is started: every later process of this user is the builder's.
MARK="$(sandbox_mark)"

# The tools are unpacked again from the archive the workflow sealed before any
# builder ran (outside the workflow, with no LEXI_TOOLS_SHA, they are used as
# they are).
reload_tools() {
  [ -n "${LEXI_TOOLS_SHA:-}" ] || return 0
  if ! echo "${LEXI_TOOLS_SHA}  ${RUNNER_TEMP}/app-build.tgz" | /usr/bin/sha256sum -c --quiet - > /dev/null 2>&1; then
    echo "::error::Segment $N: the sealed builder tools changed during the segment; nothing more runs from them."
    return 1
  fi
  /usr/bin/rm -rf "$TOOLS" && /usr/bin/mkdir -p "$TOOLS" && /usr/bin/tar -xzf "$RUNNER_TEMP/app-build.tgz" -C "$TOOLS"
}

# Git configuration the builder could use to run a command in a later step: a
# hook, core.fsmonitor, a credential helper, a filter. Put back as it was.
git_snapshot() {
  local G="$GITHUB_WORKSPACE/.git"
  rm -rf "$GIT_SNAPSHOT"
  mkdir -p "$GIT_SNAPSHOT"
  [ -d "$G" ] || return 0
  [ -f "$G/config" ] && cp -p "$G/config" "$GIT_SNAPSHOT/repo-config"
  [ -d "$G/hooks" ] && tar -cf "$GIT_SNAPSHOT/hooks.tar" -C "$G" hooks
  [ -f "$HOME/.gitconfig" ] && cp -p "$HOME/.gitconfig" "$GIT_SNAPSHOT/user-config"
  [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/git/config" ] && cp -p "${XDG_CONFIG_HOME:-$HOME/.config}/git/config" "$GIT_SNAPSHOT/xdg-config"
  touch "$GIT_SNAPSHOT/taken"
  # The snapshot sits in RUNNER_TEMP, which the builder can write. Its digest
  # is kept in this shell's memory, which the builder cannot reach, and
  # checked before anything is put back.
  GIT_SNAPSHOT_SUM="$(snapshot_sum)"
}
snapshot_sum() {
  # Tools resolved when the script started, before the builder ran
  # (SNAP_TAR, SNAP_SHA). tar records names, modes, sizes and contents.
  [ -n "$SNAP_TAR" ] && [ -n "$SNAP_SHA" ] || { echo unavailable; return; }
  "$SNAP_TAR" -cf - -C "$GIT_SNAPSHOT" . 2>/dev/null | $SNAP_SHA | { read -r SUM _; echo "$SUM"; }
}
restore_one() { # saved copy, live path
  if [ -f "$1" ]; then
    cmp -s "$1" "$2" 2>/dev/null || { rm -f "$2"; cp -p "$1" "$2"; echo "::warning::Segment $N: put back $2, which the builder changed."; }
  elif [ -e "$2" ] || [ -L "$2" ]; then
    rm -f "$2"; echo "::warning::Segment $N: removed $2, which the builder created."
  fi
}
git_restore() {
  local G="$GITHUB_WORKSPACE/.git"
  [ -n "${GIT_SNAPSHOT_SUM:-}" ] || return 0
  if [ ! -e "$GIT_SNAPSHOT/taken" ] || [ "$(snapshot_sum)" != "$GIT_SNAPSHOT_SUM" ]; then
    echo "::error::Segment $N: the saved git configuration changed during the segment, so it cannot be put back safely; nothing more runs with a token."
    return 1
  fi
  if [ -d "$G" ]; then
    restore_one "$GIT_SNAPSHOT/repo-config" "$G/config"
    rm -rf "$G/hooks"
    if [ -f "$GIT_SNAPSHOT/hooks.tar" ]; then tar -xf "$GIT_SNAPSHOT/hooks.tar" -C "$G"; fi
  fi
  restore_one "$GIT_SNAPSHOT/user-config" "$HOME/.gitconfig"
  restore_one "$GIT_SNAPSHOT/xdg-config" "${XDG_CONFIG_HOME:-$HOME/.config}/git/config"
}

# Stops everything this segment started. Safe to call more than once.
contain() {
  if [ -n "${RENDER_PID:-}" ]; then pkill -P "$RENDER_PID" 2>/dev/null; kill "$RENDER_PID" 2>/dev/null; RENDER_PID=""; fi
  sandbox_stop "$MARK" || SWEEP_FAILED=1
}

next_phase() {
  local P=build
  if [ "${LEXI_PHASES:-false}" = "true" ]; then
    P="$(tr -d '[:space:]' < "$PHASE_FILE" 2>/dev/null || true)"
    case "$P" in intent|spec|plan|build) ;; *) P=intent ;; esac
  fi
  printf '%s' "$P"
}

cleanup() {
  local RC=$? NEXT_PHASE
  if [ -n "${RENDER_PID:-}" ]; then pkill -P "$RENDER_PID" 2>/dev/null; kill "$RENDER_PID" 2>/dev/null; RENDER_PID=""; fi
  git_restore || SWEEP_FAILED=1
  # A committed batch's reference files are done with; an unprocessed batch
  # keeps them for its retry.
  if [ -s "$FEEDBACK_DIR/batch-consumed-$N.json" ]; then
    jq -r '.keys[]?' "$FEEDBACK_DIR/batch-consumed-$N.json" 2>/dev/null | while IFS=: read -r KIND ID; do
      case "$KIND:$ID" in
        comment:*|review:*|inline:*) [[ "$ID" =~ ^[0-9]+$ ]] || continue ;;
        *) continue ;;
      esac
      rm -f "$GITHUB_WORKSPACE/.lexi-feedback/ref-$KIND-$ID.md" "$GITHUB_WORKSPACE/.lexi-feedback/ref-$KIND-$ID.folded.md"
    done
  fi
  rm -rf "$INPUTS"
  NEXT_PHASE="$(next_phase)"
  # Last, with builtins only from here on (a command found on PATH could be one
  # the builder planted, and would start after the sweep): stop everything,
  # drop what the builder wrote to the step's file commands, and only then
  # give the workflow the next segment's phase.
  sandbox_stop "$MARK" || SWEEP_FAILED=1
  sandbox_reset_file_commands
  if [ -n "${GITHUB_ENV:-}" ]; then echo "LEXI_SEGMENT_PHASE=${NEXT_PHASE}" >> "$GITHUB_ENV"; fi
  if [ -n "$SWEEP_FAILED" ]; then
    echo "::error::Segment $N: processes the builder started could not all be stopped, or its git configuration could not be put back, so this job mints no further token."
    exit 1
  fi
  exit "$RC"
}
# Cancellation (the runner signals this script directly: the step runs it
# through `exec`) stops the builder and everything it started, and leaves the
# feedback cursor alone.
on_signal() { # $1 = INT|TERM, $2 = exit code
  trap '' INT TERM
  if [ -n "${AGENT_PID:-}" ]; then
    # timeout (no --foreground) leads its own process group, which holds
    # claude and every process it started. Before that group exists (or with a
    # timeout that execs), fall back to the pid.
    kill -s "$1" -- -"$AGENT_PID" 2>/dev/null || kill -s "$1" "$AGENT_PID" 2>/dev/null
    for _ in 1 2 3 4 5; do kill -0 -- -"$AGENT_PID" 2>/dev/null || kill -0 "$AGENT_PID" 2>/dev/null || break; sleep 1; done
    kill -KILL -- -"$AGENT_PID" 2>/dev/null; kill -KILL "$AGENT_PID" 2>/dev/null
  fi
  contain
  echo "$N:cancelled" >> "$RUNNER_TEMP/segment-exits"
  if [ -e "$FEEDBACK_DIR/batch-consumed-$N.json" ]; then
    echo "::warning::Segment $N was cancelled after its feedback batch was committed."
  else
    echo "::warning::Segment $N was cancelled; the feedback cursor was not advanced."
  fi
  exit "$2"
}
trap cleanup EXIT
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM

render() { # template, out — a prompt that cannot be rendered starts no builder
  if ! node "$TOOLS/render-prompt.mjs" "$1" "$2"; then
    echo "::error::Segment $N: the prompt could not be rendered."
    echo "$N:render-failed" >> "$RUNNER_TEMP/segment-exits"
    exit 0
  fi
}

if [ -s "$RUNNER_TEMP/stop-reason" ]; then
  echo "::notice::Segment $N skipped: $(cat "$RUNNER_TEMP/stop-reason")."
  echo "$N:skip" >> "$RUNNER_TEMP/segment-exits"
  exit 0
fi

# ---- which phase, model and prompt ---------------------------------------
PHASE=build
if [ "${LEXI_PHASES:-false}" = "true" ]; then
  PHASE="$(tr -d '[:space:]' < "$PHASE_FILE" 2>/dev/null || true)"
  case "$PHASE" in
    intent|spec|plan|build) ;;
    *) PHASE=intent ;;
  esac
fi
if [ -n "${LEXI_STOP_AT_PHASE:-}" ] && [ "$PHASE" = "$LEXI_STOP_AT_PHASE" ]; then
  echo "it reached the ${PHASE} phase (stop_at_phase); start it again with restart_phase=${PHASE} to go on" > "$RUNNER_TEMP/stop-reason"
  echo "::notice::Segment $N skipped: the build reached the ${PHASE} phase, where this run stops."
  echo "$N:skip" >> "$RUNNER_TEMP/segment-exits"
  exit 0
fi
printf '%s' "$PHASE" > "$RUNNER_TEMP/phase"
printf '%s' "$PHASE" > "$RUNNER_TEMP/segment-$N.phase"

if [ "$PHASE" = "build" ]; then
  MODEL="$LEXI_MODEL"
  EFFORT="${LEXI_EFFORT:-}"
  MINUTES="$LEXI_SEGMENT_MINUTES"
else
  MODEL="${LEXI_PLAN_MODEL:-$LEXI_MODEL}"
  EFFORT="${LEXI_PLAN_EFFORT:-${LEXI_EFFORT:-}}"
  MINUTES="${LEXI_PLAN_SEGMENT_MINUTES:-$LEXI_SEGMENT_MINUTES}"
fi

export PROMPT_SEGMENT="$N"
export PROMPT_PHASE="$PHASE"
export PROMPT_APP_LABEL="$LEXI_APP_LABEL"
export PROMPT_APP_DIR="$LEXI_APP_DIR"
export PROMPT_SESSION="$LEXI_SESSION"
export PROMPT_MAX_SESSIONS="$LEXI_MAX_SESSIONS"
export PROMPT_SEGMENTS="$LEXI_SEGMENTS"
export PROMPT_SEGMENT_MINUTES="$MINUTES"
export PROMPT_DOCS_DIR="$DOCS_DIR"
export PROMPT_FLEET_SIZE="${LEXI_FLEET_SIZE:-0}"
export PROMPT_FLEET_DIR="$FLEET_DIR"

# Track: one of several builders on this app, each owning its own folders.
export PROMPT_TRACK_NOTE
if [ -n "${LEXI_TRACK:-}" ]; then
  PROMPT_TRACK_NOTE="You are the **${LEXI_TRACK}** track: one of several builders working on this app at the same time, each on its own branch and PR. Your scope is the \`${LEXI_TRACK}\` entry of BUILD.md's \"Tracks\" section, and your documents (PHASE, the spec, PLAN.md, PROGRESS.md, DECISIONS.md, LAST_SESSION.md) live in \`${DOCS_DIR}/\`. Create and edit only the folders your entry gives you. The shared shell (its modules, registries and dependencies, as BUILD.md lists them) belongs to the shell: when you need a change there, write it in \`${DOCS_DIR}/SHARED_REQUESTS.md\` and work around it inside your own folders, never in the shared file."
else
  PROMPT_TRACK_NOTE="You are the only builder of this app: every folder in \`${LEXI_APP_DIR}/\` is yours."
fi

# The prototype is served by this segment, so it stops with it: the builder can
# edit the prototype's code, and a server that outlived the segment would run
# that code beside the later steps that hold secrets.
LEXI_PROTOTYPE_URL=""
if [ -n "${LEXI_PROTOTYPE_DIR:-}" ]; then
  : > "$RUNNER_TEMP/prototype.env"
  GITHUB_ENV="$RUNNER_TEMP/prototype.env" "$TOOLS/prototype.sh"
  LEXI_PROTOTYPE_URL="$(sed -n 's/^LEXI_PROTOTYPE_URL=//p' "$RUNNER_TEMP/prototype.env" | tail -n 1)"
fi
export LEXI_PROTOTYPE_URL
if [ -n "${LEXI_PROTOTYPE_URL:-}" ]; then
  PROMPT_PROTOTYPE_NOTE="The prototype is running at ${LEXI_PROTOTYPE_URL}."
else
  PROMPT_PROTOTYPE_NOTE="No prototype is running for this session; start one yourself if BUILD.md names it and you need it."
fi

# The plan and the build work from the approved spec.
export PROMPT_PLAN_SOURCE_NOTE="The spec passed its gate: \`${DOCS_DIR}/spec/\` is the source of truth from here on."
export PROMPT_PLAN_READ_NOTE="Read \`BUILD.md\`, \`INTENT.md\`, \`DECISIONS.md\` and \`spec/README.md\`, then the spec documents."
export PROMPT_PLAN_ID_NOTE="the spec rule IDs from \`spec/rules.md\`"
export PROMPT_BUILD_SOURCE_NOTE="The spec, not the raw sources, is what you build to."

# The builder and the phase gate share the same test and browser policy.
source "$TOOLS/build-policy.sh"

# Fleet: the builder leads sub-agents, each in its own worktree (fleet.md).
export PROMPT_FLEET_LIGHT_NOTE=""
if [ -n "${LEXI_FLEET_LIGHT_MODEL:-}" ]; then
  # Claude Code resolves the sub-agent model alias `haiku` through this.
  export ANTHROPIC_DEFAULT_HAIKU_MODEL="$LEXI_FLEET_LIGHT_MODEL"
  PROMPT_FLEET_LIGHT_NOTE="   **Pick each sub-agent's model.** A routine, fully specified item (copy and messages, a display-only screen ported from the reference code, tests for code that exists) runs on the light model: launch it with model \`haiku\` (this run maps it to \`${LEXI_FLEET_LIGHT_MODEL}\`). Anything with logic, state, API calls or money runs on the default model. If a light sub-agent fails or its work does not pass your checks, redo the item on the default model."
fi
export PROMPT_FLEET_NOTE="No fleet this run: work through the plan yourself, with a sub-agent only for a side task." PROMPT_FLEET_PLAN_NOTE="" PROMPT_FLEET_SPEC_NOTE=""
if [ "${LEXI_FLEET_SIZE:-0}" != "0" ]; then
  mkdir -p "$FLEET_DIR"
  render "$TOOLS/fleet.md" "$RUNNER_TEMP/fleet-note.md"
  PROMPT_FLEET_NOTE="$(cat "$RUNNER_TEMP/fleet-note.md")"
  PROMPT_FLEET_SPEC_NOTE="To go faster, split the spec across up to ${LEXI_FLEET_SIZE} sub-agents (the \`Agent\` tool, all launched in one message): one per area or per document, each writing only its own files under \`${DOCS_DIR}/spec/\` from the sources and decisions you give it. Then write README.md and coverage.md yourself and check the parts agree with each other and with DECISIONS.md."
  PROMPT_FLEET_PLAN_NOTE="The build runs as a fleet: one lead and up to ${LEXI_FLEET_SIZE} sub-agents working at the same time, each in its own worktree. So, inside each milestone, group the items into **waves** of up to ${LEXI_FLEET_SIZE} items that can be built at once: for every item name the folders it owns, and never let two items in one wave own the same file. Name the shared files (registries, message index, dependencies) the lead integrates after each wave."
fi
# The large prompt parts go to the renderer as files (prompt-inputs-N/).
export PROMPT_PROTOTYPE_NOTE
rm -rf "$INPUTS"
mkdir -p "$INPUTS" || { echo "::error::Segment $N: the prompt could not be rendered."; echo "$N:render-failed" >> "$RUNNER_TEMP/segment-exits"; exit 0; }
input() { # name, source file, text when empty — same text as `$(cat file)` gave
  local V
  V="$(cat "$2" 2>/dev/null || true)"
  [ -n "$V" ] || V="$3"
  printf '%s' "$V" > "$INPUTS/$1"
}
input intake-note.md "$RUNNER_TEMP/intake-note.md" "No feature-intake issues are configured for this build."
input assessment.md "$RUNNER_TEMP/assessment.md" "(none yet)"
input source-changes.md "$RUNNER_TEMP/source-changes.md" "(no source changed since the last session)"
input gate-findings.md "$BUILD_DOCS/GATE_FINDINGS.md" "(none)"

# Feedback: only allowlisted authors reach it (feedback.sh). The batch the
# builder sees and the batch a commit applies are the same snapshot, taken here.
if [ -e "$RUNNER_TEMP/feedback-cursor-error" ]; then
  FEEDBACK_TEXT="_Feedback delivery is paused for this session: the feedback cursor could not be saved._"
elif [ -e "$FEEDBACK_DIR/batch.json" ]; then
  if cp "$FEEDBACK_DIR/batch.json" "$INPUTS/batch.json" 2>/dev/null \
     && cp "$FEEDBACK_DIR/pending.json" "$INPUTS/pending.json" 2>/dev/null \
     && cp "$RUNNER_TEMP/feedback.md" "$INPUTS/feedback-batch.md" 2>/dev/null \
     && jq -e 'type == "object"' "$INPUTS/batch.json" > /dev/null 2>&1 \
     && jq -e 'type == "array"' "$INPUTS/pending.json" > /dev/null 2>&1 \
     && [ "$(wc -c < "$INPUTS/feedback-batch.md" | tr -d ' ')" = "$(jq -r '.feedback_bytes' "$INPUTS/batch.json")" ]; then
    FEEDBACK_TEXT="$(cat "$INPUTS/feedback-batch.md")"
  else
    rm -f "$INPUTS/batch.json" "$INPUTS/pending.json" "$INPUTS/feedback-batch.md"
    echo "::error::Segment $N: the feedback batch files do not match; no feedback this segment, nothing is skipped."
    FEEDBACK_TEXT="_Feedback could not be prepared for this segment; nothing is skipped._"
  fi
else
  # No batch: feedback.md holds nothing, or one note line.
  cat "$RUNNER_TEMP/feedback.md" > "$INPUTS/feedback-note.md" 2>/dev/null || : > "$INPUTS/feedback-note.md"
  FEEDBACK_TEXT="$(cat "$INPUTS/feedback-note.md")"
fi
# A base merge left to the builder (sync-base.sh) comes first, until it is done.
if [ -s "$RUNNER_TEMP/merge-note.md" ] && ! git merge-base --is-ancestor "origin/${LEXI_BASE:-main}" HEAD 2>/dev/null; then
  FEEDBACK_TEXT="$(cat "$RUNNER_TEMP/merge-note.md")${FEEDBACK_TEXT:+

$FEEDBACK_TEXT}"
fi
printf '%s' "$FEEDBACK_TEXT" > "$INPUTS/feedback.md"
unset FEEDBACK_TEXT
export PROMPT_FEEDBACK_FILE="$INPUTS/feedback.md"
export PROMPT_ASSESSMENT_FILE="$INPUTS/assessment.md"
export PROMPT_SOURCE_CHANGES_FILE="$INPUTS/source-changes.md"
export PROMPT_GATE_FINDINGS_FILE="$INPUTS/gate-findings.md"
export PROMPT_INTAKE_NOTE_FILE="$INPUTS/intake-note.md"

export PROMPT_DEADLINE
PROMPT_DEADLINE="$(date -u -d "+${MINUTES} minutes" '+%H:%M UTC')"
if [ "$N" = "$LEXI_SEGMENTS" ]; then
  export PROMPT_LAST_SEGMENT_NOTE="This is the LAST segment of the session: in its final 15 minutes, bring PROGRESS.md up to date, write LAST_SESSION.md, and commit everything. The next session starts in a fresh conversation and knows only what is in the files."
else
  export PROMPT_LAST_SEGMENT_NOTE="Before this segment ends, bring PROGRESS.md and LAST_SESSION.md up to date and commit: the next segment may start in a fresh conversation."
fi

RESUME=()
if [ "$PHASE" != "build" ]; then
  render "$TOOLS/prompt-phase-${PHASE}.md" "$PROMPT_OUT"
elif [ "${LEXI_RESUME_SEGMENTS:-true}" = "true" ] && [ "$N" != "1" ] && [ -s "$SESSION_FILE" ] \
     && [ "$(cat "$RUNNER_TEMP/session-phase" 2>/dev/null)" = "build" ]; then
  render "$TOOLS/prompt-continue.md" "$PROMPT_OUT"
  RESUME=(--resume "$(cat "$SESSION_FILE")")
else
  render "$TOOLS/prompt-first.md" "$PROMPT_OUT"
fi
printf '\nThis segment ends at about %s (check with `date -u`).\n' "$PROMPT_DEADLINE" >> "$PROMPT_OUT"

EFFORT_ARGS=()
if [ -n "$EFFORT" ]; then EFFORT_ARGS=(--effort "$EFFORT"); fi

run_agent() {
  : > "$STREAM"
  : > "$STREAM.stderr"
  AGENT_START=$(date +%s)
  # The prompt is stdin (no positional argument; none may follow a variadic
  # option anyway). The builder keeps the runner's umask, not this script's.
  ( umask "$BUILDER_UMASK"
    exec timeout --signal=INT --kill-after=120 "${MINUTES}m" \
      claude -p \
        --model "$MODEL" \
        --dangerously-skip-permissions \
        --mcp-config "$RUNNER_TEMP/mcp.json" \
        ${EFFORT_ARGS[@]+"${EFFORT_ARGS[@]}"} \
        "$@" \
        --verbose --output-format stream-json ) \
    < "$PROMPT_OUT" > "$STREAM" 2> "$STREAM.stderr" &
  AGENT_PID=$!

  ( tail -n +1 -f "$STREAM" 2>/dev/null \
    | jq -R -r --unbuffered --arg seg "$N" --arg phase "$PHASE" '
        fromjson? |
        if .type == "system" and .subtype == "init" then
          "· segment \($seg) (\($phase)) start — model \(.model // "?")"
        elif .type == "assistant" then
          ( [ .message.content[]? | select(.type == "tool_use")
              | "  > " + .name + " "
                + ((.input.file_path // .input.path // .input.command // .input.url
                    // .input.pattern // .input.description // "")
                   | tostring | .[0:140] | gsub("\n"; " ")) ] | .[] ),
          ( [ .message.content[]? | select(.type == "text") | .text ]
            | join(" ") | select(length > 0)
            | "  . " + (.[0:240] | gsub("\n"; " ")) )
        elif .type == "result" then
          "· segment \($seg) done — \(.subtype // "?"), \(.num_turns // 0) turns, $\(.total_cost_usd // 0)"
        else empty end' 2>/dev/null ) &
  RENDER_PID=$!

  wait "$AGENT_PID"
  AGENT_EXIT=$?
  AGENT_PID=""
  sleep 2
  # Its children first: once the subshell is gone they are no longer its children.
  pkill -P "$RENDER_PID" 2>/dev/null || true
  kill "$RENDER_PID" 2>/dev/null || true
  wait "$RENDER_PID" 2>/dev/null || true
  RENDER_PID=""
  return "$AGENT_EXIT"
}

git_snapshot
run_agent ${RESUME[@]+"${RESUME[@]}"}
EXIT=$?

# A resume that fails at once (a lost or unreadable session) starts a fresh
# conversation from the full prompt rather than wasting the segment. The
# prompt inputs, and so the feedback batch, are the same for both runs.
if [ "$EXIT" -ne 0 ] && [ "${#RESUME[@]}" -gt 0 ] && [ $(( $(date +%s) - AGENT_START )) -lt 90 ]; then
  echo "::warning::Resuming the session failed at once (exit $EXIT); starting a fresh conversation."
  render "$TOOLS/prompt-first.md" "$PROMPT_OUT"
  printf '\nThis segment ends at about %s (check with `date -u`).\n' "$PROMPT_DEADLINE" >> "$PROMPT_OUT"
  run_agent
  EXIT=$?
fi
ELAPSED=$(( $(date +%s) - AGENT_START ))

# The builder is done: stop what it left running and put back the git
# configuration before anything else runs, then take the tools afresh.
contain
git_restore || SWEEP_FAILED=1
if [ -n "$SWEEP_FAILED" ] || ! reload_tools; then
  SWEEP_FAILED=1
  exit 1
fi
rm -rf "$RUNNER_TEMP/slack-outbox"

SID="$(jq -R -r 'fromjson? | select(.type == "system" and .subtype == "init") | .session_id // empty' "$STREAM" 2>/dev/null | head -n 1)"
if [ -n "$SID" ]; then
  printf '%s' "$SID" > "$SESSION_FILE"
  printf '%s' "$PHASE" > "$RUNNER_TEMP/session-phase"
fi

if [ -s "$STREAM.stderr" ]; then
  echo "--- agent stderr (last 20 lines) ---"
  tail -n 20 "$STREAM.stderr"
fi
# What the builder demonstrably did, from its own event stream.
STREAM_FACTS="$(jq -R -s -c --arg ref "$(jq -r 'if .oversized == true then .items[0].ref // "" else "" end' "$INPUTS/batch.json" 2>/dev/null)" '
  def norm: gsub("/+"; "/") | until(test("/\\./") | not; gsub("/\\./"; "/"));
  [split("\n")[] | fromjson? | select(type == "object")] as $ev
  | {init: any($ev[]; .type == "system" and .subtype == "init"),
     assist: any($ev[]; .type == "assistant"),
     result_ok: any($ev[]; .type == "result" and .subtype == "success" and .is_error != true),
     error_result: any($ev[]; .type == "result" and (.subtype != "success" or .is_error == true)),
     ref_read: (if $ref == "" then false else
       ([$ev[] | select(.type == "assistant") | .message.content[]?
         | select(type == "object" and .type == "tool_use" and .name == "Read"
                  and ((.input.file_path // "") | tostring | norm) == ($ref | norm)) | .id]) as $ids
       | any($ev[] | select(.type == "user") | .message.content[]? | select(type == "object");
             .type == "tool_result" and (.tool_use_id as $t | $ids | index($t)) != null and .is_error != true)
       end)}' "$STREAM" 2>/dev/null)"
[ -n "$STREAM_FACTS" ] || STREAM_FACTS='{"init":false,"assist":false,"result_ok":false,"error_result":false,"ref_read":false}'
fact() { [ "$(jq -r ".$1" <<< "$STREAM_FACTS")" = "true" ]; }

if [ "$EXIT" -eq 0 ] && ! fact init; then
  # `claude -p` that read no prompt can exit 0 without starting.
  echo "::warning::Segment $N: the builder exited 0 without starting (no init event)."
  echo "$N:noinit" >> "$RUNNER_TEMP/segment-exits"
else
  case "$EXIT" in
    0) echo "Segment $N finished on its own." ;;
    124|130) echo "Segment $N reached its time limit." ;;
    *) echo "::warning::Segment $N exited with code $EXIT." ;;
  esac
  echo "$N:$EXIT" >> "$RUNNER_TEMP/segment-exits"
fi

# ---- feedback cursor ---------------------------------------------------
# A batch is processed as a whole: the builder started, took a turn, and
# finished cleanly or ran into the segment's own deadline. A batch delivered by
# reference also needs a successful Read of the file. Anything else (launch
# failure, exit before init, error result, external signal, early kill) keeps
# the cursor, and the same comments come again.
cursor_error() { # reason
  echo "::error::Segment $N: the feedback cursor could not be saved ($1). Feedback delivery pauses for this session; the batch will be delivered again."
  printf '%s\n' "$1" > "$RUNNER_TEMP/feedback-cursor-error"
}
if [ ! -e "$RUNNER_TEMP/feedback-cursor-error" ] && [ -s "$INPUTS/batch.json" ]; then
  PROCESSED=""
  WHY=""
  if ! fact init; then WHY="the builder did not start (exit $EXIT)"
  elif ! fact assist; then WHY="the builder took no turn (exit $EXIT)"
  elif [ "$EXIT" -eq 0 ] && fact result_ok; then PROCESSED=1
  elif [ "$EXIT" -eq 124 ]; then PROCESSED=1
  elif [ "$EXIT" -eq 137 ] && [ "$ELAPSED" -ge $(( MINUTES * 60 )) ]; then PROCESSED=1
  elif [ "$EXIT" -eq 0 ]; then WHY="the builder ended with an error result"
  else WHY="exit $EXIT"
  fi
  BATCH_COUNT="$(jq -r '.keys | length' "$INPUTS/batch.json")"
  BATCH_FIRST="$(jq -r '.keys[0]' "$INPUTS/batch.json")"
  if [ -n "$PROCESSED" ] && [ "$(jq -r '.oversized' "$INPUTS/batch.json")" = "true" ] && ! fact ref_read; then
    PROCESSED=""
    echo "::warning::Segment $N: the builder did not open the reference file for ${BATCH_FIRST}; the cursor stays and it is delivered again."
  elif [ -z "$PROCESSED" ]; then
    echo "::warning::Segment $N: feedback batch (${BATCH_COUNT} comment(s), first ${BATCH_FIRST}) was not processed (${WHY}). The cursor stays; the same comments are retried."
  fi
  if [ -n "$PROCESSED" ]; then
    if ! "$TOOLS/feedback-cursor.sh" commit "$N" "$INPUTS" 2> "$INPUTS/commit.stderr"; then
      cursor_error "$(head -n 1 "$INPUTS/commit.stderr" 2>/dev/null | cut -c1-200)"
    fi
  fi
fi
# The workflow owns FEEDBACK_CURSOR.json: undo any edit the builder made.
if ! "$TOOLS/feedback-cursor.sh" restore 2> "$INPUTS/restore.stderr"; then
  cursor_error "$(head -n 1 "$INPUTS/restore.stderr" 2>/dev/null | cut -c1-200)"
fi

# A planning segment ends at its gate. The builder's work is committed first,
# so the reviewer reads exactly what the next phase will build on.
if [ "$PHASE" != "build" ]; then
  cd "$GITHUB_WORKSPACE"
  git add -A
  git diff --cached --quiet || git commit -q -m "docs(${LEXI_APP}): ${PHASE} phase — session ${LEXI_SESSION}, segment ${N}"
  "$TOOLS/gate.sh" "$PHASE" || echo "::warning::The ${PHASE} gate did not run to completion."
fi
exit "${SEG_RC:-0}"
}

main "$@"; exit $?
