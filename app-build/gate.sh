#!/usr/bin/env bash
# usage: gate.sh <intent|spec|plan>
#
# The phase gate. A FRESH, read-only session on LEXI_REVIEW_MODEL that did not
# write the phase's documents judges them against the phase's rubric
# (gate-<phase>.md) and against the sources BUILD.md names. There is no human
# approval: this verdict is the approval.
#
#   PASS → PHASE advances (intent → spec → plan → build), GATE_FINDINGS.md is
#          cleared, and the verdict is appended to GATES.md.
#   FAIL → PHASE stays; the findings go to GATE_FINDINGS.md, which the next
#          attempt of the phase reads first. After LEXI_MAX_GATE_ATTEMPTS
#          failures of one phase the loop stops for a person to look.
#   No verdict (the reviewer timed out or broke) → nothing changes and the
#          attempt is not counted; the phase simply runs again.
#
# With LEXI_GATE_MODE=advisory a FAIL does not hold the phase back: PHASE
# advances as on a PASS, the findings stay in GATE_FINDINGS.md (marked
# advisory) for the next phase to resolve, and the loop never stops on them.
# Either way the verdict is queued for Slack in $RUNNER_TEMP/slack-outbox, and a
# later workflow step posts it when the caller gave a webhook, so a person can
# step in. Neither the webhook nor any staging credential reaches the reviewer,
# and this script never holds the webhook either: it runs inside the builder's
# step, whose environment the builder can read.
#
# The workflow commits the result; the builder is told never to edit PHASE,
# GATES.md or GATE_FINDINGS.md.
set -uo pipefail

PHASE="$1"
case "$PHASE" in
  intent) NEXT=spec ;;
  spec) NEXT=plan ;;
  plan) NEXT=build ;;
  *) echo "::error::gate.sh: unknown phase '$PHASE'"; exit 1 ;;
esac

cd "$GITHUB_WORKSPACE"
TOOLS="$RUNNER_TEMP/app-build"
source "$TOOLS/build-policy.sh"
DOCS="${LEXI_DOCS_DIR:-$LEXI_APP_DIR/docs/build}"
MODE="${LEXI_GATE_MODE:-blocking}"
mkdir -p "$DOCS"
GATES="$DOCS/GATES.md"
FINDINGS="$DOCS/GATE_FINDINGS.md"
MAX="${LEXI_MAX_GATE_ATTEMPTS:-3}"
N="$(ls "$RUNNER_TEMP"/gate-*.json 2>/dev/null | wc -l | tr -d ' ')"
OUT="$RUNNER_TEMP/gate-${PHASE}-$(( N + 1 )).json"

