#!/usr/bin/env bash
# usage: feedback-cursor.sh init <pr> <legacy_since> <items.json>
#        feedback-cursor.sh commit <segment> <snapshot_dir>
#        feedback-cursor.sh restore
#        feedback-cursor.sh safe-at
#
# Owns the feedback cursor: which PR comments the builder has already
# processed. The durable copy is <docs dir>/FEEDBACK_CURSOR.json on the build
# branch (pushed by push.sh like the other build documents); the in-session
# copy is $RUNNER_TEMP/feedback-cursor.json, which feedback.sh reads.
#
#   {version: 1, rev, pr, floor, watermark, safe_at,
#    delivered: [{key, at}], replay, replay_done: [key], updated}
#
# Every eligible comment with `at <= floor` is processed, and so is every key
# in `delivered`. A key is `comment:<id>`, `review:<id>` or `inline:<id>`.
#
# The cursor is never advanced by reading comments: only `commit`, which
# segment.sh runs after the builder demonstrably processed a batch, moves it.
#
#   init     Load the cursor for this session (a byte copy of a valid branch
#            file, else legacy values from the report markers) and apply a
#            replay request. Writes the branch file only for a newly applied
#            replay request. Exit 3: invalid replay value. Exit 2: anything else.
#   commit   Advance the cursor past the batch in <snapshot_dir> (batch.json,
#            pending.json, taken when the prompt was rendered). Refused, with
#            nothing written, when the cursor moved since the batch was
#            prepared. Exit 2 on any failure.
#   restore  Undo a builder's edit of the branch file (only once the session
#            has written or loaded it). Exit 2 on failure.
#   safe-at  Print the processed-through time for the session report marker.
#
# jq only (>= 1.6), bash 3.2 compatible. Logs carry keys, times and counts,
# never comment text.
set -uo pipefail

RT="$RUNNER_TEMP"
DOCS="${LEXI_DOCS_DIR:-${LEXI_APP_DIR:-}/docs/build}"
BRANCH_DIR="${GITHUB_WORKSPACE:-.}/$DOCS"
BRANCH_FILE="$BRANCH_DIR/FEEDBACK_CURSOR.json"
SESSION_FILE="$RT/feedback-cursor.json"
TRACKED="$RT/feedback-cursor-tracked"
REPLAY_REQUEST="$RT/feedback-replay-request"
REPLAY_HANDLED="$RT/feedback-replay-handled"

