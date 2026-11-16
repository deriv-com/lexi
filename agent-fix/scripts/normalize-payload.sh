#!/usr/bin/env bash
# normalize-payload.sh — validate and normalise the agent-fix request.
#
# Usage: normalize-payload.sh <raw-json-file>
#
# workflow_dispatch inputs (always strings) and repository_dispatch payloads
# (JSON types preserved) collapse to one flat shape:
#
#   brief                required  the bug report or task, verbatim
#   requester            required  who asked, as the dispatcher knows them
#   thread_ref           optional  conversation anchor; drives duplicate detection
#   scope_hint           optional  a path hint, verified rather than trusted
#   resume_issue_number  optional  an existing issue to continue
#   resume_pr_number     optional  an existing PR to continue
#
# On success: prints the normalised JSON object to stdout, exits 0.
# On failure: prints a named ERROR to stderr, exits 1.
# No minimum length is enforced on brief — a terse report is valid input.

set -euo pipefail

RAW_FILE="${1:?usage: normalize-payload.sh <raw-json-file>}"

if [ ! -s "$RAW_FILE" ] || ! jq empty "$RAW_FILE" 2>/dev/null; then
  echo "ERROR: missing required field: brief (payload empty or not valid JSON)" >&2
  exit 1
fi

BRIEF=$(jq -r '.brief // ""' "$RAW_FILE")
REQUESTER=$(jq -r '.requester // ""' "$RAW_FILE")
THREAD_REF=$(jq -r '.thread_ref // ""' "$RAW_FILE")
SCOPE_HINT=$(jq -r '.scope_hint // ""' "$RAW_FILE")

if [ -z "$BRIEF" ]; then
  echo "ERROR: missing required field: brief" >&2
  exit 1
fi

if [ -z "$REQUESTER" ]; then
  echo "ERROR: missing required field: requester" >&2
  exit 1
fi

# A positive integer, given as a string or a number. Prints it without leading
# zeros, or nothing when the field is absent or empty.
positive_int() {
  local field=$1 kind value
  kind=$(jq -r --arg f "$field" 'if has($f) and .[$f] != null then (.[$f] | type) else "missing" end' "$RAW_FILE")
  case "$kind" in
    missing) return 0 ;;
    string)
      value=$(jq -r --arg f "$field" '.[$f]' "$RAW_FILE")
      [ -n "$value" ] || return 0
      if ! printf '%s' "$value" | grep -Eq '^[0-9]+$'; then
        echo "ERROR: invalid optional field: $field (expected a positive integer)" >&2
        return 1
      fi
      value=$(printf '%s' "$value" | sed -E 's/^0+//')
      ;;
    number)
      if ! jq -e --arg f "$field" '.[$f] > 0 and (.[$f] | floor) == .[$f]' "$RAW_FILE" >/dev/null; then
        echo "ERROR: invalid optional field: $field (expected a positive integer)" >&2
        return 1
      fi
      value=$(jq -r --arg f "$field" '.[$f] | tostring' "$RAW_FILE")
      ;;
    *)
      echo "ERROR: invalid optional field: $field (expected a positive integer)" >&2
      return 1
      ;;
  esac
  if [ -z "$value" ]; then
    echo "ERROR: invalid optional field: $field (expected a positive integer)" >&2
    return 1
  fi
  printf '%s' "$value"
}

RESUME_ISSUE_NUMBER=$(positive_int resume_issue_number)
RESUME_PR_NUMBER=$(positive_int resume_pr_number)

jq -n -c \
  --arg brief "$BRIEF" \
  --arg requester "$REQUESTER" \
  --arg thread_ref "$THREAD_REF" \
  --arg scope_hint "$SCOPE_HINT" \
  --arg resume_issue_number "$RESUME_ISSUE_NUMBER" \
  --arg resume_pr_number "$RESUME_PR_NUMBER" \
  '{brief: $brief, requester: $requester, thread_ref: $thread_ref, scope_hint: $scope_hint, resume_issue_number: $resume_issue_number, resume_pr_number: $resume_pr_number}'