PROMPT="$RUNNER_TEMP/gate-prompt.md"
{
  echo "You are the phase gate for the ${LEXI_APP_LABEL} in \`${LEXI_APP_DIR}/\`. A builder just finished the **${PHASE}** phase. You did not write any of it, and nobody will check your verdict: if you pass work that is not ready, the next phase builds on it. Be strict about what the rubric asks and ignore everything it does not ask."
  echo
  echo "Read \`${LEXI_APP_DIR}/BUILD.md\` first: it names the sources and the rules. Then the phase's documents under \`${DOCS}/\`, and the sources themselves wherever you need to check a claim. You can only read; do not try to change anything."
  echo
  if [ -n "${LEXI_TRACK:-}" ]; then
    echo "This is the **${LEXI_TRACK}** track: one of several builders on this app. Its scope is the \`${LEXI_TRACK}\` entry of BUILD.md's \"Tracks\" section, and its documents are under \`${DOCS}/\`. Judge the phase against that scope only."
    echo
  fi
  if [ -n "$PROMPT_GATE_TEST_POLICY" ]; then
    echo "$PROMPT_GATE_TEST_POLICY"
    echo
  fi
  if [ -d intake ] && ls intake/*.md > /dev/null 2>&1; then
    echo "The feature-intake issues in scope are in \`intake/\` (read-only, with the team's decisions in their comments). Check the phase's documents follow them where BUILD.md says they apply."
    echo
  fi
  if [ -s "$FINDINGS" ]; then
    if head -n 1 "$FINDINGS" | grep -q "^# Gate findings — ${PHASE},"; then
      echo "This is a repeat attempt. The previous gate's findings are in \`${FINDINGS}\`: check each one is resolved."
    else
      echo "The previous phase moved on with findings its gate flagged, in \`${FINDINGS}\`. This phase had to resolve those that touch it: check they are resolved or recorded in DECISIONS.md with a reason."
    fi
    echo
  fi
  # The rubrics name the documents relative to the app; a track keeps its own.
  sed "s#\`docs/build/#\`${DOCS}/#g" "$TOOLS/gate-${PHASE}.md" || {
    echo "::error::Could not load the ${PHASE} gate rubric." >&2
    exit 1
  }
  echo
  echo "Answer in markdown: a one-paragraph verdict, then the findings that block the phase (most severe first, at most 20, each naming the document, what is wrong or missing, and what would fix it), then at most 5 non-blocking notes. Pass when no blocking finding remains; do not fail work for polish. The LAST line of your answer must be exactly \`VERDICT: PASS\` or \`VERDICT: FAIL\`."
} > "$PROMPT"

EFFORT_ARGS=()
if [ -n "${LEXI_REVIEW_EFFORT:-}" ]; then EFFORT_ARGS=(--effort "$LEXI_REVIEW_EFFORT"); fi

timeout --signal=INT --kill-after=60 "${LEXI_GATE_MINUTES:-25}m" \
  env -u LEXI_SLACK_WEBHOOK_URL -u GH_TOKEN -u GITHUB_TOKEN \
    -u STAGING_TEST_EMAIL -u STAGING_TEST_PASSWORD -u STAGING_REAL_EMAIL -u STAGING_REAL_PASSWORD \
    -u MAILISK_API_KEY -u MAILISK_NAMESPACE \
  claude -p \
    --model "${LEXI_REVIEW_MODEL:-$LEXI_MODEL}" \
    ${EFFORT_ARGS[@]+"${EFFORT_ARGS[@]}"} \
    --allowedTools "Read" "Grep" "Glob" "Bash(git log:*)" "Bash(git show:*)" "Bash(git diff:*)" \
    --output-format json < "$PROMPT" > "$OUT" 2> "$OUT.stderr"
EXIT=$?

TEXT="$(jq -r '.result // empty' "$OUT" 2>/dev/null || true)"
VERDICT="$(printf '%s\n' "$TEXT" | grep -E '^[[:space:]]*VERDICT:[[:space:]]*(PASS|FAIL)[[:space:]]*$' | tail -n 1 | sed -E 's/.*VERDICT:[[:space:]]*//; s/[[:space:]]*$//')"
if [ -z "$VERDICT" ]; then
  echo "::warning::The ${PHASE} gate gave no verdict (exit ${EXIT}); the phase runs again and the attempt is not counted."
  tail -n 20 "$OUT.stderr" 2>/dev/null || true
  echo "- **${PHASE}**: the gate gave no verdict (exit ${EXIT}); the phase runs again." >> "$RUNNER_TEMP/gates.md"
  exit 0
fi

# Failures of this phase since its last restart (a RESTART row resets the count).
FAILS_BEFORE="$(awk -F'|' -v p="$PHASE" '
  { ph = $2; v = $3; gsub(/ /, "", ph); gsub(/ /, "", v) }
  ph == p && v == "RESTART" { n = 0 }
  ph == p && v == "FAIL" { n++ }
  END { print n + 0 }' "$GATES" 2>/dev/null || echo 0)"
ATTEMPT=$(( ${FAILS_BEFORE:-0} + 1 ))
SUMMARY="$(printf '%s\n' "$TEXT" | grep -v '^[[:space:]]*VERDICT:' | sed -n '/[^[:space:]]/{p;q;}' | cut -c1-300 | tr '|' '/')"

if [ ! -s "$GATES" ]; then
  {
    echo "# Phase gates"
    echo
    echo "Written by the workflow. Each phase is judged by an independent read-only reviewer; a pass is the approval to move on. Do not edit."
    echo
    echo "| Phase | Verdict | Attempt | Session | When | Summary |"
    echo "|---|---|---|---|---|---|"
  } > "$GATES"
fi
echo "| ${PHASE} | ${VERDICT} | ${ATTEMPT} | ${LEXI_SESSION} | $(date -u '+%Y-%m-%d %H:%M UTC') | ${SUMMARY} |" >> "$GATES"

slack_post() { # queue only; slack-post.sh sends it from its own step
  local LINK="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/blob/${LEXI_BRANCH}/${DOCS}"
  local RUN="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
  local MSG
  MSG="$(printf '*%s%s: %s gate %s* (attempt %s, %s mode, session %s)\n%s\n%s\n<%s|Findings and gates> · <%s|Run>' \
    "$LEXI_APP_LABEL" "${LEXI_TRACK:+ — ${LEXI_TRACK} track}" "$PHASE" "$VERDICT" "$ATTEMPT" "$MODE" "$LEXI_SESSION" \
    "$SUMMARY" "$1" "${LINK}/$( [ "$VERDICT" = PASS ] && echo GATES.md || echo GATE_FINDINGS.md )" "$RUN")"
  mkdir -p "$RUNNER_TEMP/slack-outbox"
  jq -n --arg text "$MSG" '{text: $text}' > "$RUNNER_TEMP/slack-outbox/gate-${PHASE}-$(date +%s).json" \
    || echo "::warning::Could not queue the ${PHASE} gate verdict for Slack."
}

write_findings() {
  {
    echo "# Gate findings — ${PHASE}, attempt ${ATTEMPT}$1"
    echo
    echo "$2"
    echo
    printf '%s\n' "$TEXT" | grep -v '^[[:space:]]*VERDICT:'
  } > "$FINDINGS"
}

if [ "$VERDICT" = "PASS" ]; then
  printf '%s\n' "$NEXT" > "$DOCS/PHASE"
  rm -f "$FINDINGS"
  echo "- **${PHASE}**: PASS on attempt ${ATTEMPT} — the next phase is **${NEXT}**. ${SUMMARY}" >> "$RUNNER_TEMP/gates.md"
  echo "::notice::The ${PHASE} gate passed; the next phase is ${NEXT}."
  slack_post "Moving on to ${NEXT}."
elif [ "$MODE" = "advisory" ]; then
  printf '%s\n' "$NEXT" > "$DOCS/PHASE"
  write_findings " (advisory)" "Written by the workflow from the phase gate's review. The gate is advisory, so the build moved on to the ${NEXT} phase. Resolve every blocking finding below in that phase first, or record in DECISIONS.md why it does not apply. The next gate checks."
  echo "- **${PHASE}**: FAIL on attempt ${ATTEMPT} (advisory) — moving on to **${NEXT}** with the findings. ${SUMMARY}" >> "$RUNNER_TEMP/gates.md"
  echo "::notice::The ${PHASE} gate failed (advisory); moving on to ${NEXT} with the findings."
  slack_post "Advisory gate: the build moves on to ${NEXT} and resolves these findings there. Comment on the PR to steer it."
else
  printf '%s\n' "$PHASE" > "$DOCS/PHASE"
  write_findings "" "Written by the workflow from the phase gate's review. Resolve every blocking finding before anything else in this phase; the next gate checks each one."
  echo "- **${PHASE}**: FAIL on attempt ${ATTEMPT} of ${MAX}. ${SUMMARY}" >> "$RUNNER_TEMP/gates.md"
  echo "::notice::The ${PHASE} gate failed (attempt ${ATTEMPT} of ${MAX})."
  if [ "$ATTEMPT" -ge "$MAX" ]; then
    echo "the ${PHASE} gate failed ${ATTEMPT} times; a person needs to look at GATE_FINDINGS.md" > "$RUNNER_TEMP/stop-reason"
    slack_post "The loop has stopped: a person needs to look at the findings."
  else
    slack_post "The phase runs again with these findings."
  fi
fi

git add -A -- "$DOCS"
git diff --cached --quiet || git commit -q -m "build(${LEXI_BUILD_ID:-$LEXI_APP}): ${PHASE} gate — ${VERDICT}" -m "Session ${LEXI_SESSION}, attempt ${ATTEMPT}. Written by the workflow's phase gate."
exit 0
