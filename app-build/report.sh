#!/usr/bin/env bash
# usage: report.sh session|assessment
#
# session    — posted by the build job when a session ends: the builder's own
#              LAST_SESSION.md, the phase gate verdicts, what the session cost,
#              and whether the loop goes on.
# assessment — posted by the assess job, which runs beside the next session:
#              the check table, the screens that differ most from the
#              prototype (app / prototype / diff images side by side) and the
#              independent code review. The builder's next segment reads the
#              latest assessment comment (feedback.sh) and fixes it first.
#
# Images are pushed to the orphan branch `app-build-reports` so the app
# branch never carries them.
set -uo pipefail
source "$(dirname "$0")/git-auth.sh"

MODE="${1:-session}"
PR="$(cat "$RUNNER_TEMP/pr-number" 2>/dev/null || true)"
if [ -z "$PR" ]; then
  echo "::warning::No PR to report on."
  exit 0
fi
OUT="$RUNNER_TEMP/checks"
APP_ROOT="$GITHUB_WORKSPACE/$LEXI_APP_DIR"
DOCS_DIR="${LEXI_DOCS_DIR:-$LEXI_APP_DIR/docs/build}"
REPORT_DIR="${LEXI_BUILD_ID:-$LEXI_APP}/s${LEXI_SESSION}-${GITHUB_RUN_ID}"
BODY="$RUNNER_TEMP/report.md"
IMAGE_BASE="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/blob/app-build-reports/${REPORT_DIR}"

# ---- images -----------------------------------------------------------
IMAGES_PUSHED=""
if [ -s "$OUT/visual/visual.json" ]; then
  STAGE="$RUNNER_TEMP/report-images"
  mkdir -p "$STAGE/$REPORT_DIR"
  jq -r 'map(select(.status == "compared")) | sort_by(-.mismatchPct) | .[0:12][] | .app, .prototype, .diff' "$OUT/visual/visual.json" \
    | while read -r F; do [ -f "$F" ] && cp "$F" "$STAGE/$REPORT_DIR/"; done
  if [ -n "$(ls -A "$STAGE/$REPORT_DIR" 2>/dev/null)" ]; then
    (
      set -e
      cd "$STAGE"
      git init -q
      git config user.name "lexi-builder"
      git config user.email "lexi-builder@users.noreply.github.com"
      REMOTE="https://github.com/${GITHUB_REPOSITORY}.git"
      # Plumbing, so a retry after a race (the other app's report landed
      # first) rebuilds on the new tip instead of dropping its files.
      for DELAY in 0 3 6 12 24; do
        sleep "$DELAY"
        if github_git fetch -q --depth 1 "$REMOTE" app-build-reports 2>/dev/null; then
          PARENT="$(git rev-parse FETCH_HEAD)"
          git read-tree "$PARENT"
        else
          PARENT=""
          git read-tree --empty
        fi
        git add -A "$REPORT_DIR"
        TREE="$(git write-tree)"
        if [ -n "$PARENT" ]; then
          COMMIT="$(git commit-tree "$TREE" -p "$PARENT" -m "report: ${REPORT_DIR}")"
        else
          COMMIT="$(git commit-tree "$TREE" -m "report: ${REPORT_DIR}")"
        fi
        if github_git push -q "$REMOTE" "${COMMIT}:refs/heads/app-build-reports"; then exit 0; fi
      done
      exit 1
    ) && IMAGES_PUSHED=1 || echo "::warning::Could not push the report images."
  fi
fi

img() { # path -> markdown image, or a dash
  if [ -n "$IMAGES_PUSHED" ] && [ -n "$1" ]; then printf '<img src="%s/%s?raw=true" width="260">' "$IMAGE_BASE" "$(node -e 'process.stdout.write(encodeURIComponent(require("node:path").basename(process.argv[1])))' "$1")"; else printf '%s' '-'; fi
}

limit_text() { # stdin, character limit; disclose every shortened excerpt
  node "$TOOLS/redact-output.mjs" | node -e '
    const text = require("node:fs").readFileSync(0, "utf8");
    const limit = Number(process.argv[1]);
    process.stdout.write(text.length > limit
      ? text.slice(0, limit) + "\n\n_Excerpt shortened. Follow the run log and linked build documents for full evidence._\n"
      : text);
  ' "$1"
}

# ---- body -------------------------------------------------------------
TOOLS="$RUNNER_TEMP/app-build"
COMMIT="$(git -C "$GITHUB_WORKSPACE" rev-parse --short HEAD)"
RUN_LINK="[Run log](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID})"

