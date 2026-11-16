#!/usr/bin/env bash
# usage: feedback.sh
#
# Collects what NAMED people said on the build PR since the last session
# report: PR comments, review summaries and inline review comments whose
# author is in LEXI_FEEDBACK_AUTHORS (comma-separated GitHub logins). The entry
# `*` admits every person (a GitHub account of type User, never a bot) whose
# association with the repository is OWNER, MEMBER or COLLABORATOR: not a
# contributor, a first-time commenter or anyone else who can merely comment on a
# public repository. Named bots, and anyone else, still need their own entry. Anyone else's comment is dropped and
# only counted, never shown to the builder: the builder runs unattended with
# staging credentials, so what it reads as a request must come from someone the
# caller chose. An empty allowlist means no feedback at all.
#
# Feedback is delivered in bounded batches, one per builder segment, and only
# comments the feedback cursor (feedback-cursor.sh) has not seen processed are
# candidates. Nothing here advances the cursor: segment.sh commits a batch
# only after the builder processed it. A comment too large for a batch is
# written whole to $GITHUB_WORKSPACE/.lexi-feedback/ (git-excluded) and the
# batch points at it. LEXI_FEEDBACK_BATCH_BYTES / LEXI_FEEDBACK_BATCH_TOKENS
# bound a batch (defaults 30000 / 10000; kept small because a segment that
# reaches its deadline commits its whole batch); LEXI_FEEDBACK_REPLAY_INPUT /
# LEXI_FEEDBACK_REPLAY_VAR request a replay from a given comment.
#
# Writes $RUNNER_TEMP/feedback.md (empty when there is none), the batch files
# $RUNNER_TEMP/feedback/{batch,pending,items}.json, the latest
# assessment comment plus the PR head's failing checks to
# $RUNNER_TEMP/assessment.md, and, when the PR
# carries the `app-build:stop` label or was closed, $RUNNER_TEMP/stop-reason.
#
# The build PR is the newest PR whose head is LEXI_BRANCH in this repository
# itself. A fork's PR from a branch of the same name is never it: its comments
# would otherwise steer a builder that holds staging credentials.
set -uo pipefail

: > "$RUNNER_TEMP/feedback.md"
REPO="$GITHUB_REPOSITORY"
# Admitted: a named author, or any person (not a bot) when `*` is listed.
ADMITTED='def admitted($allowed): ((.who | ascii_downcase) as $w | $allowed | index($w)) or (.human == true and (.assoc // "" | IN("OWNER", "MEMBER", "COLLABORATOR")) and ($allowed | index("*")));'
ALLOWED="$(printf '%s' "${LEXI_FEEDBACK_AUTHORS:-}" | tr 'A-Z' 'a-z' | tr -d ' ' | jq -R -c 'split(",") | map(select(length > 0))')"

