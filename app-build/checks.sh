#!/usr/bin/env bash
# usage: checks.sh
#
# The light checks run once at the end of a session. They report results; they do not
# decide QA or release readiness. Each check records pass / fail / missing and the tail
# of its log. Results go to:
#   $RUNNER_TEMP/checks/checks.json         (read by report.sh)
#   $RUNNER_TEMP/checks/visual/visual.json  (screenshot pairs scored against the prototype)
#   $RUNNER_TEMP/checks/CHECKS.md           (posted in the assessment comment,
#                                            which the next segment reads)
#
# Browser checks use the app's test:e2e script, or legacy lexi:journeys.
# The legacy `lexi:visual` script visits every screen in both apps and writes
# `<screen>__app__<viewport>.png` / `<screen>__prototype__<viewport>.png` into
# $LEXI_SHOTS_DIR, plus `a11y.json` (axe results per screen) beside them.
set -uo pipefail
umask 077
TOOLS="$(cd "$(dirname "$0")" && pwd)"
SERVER_PIDS=()
cleanup() {
  for pid in "${SERVER_PIDS[@]}"; do
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

OUT="$RUNNER_TEMP/checks"
LOGS="$OUT/logs"
export LEXI_SHOTS_DIR="$OUT/shots"
mkdir -p "$LOGS" "$LEXI_SHOTS_DIR"
rm -f "$OUT/checks.json"
: > "$OUT/checks.ndjson"
APP_ROOT="$GITHUB_WORKSPACE/$LEXI_APP_DIR"

write_report() {
# Posted in the assessment comment, which the builder's next segment reads.
# Assessment evidence stays in the report and artifact, outside the build branch.
local DOC="$OUT/CHECKS.md"
{
  echo "# Checks — session ${LEXI_SESSION}"
  echo
  echo "Run by the workflow on \`$(git -C "$GITHUB_WORKSPACE" rev-parse --short HEAD)\` after the session, $(date -u '+%Y-%m-%d %H:%M UTC'). These are development checks, not an independent QA verdict."
  echo
  echo "| Check | Result | Time |"
  echo "|---|---|---|"
  jq -r '.[] | "| \(.name) | \(.status) | \(.seconds)s |"' "$OUT/checks.json"
  echo
  if [ -s "$OUT/visual/visual.json" ]; then
    echo "## Screens against the prototype"
    echo
    echo "Share of pixels that differ from the prototype (lower is closer). Height delta is app minus prototype."
    echo
    echo "| Screen | Viewport | Differs | Height delta | Note |"
    echo "|---|---|---|---|---|"
    jq -r 'sort_by(-(.mismatchPct // 101)) | .[] | "| \(.screen) | \(.viewport) | \(if .mismatchPct == null then "-" else "\(.mismatchPct)%" end) | \(.heightDelta // "-") | \(if .status == "compared" then "" else .status end) |"' "$OUT/visual/visual.json"
    echo
  fi
  if [ -f "$LEXI_SHOTS_DIR/a11y.json" ]; then
    echo "## Accessibility (axe)"
    echo
    jq -r 'if type == "array" then .[] | "- \(.screen // "?"): \((.violations // []) | length) violation(s) \((.violations // []) | map(.id) | unique | join(", "))" else "- unreadable a11y.json" end' "$LEXI_SHOTS_DIR/a11y.json" 2>/dev/null || echo "- a11y.json could not be read"
    echo
  fi
  echo "## Failure details"
  echo
  jq -r '.[] | select(.status == "fail") | "### \(.name)\n\n```\n\(.tail)\n```\n"' "$OUT/checks.json"
} > "$DOC"
local CONTENT="$(sed -e 's/[[:space:]]*$//' "$DOC")"
printf '%s\n' "$CONTENT" > "$DOC"
}

record() { # name status seconds logfile
  local tail=""
  if [ -f "$4" ]; then tail="$(tail -n 40 "$4" | cut -c1-300)"; fi
  jq -nc --arg name "$1" --arg status "$2" --argjson seconds "$3" --arg tail "$tail" \
    '{name: $name, status: $status, seconds: $seconds, tail: $tail}' >> "$OUT/checks.ndjson"
  jq -s '.' "$OUT/checks.ndjson" > "$OUT/checks.json.tmp"
  mv "$OUT/checks.json.tmp" "$OUT/checks.json"
  write_report
  echo "check ${1}: ${2} (${3}s)"
}

run_check() { # name command...
  local name="$1"; shift
  local log="$LOGS/$(printf '%s' "$name" | tr -c 'a-zA-Z0-9' '-').log"
  local start; start=$(date +%s)
  if ( "$@" ) 2>&1 | node "$TOOLS/redact-output.mjs" > "$log"; then
    record "$name" pass $(( $(date +%s) - start )) "$log"
  else
    record "$name" fail $(( $(date +%s) - start )) "$log"
  fi
}

has_script() { # dir script
  [ -f "$1/package.json" ] && node -e 'const p=require(process.argv[1]);process.exit(p.scripts&&p.scripts[process.argv[2]]?0:1)' "$1/package.json" "$2"
}

wait_for() { # url seconds
  local i
  for i in $(seq 1 "$2"); do
    if curl -s --max-time 2 -o /dev/null "$1"; then return 0; fi
    sleep 1
  done
  return 1
}

start_legacy_server() {
  [ -n "${LEGACY_SERVER_STARTED:-}" ] && return
  # Legacy scripts consume this URL; test:e2e owns its server through its config.
  if [ -d .next ]; then
    npx --no-install next start -p 3000 > /dev/null 2>&1 &
    SERVER_PIDS+=("$!")
  else
    npx --no-install next dev -p 3000 > /dev/null 2>&1 &
    SERVER_PIDS+=("$!")
  fi
  export LEXI_APP_URL="http://localhost:3000"
  wait_for "$LEXI_APP_URL" 120 || echo "::warning::The app did not answer on :3000."
  LEGACY_SERVER_STARTED=1
}

if [ ! -d "$APP_ROOT" ]; then
  record "app directory" fail 0 /dev/null
elif [ "$LEXI_APP" = "web" ]; then
  cd "$APP_ROOT"
  if [ ! -f .env.local ] && [ -f .env.example ]; then cp .env.example .env.local; fi
  if [ ! -f package.json ]; then
    record "package.json" missing 0 /dev/null
  else
    run_check "install" npm ci --no-audit --no-fund
    run_check "typecheck" npx --no-install tsc --noEmit
    for S in lint test build; do
      if has_script . "$S"; then run_check "$S" npm run "$S"; else record "$S" missing 0 /dev/null; fi
    done
    # The assessment is separate from the builder's unit-only session.
    # assess_browser "false" turns the browser suites off here too.
    if [ "${LEXI_ASSESS_BROWSER:-true}" = "false" ]; then
      record "browser tests (turned off by assess_browser)" missing 0 /dev/null
    elif [ "${LEXI_TESTS:-e2e}" != "unit" ] || has_script . test:e2e || has_script . lexi:journeys || has_script . test:visual || has_script . lexi:visual || has_script . test:a11y || has_script . test:performance; then
      # Install the app's Playwright version and its configured browser engines.
      if node -e 'const p=require("./package.json");process.exit([p.dependencies,p.devDependencies].some(d=>d&&(d["@playwright/test"]||d.playwright))?0:1)'; then
        run_check "browser install" npx --no-install playwright install --with-deps
      fi
      if has_script . test:e2e; then
        run_check "browser journeys (app-configured target)" npm run test:e2e
      elif has_script . lexi:journeys; then
        start_legacy_server
        run_check "browser journeys (legacy target)" npm run lexi:journeys
      else
        record "browser tests" missing 0 /dev/null
      fi
      if has_script . test:visual; then
        run_check "visual regression" npm run test:visual
      elif has_script . lexi:visual; then
        start_legacy_server
        run_check "visual + accessibility" npm run lexi:visual
      elif ! has_script . test:e2e; then
        record "visual regression" missing 0 /dev/null
      fi
      # test:e2e may include visual and accessibility cases in one suite.
      # Apps can provide a separate accessibility suite; journey suites may include axe.
      if has_script . test:a11y; then run_check "accessibility" npm run test:a11y; fi
      if has_script . test:performance; then run_check "performance" npm run test:performance; fi
    fi
  fi
else
  cd "$APP_ROOT"
  if [ ! -f pubspec.yaml ]; then
    record "pubspec.yaml" missing 0 /dev/null
  else
    run_check "pub get" flutter pub get
    run_check "analyze" flutter analyze
    if [ -d test ]; then run_check "test" flutter test; else record "test" missing 0 /dev/null; fi
    run_check "build web" flutter build web --release
    run_check "build apk" flutter build apk --debug
    if [ -d build/web ]; then
      (cd build/web && exec python3 -m http.server 4100) > /dev/null 2>&1 &
      SERVER_PIDS+=("$!")
      export LEXI_APP_URL="http://localhost:4100"
      wait_for "$LEXI_APP_URL" 30 || echo "::warning::The web build did not answer on :4100."
    fi
    VISUAL_DIR="$APP_ROOT/tools/visual"
    if has_script "$VISUAL_DIR" lexi:visual; then
      (cd "$VISUAL_DIR" && run_check "visual + accessibility" bash -c 'npm ci --no-audit --no-fund && npm run lexi:visual')
    else
      record "visual + accessibility" missing 0 /dev/null
    fi
  fi
fi

node "$RUNNER_TEMP/app-build/visual-report.mjs" "$LEXI_SHOTS_DIR" "$OUT/visual" || echo "::warning::Scoring the screenshots failed."
jq -s '.' "$OUT/checks.ndjson" > "$OUT/checks.json"

write_report
echo "Wrote ${OUT}/CHECKS.md."
exit 0