# The processed-through time for the `feedback-read-at` marker, which the next
# session reads when the branch has no feedback cursor (feedback.sh). Only a
# pushed cursor may be published: after a failed final push it is the value
# the session started from.
feedback_marker() {
  local SAFE_AT START
  SAFE_AT="$( [ -x "$TOOLS/feedback-cursor.sh" ] && "$TOOLS/feedback-cursor.sh" safe-at 2>/dev/null || true )"
  [ -n "$SAFE_AT" ] || return 0
  if [ "${PUSH_OUTCOME:-}" != "success" ]; then
    START="$(cat "$RUNNER_TEMP/feedback-safe-at-start" 2>/dev/null || true)"
    [ -n "$START" ] || return 0
    SAFE_AT="$START"
  fi
  [[ "$SAFE_AT" =~ ^[0-9TZ:-]+$ ]] || return 0
  echo "<!-- app-build:feedback-read-at=${SAFE_AT} -->"
}

feedback_line() { # what the builder was given this session; keys and counts only
  local DELIVERED BATCHES PENDING REPLAY REPLAY_DONE
  if [ -e "$RUNNER_TEMP/feedback-cursor-error" ]; then
    echo "**Feedback:** ⚠️ the feedback cursor could not be saved; the same comments will be delivered again."
    return 0
  fi
  if [ ! -e "$RUNNER_TEMP/feedback-cursor.json" ] && [ ! -e "$RUNNER_TEMP/feedback-delivered.log" ]; then return 0; fi
  if [ "${PUSH_OUTCOME:-}" != "success" ]; then
    echo "**Feedback:** ⚠️ the final push failed, so this session's feedback progress was not saved; the same comments will be delivered again."
    return 0
  fi
  DELIVERED="$(sed -n 's/^segment [0-9]*: \([0-9]*\) comment.*/\1/p' "$RUNNER_TEMP/feedback-delivered.log" 2>/dev/null | awk '{ s += $1 } END { print s + 0 }')"
  BATCHES="$(grep -c '^segment ' "$RUNNER_TEMP/feedback-delivered.log" 2>/dev/null || true)"
  PENDING="$(cat "$RUNNER_TEMP/feedback-pending" 2>/dev/null || echo 0)"
  REPLAY="$(jq -r '.replay.from_key // empty' "$RUNNER_TEMP/feedback-cursor.json" 2>/dev/null || true)"
  REPLAY_DONE="$(jq -r '(.replay.delivered // []) | length' "$RUNNER_TEMP/feedback-cursor.json" 2>/dev/null || echo 0)"
  printf '**Feedback:** %s comment(s) delivered in %s batch(es) this session; %s pending.' "${DELIVERED:-0}" "${BATCHES:-0}" "${PENDING:-0}"
  if [ -n "$REPLAY" ] && [ "${REPLAY_DONE:-0}" -gt 0 ]; then
    printf ' Replay from %s in progress.' "$REPLAY"
  elif [ -n "$REPLAY" ]; then
    printf ' Replay from %s requested; no batch processed yet (the request is saved and continues next session).' "$REPLAY"
  fi
  echo
}

cost_line() { # files... -> one line, or nothing
  local json
  json="$(node "$TOOLS/cost.mjs" "$@" 2>/dev/null || true)"
  [ -n "$json" ] || return 0
  jq -r '"**Cost:** $\(.total) (estimate at list prices) — " + ([.parts | to_entries[] | "\(.key) $\(.value.usd)"] | join(", "))' <<< "$json"
}

if [ "$MODE" = "session" ]; then
  PHASE_NOW="$(cat "$RUNNER_TEMP/phase" 2>/dev/null || echo build)"
  PHASE_NEXT="$(tr -d '[:space:]' < "$GITHUB_WORKSPACE/$DOCS_DIR/PHASE" 2>/dev/null || true)"
  {
    echo "<!-- app-build:report -->"
    echo "<!-- app-build:session app=${LEXI_APP}${LEXI_TRACK:+ track=${LEXI_TRACK}} session=${LEXI_SESSION} phase=${PHASE_NOW} -->"
    # Written by every report since the feedback cursor: such reports never
    # move feedback.sh's second-latest-report fallback.
    echo "<!-- app-build:feedback-cursor=v1 -->"
    feedback_marker
    echo "## Session ${LEXI_SESSION} — ${LEXI_APP_LABEL}${LEXI_TRACK:+ (${LEXI_TRACK} track)}"
    echo
    echo "${RUN_LINK} · commit \`${COMMIT}\` · phase **${PHASE_NOW}**${PHASE_NEXT:+ → next **${PHASE_NEXT}**} · session ${LEXI_SESSION} of ${LEXI_MAX_SESSIONS} · [progress](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/blob/${LEXI_BRANCH}/${DOCS_DIR}/PROGRESS.md)"
    echo
    cost_line "$RUNNER_TEMP"/segment-*.jsonl "$RUNNER_TEMP"/gate-*.json
    echo
    FEEDBACK_LINE="$(feedback_line)"
    if [ -n "$FEEDBACK_LINE" ]; then echo "$FEEDBACK_LINE"; echo; fi
    if [ $(( LEXI_SESSION * 4 )) -ge $(( LEXI_MAX_SESSIONS * 3 )) ]; then
      echo "> ⚠️ This is session ${LEXI_SESSION} of a ceiling of ${LEXI_MAX_SESSIONS} (at least 75%). If the scope is not close to done, raise \`max_sessions\` before the loop stops."
      echo
    fi
    if [ -s "$RUNNER_TEMP/gates.md" ]; then
      echo "### Phase gate"
      echo
      cat "$RUNNER_TEMP/gates.md"
      echo
    fi
    if [ -s "$RUNNER_TEMP/source-changes.md" ]; then
      echo "<details><summary>Sources updated at the start of this session</summary>"
      echo
      limit_text 6000 < "$RUNNER_TEMP/source-changes.md"
      echo
      echo "</details>"
      echo
    fi
    if [ -f "$GITHUB_WORKSPACE/$DOCS_DIR/LAST_SESSION.md" ]; then
      limit_text 20000 < "$GITHUB_WORKSPACE/$DOCS_DIR/LAST_SESSION.md"
      echo
    else
      echo "_The builder did not write LAST_SESSION.md this session._"
    fi
    echo
    echo "_When scheduled, checks and an independent code review post as a separate comment. Read that report before claiming they passed._"
    echo
    if [ "${LEXI_CONTINUE:-}" = "true" ]; then
      echo "_Session $(( LEXI_SESSION + 1 )) starts now. Comment here any time to steer it: each segment reads the next batch of comments it has not delivered yet._"
    else
      echo "_The build loop stopped: ${LEXI_STOP_REASON:-see the run log}._"
    fi
  } | node "$TOOLS/redact-output.mjs" > "$BODY"