fail() { echo "$*" >&2; exit 2; }
now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# Schema check for an untrusted cursor file (the builder can write the branch).
DEFS='
def iso: type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");
def key_ok: type == "string" and test("^(comment|review|inline):[0-9]+$");
def valid:
  type == "object" and .version == 1
  and (.pr | type == "number")
  and ((.rev // 0) | type == "number")
  and (.floor | iso) and (.watermark | iso) and (.safe_at | iso)
  and (.delivered | type == "array" and all(.[]; type == "object" and (.key | key_ok) and (.at | iso)))
  and (.replay | . == null or (type == "object" and (.from_key | key_ok) and (.from_at | iso)
        and (.from_rank | type == "number") and (.from_id | type == "number")
        and (.delivered | type == "array" and all(.[]; key_ok))))
  and ((.replay_done // []) | type == "array" and all(.[]; key_ok));
def updated($seg): {session: $ENV.LEXI_SESSION, segment: $seg, run_id: $ENV.GITHUB_RUN_ID, at: (now | todateiso8601)};
def order: [.at, .rank, .id];
def replay_pending($items):
  .replay as $r
  | if $r == null then []
    else ($r.delivered | map({(.): true}) | add // {}) as $done
      | [$items[] | select(.eligible == true and (order >= [$r.from_at, $r.from_rank, $r.from_id]) and ($done[.key] | not))]
    end;
def minus1s: fromdateiso8601 - 1 | todateiso8601;
def max2($x; $y): if $x > $y then $x else $y end;
def min2($x; $y): if $x < $y then $x else $y end;
def complete_replay:
  .replay_done = (((.replay_done // []) + [.replay.from_key]) | .[-20:]) | .replay = null;
'

# write_file <dest> <source file>: validate as JSON, then an atomic rename.
write_file() {
  local tmp="$1.tmp.$$"
  if cp "$2" "$tmp" 2>/dev/null && jq -e "$DEFS"' valid' "$tmp" > /dev/null 2>&1 && mv -f "$tmp" "$1" 2>/dev/null; then
    return 0
  fi
  rm -f "$tmp" 2>/dev/null
  return 1
}

# write_both <new cursor file>: the branch file first, then the in-session file.
write_both() {
  mkdir -p "$BRANCH_DIR" 2>/dev/null || fail "cannot create ${DOCS}"
  write_file "$BRANCH_FILE" "$1" || fail "cannot write ${DOCS}/FEEDBACK_CURSOR.json"
  write_file "$SESSION_FILE" "$1" || fail "cannot write the in-session cursor"
  touch "$TRACKED" || fail "cannot mark the cursor as tracked"
}

cmd_init() {
  local PR="$1" SINCE="$2" ITEMS="$3"
  [[ "$PR" =~ ^[0-9]+$ ]] || fail "bad PR number"
  jq -e 'type == "array"' "$ITEMS" > /dev/null 2>&1 || fail "the comment list is unreadable"
  if [ ! -e "$SESSION_FILE" ]; then
    local REASON=""
    if [ ! -e "$BRANCH_FILE" ]; then
      REASON="no ${DOCS}/FEEDBACK_CURSOR.json on the branch yet"
    elif ! jq -e "$DEFS"' valid' "$BRANCH_FILE" > /dev/null 2>&1; then
      echo "::warning::${DOCS}/FEEDBACK_CURSOR.json is not a valid feedback cursor; starting from the session report markers instead."
      REASON="the branch cursor is invalid"
    elif ! jq -e --argjson pr "$PR" '.pr == $pr' "$BRANCH_FILE" > /dev/null 2>&1; then
      REASON="the branch cursor belongs to another PR"
    fi
    if [ -z "$REASON" ]; then
      cp "$BRANCH_FILE" "$SESSION_FILE.tmp.$$" && mv -f "$SESSION_FILE.tmp.$$" "$SESSION_FILE" \
        || { rm -f "$SESSION_FILE.tmp.$$"; fail "cannot write the in-session cursor"; }
      touch "$TRACKED" || fail "cannot mark the cursor as tracked"
      echo "Feedback cursor: loaded from ${DOCS}/FEEDBACK_CURSOR.json (rev $(jq -r '.rev // 0' "$SESSION_FILE"))."
    else
      jq -e 'test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")' <<< "\"$SINCE\"" > /dev/null 2>&1 \
        || fail "bad legacy cursor time"
      jq -n --argjson pr "$PR" --arg s "$SINCE" \
        '{version: 1, rev: 0, pr: $pr, floor: $s, watermark: $s, safe_at: $s, delivered: [], replay: null, replay_done: [], updated: null}' \
        > "$SESSION_FILE.tmp.$$" && mv -f "$SESSION_FILE.tmp.$$" "$SESSION_FILE" \
        || { rm -f "$SESSION_FILE.tmp.$$"; fail "cannot write the in-session cursor"; }
      echo "Feedback cursor: ${REASON}; starting after ${SINCE} (from the session report markers)."
    fi
  fi
  if [ ! -e "$RT/feedback-safe-at-start" ]; then
    jq -r '.safe_at' "$SESSION_FILE" > "$RT/feedback-safe-at-start" 2>/dev/null || fail "cannot record the starting cursor"
  fi
  init_replay "$ITEMS" || exit "$?"
  # Handled (applied, continued, ignored or completed) once it got this far.
  touch "$REPLAY_HANDLED" 2>/dev/null || true
}

# A replay request is handled once per session (feedback.sh runs again after
# every segment, and a finished replay must not restart from the same input).
init_replay() {
  local ITEMS="$1" SRC="" RAW="" KEY="" NODE="" FOUND APPLY="" OLD
  local IN VAR
  IN="$(printf '%s' "${LEXI_FEEDBACK_REPLAY_INPUT:-}" | tr -d '[:space:]')"
  VAR="$(printf '%s' "${LEXI_FEEDBACK_REPLAY_VAR:-}" | tr -d '[:space:]')"
  if [ ! -e "$REPLAY_HANDLED" ]; then
    if [ -n "$IN" ]; then SRC=input; RAW="$IN"
    elif [ -n "$VAR" ]; then SRC=variable; RAW="$VAR"
    elif [ -s "$REPLAY_REQUEST" ]; then
      SRC="$(head -n 1 "$REPLAY_REQUEST")"; RAW="$(sed -n 2p "$REPLAY_REQUEST")"
    fi
  fi
  if [ -n "$SRC" ]; then
    RAW="$(printf '%s' "$RAW" | tr -d '[:space:]')"
    if [ "${#RAW}" -gt 100 ]; then RAW="invalid"; fi
    if [[ "$RAW" =~ ^[1-9][0-9]{0,19}$ ]]; then KEY="comment:$RAW"
    elif [[ "$RAW" =~ ^(comment|review|inline):[1-9][0-9]{0,19}$ ]]; then KEY="$RAW"
    elif [[ "$RAW" =~ ^(IC|PRR|PRRC)_[A-Za-z0-9_-]{4,80}$ ]]; then NODE="$RAW"
    else
      echo "::error::The replay request (replay_from_comment or LEXI_FEEDBACK_REPLAY_FROM) is not a comment id. Use the comment's number, comment:/review:/inline:<number>, or its node ID."
      exit 3
    fi
    FOUND="$(jq -c --arg k "$KEY" --arg n "$NODE" \
      'map(select(($k != "" and .key == $k) or ($n != "" and .node_id == $n))) | first // empty' "$ITEMS")" \
      || fail "cannot resolve the replay request"
    if [ -z "$FOUND" ]; then
      echo "::warning::Replay from ${KEY:-$NODE} was requested (${SRC}), but no such comment is on this PR; ignored."
    else
      KEY="$(jq -r '.key' <<< "$FOUND")"
      OLD="$(jq -r '.replay.from_key // empty' "$SESSION_FILE")"
      if [ "$OLD" = "$KEY" ]; then
        echo "Replay from ${KEY} is in progress; continuing it."
      elif [ -n "$OLD" ] && [ "$SRC" = "variable" ]; then
        echo "::warning::Replay from ${OLD} is in progress; LEXI_FEEDBACK_REPLAY_FROM=${KEY} waits until it completes."
      elif [ -z "$OLD" ] && [ "$SRC" = "variable" ] && jq -e --arg k "$KEY" '(.replay_done // []) | index($k)' "$SESSION_FILE" > /dev/null; then
        echo "::notice::Replay from ${KEY} already completed; unset LEXI_FEEDBACK_REPLAY_FROM."
      else
        [ -z "$OLD" ] || echo "::notice::Replay from ${KEY} replaces the replay from ${OLD} in progress."
        APPLY="$FOUND"
      fi
    fi
  fi
  # Apply a new request and/or complete a replay with nothing left to deliver,
  # in one write. floor, delivered, watermark and safe_at are never touched.
  if [ -z "$APPLY" ] && ! jq -e '.replay != null' "$SESSION_FILE" > /dev/null 2>&1; then
    return 0
  fi
  local NEW="$RT/feedback-cursor.init.$$" RESULT
  RESULT="$(jq -c --slurpfile items "$ITEMS" --argjson apply "${APPLY:-null}" "$DEFS"'
    . as $c
    | (if $apply != null then
         .replay = {from_key: $apply.key, from_at: $apply.at, from_rank: $apply.rank, from_id: $apply.id, delivered: []}
       else . end) as $n
    | ($n | replay_pending($items[0]) | length) as $left
    | if $left == 0 then {changed: true, empty: true, key: $n.replay.from_key,
                         cursor: ($n | complete_replay | .rev = ((.rev // 0) + 1) | .updated = updated("init"))}
      elif $apply != null then {changed: true, empty: false, key: $n.replay.from_key,
                         cursor: ($n | .rev = ((.rev // 0) + 1) | .updated = updated("init"))}
      else {changed: false, key: $n.replay.from_key} end
  ' "$SESSION_FILE")" || fail "cannot apply the replay request"
  if [ "$(jq -r '.changed' <<< "$RESULT")" != "true" ]; then return 0; fi
  jq '.cursor' <<< "$RESULT" > "$NEW" || { rm -f "$NEW"; fail "cannot apply the replay request"; }
  write_both "$NEW"
  rm -f "$NEW"
  KEY="$(jq -r '.key' <<< "$RESULT")"
  if [ "$(jq -r '.empty' <<< "$RESULT")" = "true" ]; then
    echo "::notice::Replay from ${KEY} has nothing to deliver; marked complete."
  else
    echo "Replay from ${KEY} requested; it is saved in ${DOCS}/FEEDBACK_CURSOR.json and delivered in batches."
  fi
  if [ -n "$SRC" ]; then printf '%s\n%s\n' "$SRC" "$KEY" > "$REPLAY_REQUEST" 2>/dev/null || true; fi
  return 0
}

cmd_commit() {
  local SEG="$1" SNAP="$2"
  local B="$SNAP/batch.json" P="$SNAP/pending.json" NEW="$RT/feedback-cursor.commit.$$"
  [ -s "$B" ] && [ -s "$P" ] || fail "the batch snapshot is incomplete"
  [ -s "$SESSION_FILE" ] || fail "there is no in-session cursor"
  jq -e -n --slurpfile b "$B" --slurpfile p "$P" "$DEFS"'
    ($b[0]) as $b | ($p[0]) as $p
    | ($b | type == "object") and ($p | type == "array")
    and ($b.keys | type == "array" and length > 0 and all(.[]; key_ok))
    and ($b.items | type == "array" and length == ($b.keys | length) and all(.[]; (.key | key_ok) and (.at | iso)))
    and ($b.cursor_rev | type == "number")
    and (($p | map({(.key): true}) | add // {}) as $pk | all($b.keys[]; $pk[.]))
  ' > /dev/null 2>&1 || fail "the batch snapshot is not valid"
  jq -e "$DEFS"' valid' "$SESSION_FILE" > /dev/null 2>&1 || fail "the in-session cursor is not valid"
  local REV CREV
  REV="$(jq -r '.rev // 0' "$SESSION_FILE")"
  CREV="$(jq -r '.cursor_rev' "$B")"
  [ "$REV" = "$CREV" ] || fail "cursor changed since this batch was prepared (rev ${REV} != ${CREV})"
  jq --slurpfile b "$B" --slurpfile p "$P" --arg seg "$SEG" "$DEFS"'
    ($b[0]) as $b | ($p[0]) as $p
    | .floor as $oldfloor
    | ($b.items | map({key, at})) as $batch
    | ($b.keys | map({(.): true}) | add) as $bk
    | .delivered = ((.delivered + ($batch | map(select(.at > $oldfloor)))) | unique_by(.key))
    | .watermark = ([.watermark] + ($batch | map(.at)) | max)
    | (if .replay != null then
         .replay.delivered = ((.replay.delivered + [$p[] | select(.replay == true and $bk[.key]) | .key]) | unique)
       else . end)
    | (.replay.delivered // [] | map({(.): true}) | add // {}) as $rdone
    | (if .replay != null and ([$p[] | select(.replay == true and ($rdone[.key] | not))] | length) == 0
       then complete_replay else . end)
    | (.delivered | map({(.key): true}) | add // {}) as $dk
    | ([$p[] | select(.normal == true and ($dk[.key] | not)) | .at] | min) as $earliest
    | (.watermark | fromdateiso8601 - 604800 | todateiso8601) as $lookback
    | .floor = max2($oldfloor; (if $earliest == null then $lookback else min2($lookback; $earliest | minus1s) end))
    | .floor as $f
    | .delivered = (.delivered | map(select(.at > $f)))
    | .safe_at = max2(.safe_at; (if $earliest == null then .watermark else ($earliest | minus1s) end))
    | .rev = ($b.cursor_rev + 1)
    | .updated = updated($seg)
  ' "$SESSION_FILE" > "$NEW" 2>/dev/null || { rm -f "$NEW"; fail "cannot compute the new cursor"; }
  # write_both validates before each rename and exits 2 on any failure.
  ( write_both "$NEW" ) || { local RC=$?; rm -f "$NEW"; exit "$RC"; }
  rm -f "$NEW"
  touch "$RT/feedback-committed" 2>/dev/null || true
  mkdir -p "$RT/feedback" 2>/dev/null || true
  cp "$B" "$RT/feedback/batch-consumed-${SEG}.json" 2>/dev/null || true
  if cmp -s "$RT/feedback/batch.json" "$B"; then rm -f "$RT/feedback/batch.json"; fi
  jq -r --arg seg "$SEG" '"segment \($seg): \(.keys | length) comment(s), \(.bytes) bytes, \(.keys[0])..\(.keys[-1])"' "$B" \
    >> "$RT/feedback-delivered.log" 2>/dev/null || true
  jq -n --slurpfile b "$B" --slurpfile p "$P" \
    '($b[0].keys | map({(.): true}) | add) as $bk | [$p[0][] | select($bk[.key] | not)] | length' \
    > "$RT/feedback-pending" 2>/dev/null || true
  echo "Feedback cursor advanced past $(jq -r '.keys | length' "$B") comment(s) (rev $(jq -r '.rev' "$SESSION_FILE"))."
}

cmd_restore() {
  [ -e "$TRACKED" ] || exit 0
  [ -s "$SESSION_FILE" ] || fail "there is no in-session cursor"
  if [ -f "$BRANCH_FILE" ] && cmp -s "$SESSION_FILE" "$BRANCH_FILE"; then exit 0; fi
  mkdir -p "$BRANCH_DIR" 2>/dev/null || fail "cannot create ${DOCS}"
  cp "$SESSION_FILE" "$BRANCH_FILE.tmp.$$" 2>/dev/null && mv -f "$BRANCH_FILE.tmp.$$" "$BRANCH_FILE" 2>/dev/null \
    || { rm -f "$BRANCH_FILE.tmp.$$" 2>/dev/null; fail "cannot restore ${DOCS}/FEEDBACK_CURSOR.json"; }
  echo "::warning::${DOCS}/FEEDBACK_CURSOR.json was changed during the segment; restored. The workflow owns this file."
}

cmd_safe_at() {
  if [ -e "$TRACKED" ]; then
    jq -r '.safe_at // empty' "$SESSION_FILE" 2>/dev/null || true
  elif [ -s "$RT/feedback-safe-at-start" ]; then
    cat "$RT/feedback-safe-at-start"
  fi
  exit 0
}

CMD="${1:-}"
shift || true
case "$CMD" in
  init) [ "$#" -eq 3 ] || fail "usage: init <pr> <legacy_since> <items.json>"; cmd_init "$@" ;;
  commit) [ "$#" -eq 2 ] || fail "usage: commit <segment> <snapshot_dir>"; cmd_commit "$@" ;;
  restore) cmd_restore ;;
  safe-at) cmd_safe_at ;;
  *) fail "usage: feedback-cursor.sh init|commit|restore|safe-at" ;;
esac
