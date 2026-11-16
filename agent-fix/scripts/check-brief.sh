#!/usr/bin/env bash
# check-brief.sh — refuse a brief that names a protected path, before the agent
# starts.
#
# Usage: check-brief.sh [context-json]   (default /tmp/ctx.json)
#
# This cannot cover the general case: the agent decides what to edit after it
# starts, so the pre-push hook is the real guard. This exists to fail fast on
# the case that IS knowable up front, instead of spending a whole run to end in
# a refused push.
#
# A candidate counts when it matches a protected pattern AND either is a path
# in this checkout or matches an extension-only pattern (`*.yml`). A word that
# merely contains "production" is prose far more often than a path, so the name
# patterns only count a candidate that exists.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=protected-paths.sh
. "$SCRIPT_DIR/protected-paths.sh"

CTX="${1:-/tmp/ctx.json}"

if [ ! -f "$CTX" ]; then
  echo "check-brief: no context file at ${CTX}; nothing to inspect."
  exit 0
fi

# Anything that looks like a path. Trailing full stops go first, so the end of
# a sentence ("...only in production.") is not read as an extension.
CANDIDATES=$(tr -c 'A-Za-z0-9._/-' '\n' < "$CTX" | sed 's/\.*$//' \
  | grep -E '^[A-Za-z0-9._/-]+\.[A-Za-z0-9]+$|^[A-Za-z0-9._/-]*production[A-Za-z0-9._/-]*$' \
  | sort -u || true)

# `*.yml` and the like: a token with that extension names a file whether or not
# it exists yet.
is_extension_pattern() {
  case "$1" in
    \*.*)
      case "${1#\*.}" in *[*?/]*) return 1 ;; esac
      return 0
      ;;
  esac
  return 1
}

HITS=""
for candidate in $CANDIDATES; do
  pattern=$(lexi_protecting_pattern "$candidate") || continue
  path="${candidate#./}"
  path="${path#/}"
  if is_extension_pattern "$pattern" || [ -e "$path" ]; then
    HITS="${HITS}  - ${candidate}
"
  fi
done

if [ -n "$HITS" ]; then
  echo "Blocked: the brief names protected files." >&2
  printf '%s' "$HITS" >&2
  echo "  These paths are changed by a human, not by the agent." >&2
  echo "  Nothing was dispatched to the coding agent." >&2
  exit 1
fi

echo "check-brief: no protected paths named in the brief."