else
  REVIEW="$OUT/REVIEW.md"
  {
    echo "<!-- app-build:assessment app=${LEXI_APP}${LEXI_TRACK:+ track=${LEXI_TRACK}} session=${LEXI_SESSION} -->"
    echo "## Assessment of session ${LEXI_SESSION} — ${LEXI_APP_LABEL}${LEXI_TRACK:+ (${LEXI_TRACK} track)}"
    echo
    echo "${RUN_LINK} · commit \`${COMMIT}\` · run beside the next session; the builder's next segment reads this comment and fixes it first."
    echo
    cost_line "$RUNNER_TEMP"/review.md.json
    echo
    echo "### Checks"
    echo
    if [ -s "$OUT/checks.json" ]; then
      echo "$(jq '[.[] | select(.status == "pass")] | length' "$OUT/checks.json") passed, $(jq '[.[] | select(.status == "fail")] | length' "$OUT/checks.json") failed, $(jq '[.[] | select(.status == "missing")] | length' "$OUT/checks.json") missing."
      echo
      echo "| Check | Result | Time |"
      echo "|---|---|---|"
      jq -r '.[] | "| \(.name) | \(if .status == "pass" then "✅ pass" elif .status == "fail" then "❌ fail" else "➖ missing" end) | \(.seconds)s |"' "$OUT/checks.json"
    else
      echo "_Checks did not run._"
    fi
    echo
    if [ -s "$OUT/visual/visual.json" ]; then
      echo "### Screens furthest from the prototype"
      echo
      echo "| Screen | Viewport | Differs | App | Prototype | Diff |"
      echo "|---|---|---|---|---|---|"
      jq -r 'map(select(.status == "compared")) | sort_by(-.mismatchPct) | .[0:12][] | [.screen, .viewport, (.mismatchPct|tostring), .app, .prototype, .diff] | @tsv' "$OUT/visual/visual.json" \
        | while IFS=$'\t' read -r S V M A P D; do
            echo "| ${S} | ${V} | ${M}% | $(img "$A") | $(img "$P") | $(img "$D") |"
          done
      echo
    fi
    if [ -s "$OUT/CHECKS.md" ]; then
      echo "<details><summary>Check details</summary>"
      echo
      sed -n '/^## /,$p' "$OUT/CHECKS.md" | limit_text 15000
      echo
      echo "</details>"
      echo
    fi
    echo "### Code review"
    echo
    if [ -s "$REVIEW" ]; then
      grep -m1 -E '^Findings:' "$REVIEW" || true
      echo
      echo "<details><summary>Independent review (read-only reviewer)</summary>"
      echo
      limit_text 25000 < "$REVIEW"
      echo
      echo "</details>"
    else
      echo "_The review did not run, or the session changed nothing._"
    fi
  } | node "$TOOLS/redact-output.mjs" > "$BODY"
fi

# GitHub caps a comment at 65536 characters.
limit_text 64000 < "$BODY" > "$BODY.trim"
for DELAY in 0 3 6 12; do
  sleep "$DELAY"
  if gh pr comment "$PR" --repo "$GITHUB_REPOSITORY" --body-file "$BODY.trim" >/dev/null; then
    echo "Posted the ${MODE} report to PR #${PR}."
    exit 0
  fi
done
echo "::warning::Could not post the ${MODE} report."
exit 0
