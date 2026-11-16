#!/usr/bin/env bash
# Merge the current base without continuing under stale build instructions.
set -euo pipefail
stop_on_error() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    printf '%s\n' "the base branch could not be synced; no build ran under stale instructions" > "$RUNNER_TEMP/stop-reason"
  fi
}
trap stop_on_error EXIT
source "$(dirname "$0")/git-auth.sh"
REMOTE="https://github.com/${GITHUB_REPOSITORY}.git"
FETCHED=false
for DELAY in 0 3 6 12; do
  sleep "$DELAY"
  if github_git fetch -q "$REMOTE" "+refs/heads/${LEXI_BASE}:refs/remotes/origin/${LEXI_BASE}"; then
    FETCHED=true
    break
  fi
done
if [ "$FETCHED" != true ]; then
  echo "::error::Could not fetch the base after retries; stopping the loop."
  exit 1
fi
if git merge-base --is-ancestor "origin/${LEXI_BASE}" HEAD; then
  echo "${LEXI_BRANCH} already contains ${LEXI_BASE}."
elif git merge -q --no-edit -m "Merge ${LEXI_BASE} into ${LEXI_BRANCH}" "origin/${LEXI_BASE}"; then
  echo "::notice::Merged ${LEXI_BASE} into ${LEXI_BRANCH} ($(git rev-parse --short "origin/${LEXI_BASE}"))."
else
  CONFLICTS=""
  if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
    CONFLICTS="$(git diff --name-only --diff-filter=U)"
    git merge --abort
  fi
  if [ -z "$CONFLICTS" ]; then
    echo "::error::Could not merge the base. The branch is unchanged; resolve the merge failure before restarting the build."
    exit 1
  fi
  # A conflict is the builder's first task, not a reason to stop: it can see
  # both sides and knows which files are its own.
  {
    echo "**Merge the base first.** This session could not merge \`origin/${LEXI_BASE}\` into \`${LEXI_BRANCH}\` automatically, so the branch is unchanged. Before anything else, run \`git merge origin/${LEXI_BASE}\`, resolve the conflicts, run the type check and the tests, and commit the merge. Conflicted files:"
    echo
    printf '%s\n' "$CONFLICTS" | sed 's/^/- `/; s/$/`/'
    echo
    echo "Resolve by ownership: in your own folders keep your version (a file you deleted stays deleted, unless the base's change is one you need, then move that change into your current file); in shared files take the base's version and adapt your code to it. Record what you chose in DECISIONS.md."
  } > "$RUNNER_TEMP/merge-note.md"
  echo "::warning::The base did not merge cleanly ($(printf '%s\n' "$CONFLICTS" | wc -l | tr -d ' ') file(s)); the builder merges it as its first task."
fi
