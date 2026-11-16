#!/usr/bin/env bash
# usage: review.sh
#
# An independent code review of the session's work, by a FRESH Claude session
# that did not write the code. It can only read: Read/Grep/Glob and read-only
# git commands; it holds no GitHub token and no staging credentials, only the
# model token. Its findings are written to $RUNNER_TEMP/checks/REVIEW.md and
# posted in the assessment comment, which the builder's next segment reads
# and fixes first. Advisory, like every check here: it never blocks the loop.
# Runs on LEXI_REVIEW_MODEL (the build may run on a cheaper model; the
# reviewer is where a stronger one earns its cost).
set -uo pipefail

cd "$GITHUB_WORKSPACE"
START_SHA="${LEXI_START_SHA:-$(cat "$RUNNER_TEMP/start-sha" 2>/dev/null)}"
DOC="$RUNNER_TEMP/checks/REVIEW.md"
mkdir -p "$(dirname "$DOC")"

if [ "$(git rev-list --count "${START_SHA}..HEAD" 2>/dev/null || echo 0)" -eq 0 ] && git diff --quiet HEAD; then
  echo "No changes this session; nothing to review."
  exit 0
fi

PROMPT="$RUNNER_TEMP/review-prompt.md"
cat > "$PROMPT" <<REVIEW_PROMPT
You are a senior engineer reviewing one session of work on the ${LEXI_APP_LABEL} in \`${LEXI_APP_DIR}/\`. You did not write it. Review for code quality, not for how the screens look (screenshots are compared separately).

The session's changes: \`git diff ${START_SHA} -- ${LEXI_APP_DIR}\` (use \`git log ${START_SHA}..HEAD\` for the commit messages; include uncommitted changes with \`git diff HEAD\`). Read the surrounding code as needed. The rules the builder works to are in \`${LEXI_APP_DIR}/BUILD.md\`. The previous assessment, if any, is in \`${RUNNER_TEMP}/assessment.md\` (its "Code review" part): say which of its findings are now fixed.

Look for, in this order:
1. Bugs and broken journeys: wrong logic, unhandled errors or loading states, race conditions, state that leaks between screens.
2. Security: credentials or tokens in code, logs or storage; unsafe HTML; open redirects (return_to handling); anything the prototype stubbed that reached production code (fixture passwords, fake codes, hard-coded test accounts).
3. Accessibility in the code: missing labels and accessible names, focus management, keyboard traps, roles, reduced-motion handling.
4. Architecture: duplicated modules or API clients, screens calling the network directly instead of through the client layer, dead code, copies of the prototype that were never wired to real data.
5. Type safety and tests: \`any\`, unchecked casts, tests that assert nothing or only snapshot, missing tests for the real API paths.
6. Performance: needless client components, large bundles, unbounded re-renders.

Output ONLY the review, as markdown, starting with the line \`# Code review — session ${LEXI_SESSION}\`. Then the line \`Findings: <n> blockers, <n> majors, <n> minors\`, then a one-paragraph verdict, then findings ranked most severe first, at most 25. Each finding: severity (blocker / major / minor), \`path:line\`, what is wrong, and the concrete fix. No style nits a linter would catch. If the previous review exists, end with a "Previous findings" list marking each fixed or still open.
REVIEW_PROMPT

EFFORT_ARGS=()
if [ -n "${LEXI_REVIEW_EFFORT:-${LEXI_EFFORT:-}}" ]; then EFFORT_ARGS=(--effort "${LEXI_REVIEW_EFFORT:-$LEXI_EFFORT}"); fi

OUT="$RUNNER_TEMP/review.md"
timeout --signal=INT --kill-after=60 25m \
  claude -p \
    --model "${LEXI_REVIEW_MODEL:-$LEXI_MODEL}" \
    ${EFFORT_ARGS[@]+"${EFFORT_ARGS[@]}"} \
    --allowedTools "Read" "Grep" "Glob" "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" \
    --output-format json < "$PROMPT" > "$OUT.json" 2> "$RUNNER_TEMP/review.stderr"
EXIT=$?
jq -r '.result // empty' "$OUT.json" > "$OUT" 2>/dev/null || : > "$OUT"

if [ "$EXIT" -eq 0 ] && grep -q '^# Code review' "$OUT"; then
  sed -n '/^# Code review/,$p' "$OUT" > "$DOC"
  echo "Wrote ${DOC} ($(grep -ciE '^\W*(\*\*)?(blocker|major)' "$DOC" || true) blocker/major line(s))."
else
  echo "::warning::The code review did not complete (exit ${EXIT})."
  tail -n 20 "$RUNNER_TEMP/review.stderr" || true
fi
exit 0
