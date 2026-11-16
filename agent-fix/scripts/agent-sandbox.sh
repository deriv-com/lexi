#!/usr/bin/env bash
#
# Stops everything an agent left running, and drops the GitHub file commands it
# may have written, before a later step that holds a secret starts.
#
# WHY THIS EXISTS
#   The coding agents run as the runner's own user with tool permissions
#   skipped. A process that user starts can read the environment of any other
#   process of the same user (/proc/<pid>/environ), so a helper the agent leaves
#   behind (`nohup`, `setsid`, a dev server whose code it edited) would read the
#   GitHub App private key out of the next step that mints a token. GitHub does
#   not stop a step's processes when the step ends, only when the job ends.
#   The agent can also append to the step's GITHUB_ENV and GITHUB_PATH files,
#   which would set LD_PRELOAD or put its own `openssl` on PATH for every later
#   step.
#
#   So a step that runs an agent (or other untrusted code) ends with:
#     sandbox_stop <mark>          kill every process of this user that started
#                                  after <mark>, except this shell and its
#                                  ancestors; fail if any survive
#     sandbox_reset_file_commands  truncate GITHUB_ENV, GITHUB_PATH, GITHUB_OUTPUT
#   and writes its own file commands only after that. After the last
#   sandbox_stop, run no command found on PATH (the agent may have planted one
#   there that would start afresh); these functions use only builtins and
#   absolute paths.
#
#   Process groups and sessions are not enough: `setsid` leaves both. The start
#   time is: a process cannot change when it started. A process that clears its
#   environment is still caught. The sweep never forks while it scans (bash
#   builtins only), so it cannot see its own helpers.
#
# USAGE
#   Source it and call the functions, or run it:
#     agent-sandbox.sh mark                  print the start time of this moment
#     agent-sandbox.sh stop <mark>           exit 1 when something survived
#     agent-sandbox.sh reset-file-commands
#
# LIMITS
#   Linux only (/proc). Elsewhere it warns and does nothing. It cannot stop a
#   process running as another user, which is what an agent with sudo can start;
#   docs/threat-model.md says what that leaves open. On a self-hosted runner that
#   runs several jobs as one user, processes carrying another job's
#   RUNNER_TRACKING_ID are left alone; on a GitHub-hosted runner every process
#   of this user started after <mark> is stopped.
#
# bash 3.2-compatible syntax; uses no external command while scanning.

_SB_PROC=/proc

# Helpers return through _SB (no command substitution: a $( ) subshell is a
# process of this user started after the mark, and the scan would find it).