PR_JSON="$(gh pr list --repo "$REPO" --head "$LEXI_BRANCH" --state all --json number,state,labels,isCrossRepository,headRepositoryOwner \
  | jq -c --arg owner "${REPO%%/*}" '[.[] | select(.isCrossRepository == false and ((.headRepositoryOwner.login // "") | ascii_downcase) == ($owner | ascii_downcase))] | sort_by(.number) | last // empty')"
if [ -z "$PR_JSON" ]; then
  echo "No PR for ${LEXI_BRANCH} yet; no feedback to read."
  exit 0
fi
PR="$(jq -r '.number' <<< "$PR_JSON")"
STATE="$(jq -r '.state' <<< "$PR_JSON")"
if [ "$STATE" != "OPEN" ]; then
  echo "the build PR #${PR} is ${STATE,,}" > "$RUNNER_TEMP/stop-reason"
  exit 0
fi
printf '%s' "$PR" > "$RUNNER_TEMP/pr-number"
if jq -e '.labels | map(.name) | index("app-build:stop")' <<< "$PR_JSON" > /dev/null; then
  echo "the build PR #${PR} carries the app-build:stop label" > "$RUNNER_TEMP/stop-reason"
  exit 0
fi

# A replay request is kept for the later runs of this session (the refresh
# steps do not get it), in case this run cannot read the PR's comments.
if [ ! -s "$RUNNER_TEMP/feedback-replay-request" ]; then
  REPLAY_IN="$(printf '%s' "${LEXI_FEEDBACK_REPLAY_INPUT:-}" | tr -d '[:space:]' | head -c 200)"
  REPLAY_VAR="$(printf '%s' "${LEXI_FEEDBACK_REPLAY_VAR:-}" | tr -d '[:space:]' | head -c 200)"
  if [ -n "$REPLAY_IN" ]; then printf 'input\n%s\n' "$REPLAY_IN" > "$RUNNER_TEMP/feedback-replay-request"
  elif [ -n "$REPLAY_VAR" ]; then printf 'variable\n%s\n' "$REPLAY_VAR" > "$RUNNER_TEMP/feedback-replay-request"; fi
fi

# The window starts where the PREVIOUS session's processed feedback ends.
# With a cursor file on the branch (feedback-cursor.sh) that file decides.
# Without one, the latest `feedback-read-at` marker in a session report does:
# since the cursor fix it is the processed-through time, never the time the
# comments were read (otherwise a session that never started its builder
# would publish its read time, and its comments would never be retried).
# Reports from before any marker existed fall back to the second-latest
# report; reports written since the fix carry `feedback-cursor=v1` and never
# move that fallback.
FETCH_OK=1
COMMENTS="$(gh api --paginate "repos/${REPO}/issues/${PR}/comments" --jq '.[] | {id: .id, node_id: .node_id, key: ("comment:" + (.id | tostring)), rank: 0, at: .created_at, who: .user.login, human: (.user.type == "User"), assoc: .author_association, body: .body, kind: "comment"}' | jq -s '.')" || FETCH_OK=0
SINCE="$(jq -r '
  map(select(.body | contains("<!-- app-build:report -->"))) as $reports
  | ([$reports[].body | capture("app-build:feedback-read-at=(?<t>[0-9TZ:-]+)")? | .t] | max) as $marked
  | if $marked != null then $marked
    elif ([$reports[] | select(.body | contains("<!-- app-build:feedback-cursor=v1 -->") | not)] | length) >= 2
      then ([$reports[] | select(.body | contains("<!-- app-build:feedback-cursor=v1 -->") | not) | .at] | sort | .[-2])
    else "1970-01-01T00:00:00Z" end
' <<< "$COMMENTS")"
# The latest assessment (checks + independent review), posted by the
# workflow's assess job after the previous session. It is the builder's
# to-do list, not feedback, so it goes to its own file.
jq -r '
  map(select(.body | contains("<!-- app-build:assessment"))) | sort_by(.at) | last // empty | .body
' <<< "$COMMENTS" | grep -v '^<!-- app-build:' | head -c 30000 > "$RUNNER_TEMP/assessment.md" || true

# The PR's own checks can run what the assessment does not (other settings,
# other suites), so their failures go to the builder too: each check's latest
# run on the PR head, with the log lines leading up to its first error.
ci_excerpt() { # job id -> at most 40 lines ending at the first error
  local LOG
  # gh refuses a log with terminal escapes when stdout is not a terminal; older gh lacks the flag.
  # The fallback's error, if any, goes to the job log.
  if ! LOG="$(gh api --allow-escape-sequences "repos/${REPO}/actions/jobs/$1/logs" 2> /dev/null \
              || gh api "repos/${REPO}/actions/jobs/$1/logs")" || [ -z "$LOG" ]; then
    echo "(The log could not be read; open the link.)"
    return 0
  fi
  printf '%s\n' "$LOG" \
    | sed -E $'s/\x1b\\[[0-9;?]*[ -/]*[@-~]//g; s/\x1b\\][^\x07]*\x07//g; s/^[0-9T:.-]+Z //' | tr -d '\033' | cut -c1-300 \
    | awk '{ line[NR % 40] = $0 } /##\[error\]/ { stop = NR; exit }
           END { last = stop ? stop : NR; for (i = last - 39; i <= last; i++) if (i > 0) print line[i % 40] }'
}
redact() { # fail closed: without node the excerpts cannot be redacted, so they are left out
  if command -v node > /dev/null; then node "$(dirname "$0")/redact-output.mjs"
  else echo; echo "### Failing PR checks"; echo; echo "Some PR checks failed, but their logs could not be redacted on this runner. Look at the PR page."; fi
}
HEAD_SHA="$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq '.headRefOid' 2> /dev/null || true)"
if FAILED="$(gh api --paginate "repos/${REPO}/commits/${HEAD_SHA:-none}/check-runs" --jq '.check_runs[]' \
    | jq -sc 'group_by([.check_suite.id, .name]) | map(max_by(.id)) | map(select(.conclusion == "failure" or .conclusion == "timed_out"))')"; then
  if [ "$FAILED" != "[]" ]; then
    {
      echo
      echo "### Failing PR checks"
      echo
      echo "These are the PR's own CI checks on \`${HEAD_SHA:0:7}\`. They can use settings the checks above do not. Fix them first."
      jq -r '.[:5][] | "\(.id)\t\(.name)\t\(.html_url)"' <<< "$FAILED" | while IFS=$'\t' read -r ID NAME URL; do
        echo
        echo "#### ${NAME}: ${URL}"
        echo
        echo '````'
        ci_excerpt "$ID"
        echo '````'
      done
      OMITTED=$(( $(jq 'length' <<< "$FAILED") - 5 ))
      if [ "$OMITTED" -gt 0 ]; then echo; echo "${OMITTED} more failing check(s) are not shown; see the PR page."; fi
    } | redact >> "$RUNNER_TEMP/assessment.md"
  fi
else
  printf '\n### Failing PR checks\n\nThe PR'"'"'s checks could not be read this time. Look at the PR page before claiming they pass.\n' >> "$RUNNER_TEMP/assessment.md"
fi

REVIEWS="$(gh api --paginate "repos/${REPO}/pulls/${PR}/reviews" --jq '.[] | select((.body // "") != "") | select(.submitted_at != null) | {id: .id, node_id: .node_id, key: ("review:" + (.id | tostring)), rank: 1, at: .submitted_at, who: .user.login, human: (.user.type == "User"), assoc: .author_association, body: .body, kind: "review"}' | jq -s '.')" || FETCH_OK=0
INLINE="$(gh api --paginate "repos/${REPO}/pulls/${PR}/comments" --jq '.[] | {id: .id, node_id: .node_id, key: ("inline:" + (.id | tostring)), rank: 2, at: .created_at, who: .user.login, human: (.user.type == "User"), assoc: .author_association, body: ("On `" + .path + "`: " + .body), kind: "inline"}' | jq -s '.')" || FETCH_OK=0

# No allowlist: nothing is admitted, and the cursor is not used.
if [ -z "$ALLOWED" ] || [ "$ALLOWED" = "[]" ]; then
  ALLOWED="[]"
  NEW="$(jq -c --arg since "$SINCE" -s '
    add
    | map(select(.at > $since
        and (.body | contains("<!-- app-build:report -->") | not)
        and (.body | contains("<!-- app-build:assessment") | not)))
    | sort_by(.at)
  ' <(echo "$COMMENTS") <(echo "$REVIEWS") <(echo "$INLINE"))"
  DROPPED="$(jq --argjson allowed "$ALLOWED" "$ADMITTED"'[.[] | select(admitted($allowed) | not)] | length' <<< "$NEW")"
  echo "PR #${PR} since ${SINCE}: 0 comment(s) from named people passed to the builder; ${DROPPED} from anyone else ignored."
  exit 0
fi

# ---- batches ------------------------------------------------------------
FB="$RUNNER_TEMP/feedback"
REFS="$GITHUB_WORKSPACE/.lexi-feedback"
note() { printf '%s\n' "$1" > "$RUNNER_TEMP/feedback.md"; }
# Anything half-written is removed, so segment.sh never sees a batch whose
# files do not all exist. Nothing is skipped: the cursor did not move.
cannot_prepare() {
  rm -f "$FB/batch.json" "$FB/pending.json" "$FB"/*.tmp "$RUNNER_TEMP/feedback.md.tmp" "$RUNNER_TEMP/feedback-pending.tmp" 2>/dev/null
  rm -f "$REFS"/ref-* 2>/dev/null
  echo "::error::Feedback could not be prepared ($1); no feedback this segment, nothing is skipped."
  note "_Feedback could not be prepared for this segment; nothing is skipped._"
  exit 0
}
# put <dest> <jq filter> <file>: write the filter's raw output, then rename.
put() { jq -j "$2" "$3" > "$1.tmp" && mv -f "$1.tmp" "$1"; }

rm -rf "$FB"
mkdir -p "$FB" || { echo "::error::Feedback could not be prepared (work dir); no feedback this segment, nothing is skipped."; note "_Feedback could not be prepared for this segment; nothing is skipped._"; exit 0; }
# Reference files for oversized comments live in the workspace (the builder's
# Read tool reaches them) and are git-excluded like reference/ and intake/.
REFS_OK=0
if mkdir -p "$GITHUB_WORKSPACE/.git/info" 2>/dev/null \
   && { grep -qxF '/.lexi-feedback/' "$GITHUB_WORKSPACE/.git/info/exclude" 2>/dev/null \
        || echo '/.lexi-feedback/' >> "$GITHUB_WORKSPACE/.git/info/exclude"; } 2>/dev/null \
   && grep -qxF '/.lexi-feedback/' "$GITHUB_WORKSPACE/.git/info/exclude" 2>/dev/null; then
  rm -rf "$REFS" && mkdir -p "$REFS" && REFS_OK=1
fi

if [ -e "$RUNNER_TEMP/feedback-cursor-error" ]; then
  note "_Feedback delivery is paused for this session: the feedback cursor could not be saved._"
  echo "PR #${PR}: feedback delivery is paused for this session (the feedback cursor could not be saved)."
  exit 0
fi
rm -f "$RUNNER_TEMP/feedback-pending"
if [ "$FETCH_OK" != 1 ]; then
  echo "::warning::The PR's comments could not be read; no feedback this segment, nothing is skipped."
  note "_The PR's comments could not be read this segment; nothing is skipped._"
  exit 0
fi

# Every fetched item, tagged with the one eligibility rule used for normal
# delivery and for replay alike; one entry per identity, oldest first.
ELIGIBLE="$ADMITTED"'
def eligible($allowed): admitted($allowed)
  and (.body | contains("<!-- app-build:report -->") | not)
  and (.body | contains("<!-- app-build:assessment") | not);'
jq -c -s --argjson allowed "$ALLOWED" "$ELIGIBLE"'
  add | map(. + {eligible: eligible($allowed)}) | unique_by(.key) | sort_by([.at, .rank, .id])
' <(echo "$COMMENTS") <(echo "$REVIEWS") <(echo "$INLINE") > "$FB/items.json" 2>/dev/null \
  || cannot_prepare "comment list"

INIT_ERR="$FB/init.stderr"
"$(dirname "$0")/feedback-cursor.sh" init "$PR" "$SINCE" "$FB/items.json" 2> "$INIT_ERR"
INIT_RC=$?
case "$INIT_RC" in
  0) ;;
  3)
    echo "replay_from_comment (or LEXI_FEEDBACK_REPLAY_FROM) is not a comment id" > "$RUNNER_TEMP/stop-reason"
    exit 0 ;;
  *)
    echo "::error::Feedback cursor could not be loaded ($(head -n 1 "$INIT_ERR" 2>/dev/null | tr -d '\r' | cut -c1-200)); no feedback this segment, nothing is skipped."
    rm -f "$FB/batch.json" "$FB/pending.json"
    note "_The feedback cursor could not be loaded this segment; nothing is skipped._"
    exit 0 ;;
esac

limit() { # variable name, default, min, max
  local V="${!1:-}"
  if [ -z "$V" ]; then echo "$2"; return; fi
  if [[ "$V" =~ ^[0-9]{1,7}$ ]] && [ "$((10#$V))" -ge "$3" ] && [ "$((10#$V))" -le "$4" ]; then echo "$((10#$V))"; return; fi
  echo "::warning::$1 must be a whole number from $3 to $4; using $2." >&2
  echo "$2"
}
MAX_BYTES="$(limit LEXI_FEEDBACK_BATCH_BYTES 30000 4096 400000)"
MAX_TOKENS="$(limit LEXI_FEEDBACK_BATCH_TOKENS 10000 1000 200000)"

# Candidates: eligible and not processed according to the cursor (or inside a
# replay). Greedy partition in order; a comment is never split, and one over
# either limit on its own is a batch by itself, delivered by reference.
PLAN="$FB/plan.json"
jq -c --slurpfile cur "$RUNNER_TEMP/feedback-cursor.json" --argjson maxb "$MAX_BYTES" --argjson maxt "$MAX_TOKENS" \
  --arg refs "$REFS" --argjson allowed "$ALLOWED" "$ADMITTED"'
  def entry: "- **\(.who)** (\(.at), \(.kind)): \(.body | gsub("\r"; ""))\n";
  def commas: tostring | if length > 3 then (.[:-3] | commas) + "," + .[-3:] else . end;
  ([$maxb, $maxt * 3] | min) as $limit
  | $cur[0] as $c
  | ($c.delivered | map({(.key): true}) | add // {}) as $dk
  | $c.replay as $r
  | (($r.delivered // []) | map({(.): true}) | add // {}) as $rk
  | . as $items
  | [ $items[] | select(.eligible == true)
      | (.at > $c.floor and ($dk[.key] | not)) as $normal
      | ($r != null and ([.at, .rank, .id] >= [$r.from_at, $r.from_rank, $r.from_id]) and ($rk[.key] | not)) as $replay
      | select($normal or $replay)
      | entry as $e
      | . + {normal: $normal, replay: $replay, entry: $e, bytes: ($e | utf8bytelength)}
      | .tokens = ((.bytes + 2) / 3 | floor) ] as $cand
  | ($cand | reduce .[] as $it ({done: [], cur: [], b: 0, t: 0};
      if $it.bytes > $maxb or $it.tokens > $maxt then
        .done += (if (.cur | length) > 0 then [.cur] else [] end) + [[$it + {oversized: true}]] | .cur = [] | .b = 0 | .t = 0
      elif .b + $it.bytes > $maxb or .t + $it.tokens > $maxt then
        .done += [.cur] | .cur = [$it] | .b = $it.bytes | .t = $it.tokens
      else .cur += [$it] | .b += $it.bytes | .t += $it.tokens end)
    | .done + (if (.cur | length) > 0 then [.cur] else [] end)) as $batches
  | ($batches[0] // []) as $first
  | (($first | length) == 1 and ($first[0].oversized == true)) as $over
  | (if $over then
      $first[0]
      | ("\(.kind)-\(.id)") as $base
      | (.body | split("\n") | map(length) | max) as $longest
      | {exact: "\($refs)/ref-\($base).md", longest: $longest,
         folded: (if $longest > 1900 then "\($refs)/ref-\($base).folded.md" else null end),
         body: .body,
         folded_body: (if $longest > 1900 then
             (.body | split("\n") | map(if length > 1900 then [range(0; length; 1900) as $i | .[$i:$i+1900]] | (.[0:1] + (.[1:] | map("↳ " + .))) | join("\n") else . end) | join("\n"))
           else null end)}
    else null end) as $ref
  | ($first | map(.bytes) | add // 0) as $fbytes
  | ($cand | length) as $total
  | {
      total: $total,
      batches: ($batches | length),
      first_count: ($first | length),
      first_bytes: $fbytes,
      oversized: $over,
      ref: $ref,
      key0: ($first[0].key // null),
      who0: ($first[0].who // null),
      floor: $c.floor,
      delivered: ($c.delivered | length),
      replay: ($r.from_key // null),
      ignored: ([$items[] | select(.at > $c.floor
                  and (.body | contains("<!-- app-build:report -->") | not)
                  and (.body | contains("<!-- app-build:assessment") | not)
                  and (admitted($allowed) | not))] | length),
      pending: [$cand[] | {key, at, who, bytes, normal, replay}],
      items: [$first[] | {key, at, who, bytes}],
      markdown: (if $total == 0 then "" else
        "_Feedback batch 1 of \($batches | length): \($first | length) comment(s), \($fbytes | commas) bytes, oldest first."
        + (if $total > ($first | length) then " \($total - ($first | length)) more wait for later segments; do not wait for them." else "" end)
        + "_\n"
        + (if $r != null then "_Replay from \($r.from_key) requested by a maintainer: some of these were delivered before._\n" else "" end)
        + (if $over then
             $first[0] | "- **\(.who)** (\(.at), \(.kind)): [This comment is \(.bytes) bytes, over the \($limit)-byte batch limit, so it is not inlined. Read it in full from `\($ref.folded // $ref.exact)` before acting on other work. "
               + (if $ref.folded != null then "Lines longer than 1,900 characters are folded there: a line starting with `↳ ` continues the previous line. The exact text is in `\($ref.exact)`. " else "" end)
               + "If the file is too large to read at once, read it in parts (offset/limit) until the end.]\n"
           else ($first | map(.entry) | join("")) end)
        end),
      limit: $limit
    }
' "$FB/items.json" > "$PLAN" 2>/dev/null || cannot_prepare "batches"

TOTAL="$(jq -r '.total' "$PLAN")" || cannot_prepare "batches"
if [ "$TOTAL" = "0" ]; then
  : > "$RUNNER_TEMP/feedback.md"
  printf '0' > "$RUNNER_TEMP/feedback-pending"
else
  if [ "$(jq -r '.oversized' "$PLAN")" = "true" ]; then
    [ "$REFS_OK" = 1 ] || cannot_prepare "the reference file cannot be git-excluded"
    EXACT="$(jq -r '.ref.exact' "$PLAN")"
    put "$EXACT" '.ref.body' "$PLAN" || cannot_prepare "reference file"
    REF="$EXACT"
    FOLDED="$(jq -r '.ref.folded // empty' "$PLAN")"
    if [ -n "$FOLDED" ]; then
      put "$FOLDED" '.ref.folded_body' "$PLAN" || cannot_prepare "folded reference file"
      REF="$FOLDED"
    fi
    echo "::warning::Feedback $(jq -r '.key0' "$PLAN") by $(jq -r '.who0' "$PLAN") is $(jq -r '.items[0].bytes' "$PLAN") bytes (limit $(jq -r '.limit' "$PLAN")); delivered alone by reference$( [ -n "$FOLDED" ] && echo "; folded for reading (longest line $(jq -r '.ref.longest' "$PLAN") chars)")."
  fi
  put "$FB/pending.json" '.pending' "$PLAN" || cannot_prepare "pending list"
  put "$RUNNER_TEMP/feedback.md" '.markdown' "$PLAN" || cannot_prepare "feedback text"
  FEEDBACK_BYTES="$(wc -c < "$RUNNER_TEMP/feedback.md" | tr -d ' ')"
  REV="$(jq -r '.rev // 0' "$RUNNER_TEMP/feedback-cursor.json")" || cannot_prepare "cursor"
  jq -r '.total' "$PLAN" > "$RUNNER_TEMP/feedback-pending.tmp" && mv -f "$RUNNER_TEMP/feedback-pending.tmp" "$RUNNER_TEMP/feedback-pending" \
    || cannot_prepare "pending count"
  jq --argjson rev "$REV" --argjson fb "$FEEDBACK_BYTES" --arg ref "${REF:-}" '
    {keys: (.items | map(.key)),
     items: (if $ref != "" then .items | (.[0].ref = $ref) else .items end),
     bytes: .first_bytes,
     tokens_est: ((.first_bytes + 2) / 3 | floor),
     oversized: .oversized,
     replay: .replay,
     index: 1,
     batches: .batches,
     pending_total: .total,
     cursor_rev: $rev,
     feedback_bytes: $fb}
  ' "$PLAN" > "$FB/batch.json.tmp" 2>/dev/null && mv -f "$FB/batch.json.tmp" "$FB/batch.json" || cannot_prepare "batch"
fi
jq -r --argjson maxb "$MAX_BYTES" --argjson maxt "$MAX_TOKENS" --arg pr "$PR" '
  "PR #\($pr): cursor floor \(.floor), \(.delivered) delivered key(s)\(if .replay then ", replay from \(.replay)" else "" end); "
  + "\(.total) pending comment(s) from named people in \(.batches) batch(es) (≤\($maxb) bytes, ≤\($maxt) tokens each); "
  + "this segment gets \(.first_count) comment(s), \(.first_bytes) bytes\(if .first_count > 0 then " (\(.items[0].key)..\(.items[-1].key))" else "" end); "
  + "\(.ignored) from anyone else ignored."
' "$PLAN" 2>/dev/null || true
rm -f "$PLAN"