# Field 22 of /proc/<pid>/stat is the start time in clock ticks since boot;
# field 3 is the state. The command name in field 2 may contain spaces and
# parentheses, so fields are counted from the last ')'.
_sandbox_stat() { # pid -> _SB="<state> <start time>"
  local stat rest
  _SB=""
  { IFS= read -r stat < "$_SB_PROC/$1/stat"; } 2>/dev/null || return 1
  rest=${stat##*) }
  # shellcheck disable=SC2086 # deliberate split of the numeric fields
  set -- $rest
  [ "$#" -ge 20 ] || return 1
  _SB="$1 ${20}"
}

sandbox_mark() { # prints the start time of the calling shell
  if [ ! -r /proc/self/stat ]; then
    printf '0'
    return 0
  fi
  # $$ is the outermost shell even inside $( ), so the mark is when that shell
  # started: before anything it launches.
  _sandbox_stat "$$" || return 1
  printf '%s' "${_SB#* }"
}

_sandbox_field() { # pid key -> _SB = first value of "key:" in /proc/<pid>/status
  local line
  _SB=""
  while IFS= read -r line; do
    case "$line" in
      "$2":*)
        line=${line#*:}
        # shellcheck disable=SC2086
        set -- $line
        _SB=$1
        return 0
        ;;
    esac
  done < "$_SB_PROC/$1/status" 2>/dev/null
  return 1
}

_sandbox_env() { # pid name -> _SB = the value of name in its environment, or empty
  local kv
  _SB=""
  while IFS= read -r -d '' kv; do
    case "$kv" in
      "$2"=*) _SB=${kv#*=}; return 0 ;;
    esac
  done < "$_SB_PROC/$1/environ" 2>/dev/null
  return 0
}

# Test hooks, honoured only outside GitHub Actions: LEXI_SANDBOX=off skips the
# sweep, LEXI_SANDBOX_REQUIRE_ENV=NAME=VALUE limits it to processes carrying
# that variable, so a test cannot stop the processes of tests running beside it,
# and LEXI_SANDBOX_PROC reads a fake /proc.
_sandbox_test_hook() {
  [ "${GITHUB_ACTIONS:-}" != true ] || return 1
  [ -n "${1:-}" ]
}

_sandbox_ancestors() { # -> _SB_KEEP = " self parent ... 1 "
  local p
  _SB_KEEP=" $$ ${BASHPID:-$$} "
  p=${BASHPID:-$$}
  while [ -n "$p" ] && [ "$p" != 0 ] && [ "$p" != 1 ]; do
    _sandbox_field "$p" PPid || break
    p=$_SB
    _SB_KEEP="$_SB_KEEP$p "
  done
}

_sandbox_candidates() { # mark -> _SB_PIDS = pids that sandbox_stop kills
  local mark=$1 dir pid start mine
  mine=${RUNNER_TRACKING_ID:-}
  _SB_PIDS=""
  for dir in "$_SB_PROC"/[0-9]*; do
    pid=${dir#"$_SB_PROC"/}
    case "$_SB_KEEP" in *" $pid "*) continue ;; esac
    _sandbox_field "$pid" Uid || continue
    [ "$_SB" = "$UID" ] || continue
    _sandbox_stat "$pid" || continue
    start=${_SB#* }
    [ "${_SB%% *}" = Z ] && continue
    [ "$start" -gt "$mark" ] 2>/dev/null || continue
    if [ "${RUNNER_ENVIRONMENT:-}" != github-hosted ] && [ -n "$mine" ]; then
      _sandbox_env "$pid" RUNNER_TRACKING_ID
      if [ -n "$_SB" ] && [ "$_SB" != "$mine" ]; then
        continue
      fi
    fi
    if _sandbox_test_hook "${LEXI_SANDBOX_REQUIRE_ENV:-}"; then
      _sandbox_env "$pid" "${LEXI_SANDBOX_REQUIRE_ENV%%=*}"
      [ "$_SB" = "${LEXI_SANDBOX_REQUIRE_ENV#*=}" ] || continue
    fi
    _SB_PIDS="$_SB_PIDS $pid"
  done
}

_sandbox_pause() {
  if [ -x /usr/bin/sleep ]; then /usr/bin/sleep 0.2
  elif [ -x /bin/sleep ]; then /bin/sleep 0.2
  fi
}

# Call from the shell itself, not from a $( ) or a pipeline: everything outside
# this shell and its ancestors that started after the mark is stopped.
sandbox_stop() { # mark -> 0 when nothing of this user started after mark is left
  local mark=${1:-} round pid
  if _sandbox_test_hook "${LEXI_SANDBOX:-}" && [ "$LEXI_SANDBOX" = off ]; then
    return 0
  fi
  if _sandbox_test_hook "${LEXI_SANDBOX_PROC:-}"; then _SB_PROC=$LEXI_SANDBOX_PROC; fi
  if [ ! -d "$_SB_PROC/$$" ] && [ ! -r /proc/self/stat ]; then
    echo "::warning::agent-sandbox: no /proc on this runner, so processes the agent left running cannot be found and stopped." >&2
    return 0
  fi
  case "$mark" in
    ''|*[!0-9]*) echo "::error::agent-sandbox: no start mark given; refusing to guess which processes to stop." >&2; return 1 ;;
  esac
  _sandbox_ancestors
  round=0
  while [ "$round" -lt 30 ]; do
    _sandbox_candidates "$mark"
    [ -n "$_SB_PIDS" ] || return 0
    # Freeze first, then kill: a frozen process cannot fork a replacement
    # between the two passes.
    for pid in $_SB_PIDS; do kill -STOP "$pid" 2>/dev/null; done
    for pid in $_SB_PIDS; do kill -KILL "$pid" 2>/dev/null; done
    round=$((round + 1))
    _sandbox_pause
  done
  _sandbox_candidates "$mark"
  [ -z "$_SB_PIDS" ] && return 0
  echo "::error::agent-sandbox: processes left by the agent could not be stopped:$_SB_PIDS" >&2
  return 1
}

sandbox_reset_file_commands() {
  local f
  for f in "${GITHUB_ENV:-}" "${GITHUB_PATH:-}" "${GITHUB_OUTPUT:-}"; do
    [ -n "$f" ] || continue
    # A symlink planted in place of the file would send the truncation
    # elsewhere; replace it with an empty file instead.
    if [ -L "$f" ]; then /bin/rm -f "$f" 2>/dev/null; fi
    : > "$f" 2>/dev/null || true
  done
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    mark) sandbox_mark && echo ;;
    stop) sandbox_stop "${2:-}" ;;
    reset-file-commands) sandbox_reset_file_commands ;;
    *) echo "usage: agent-sandbox.sh mark | stop <mark> | reset-file-commands" >&2; exit 2 ;;
  esac
fi
