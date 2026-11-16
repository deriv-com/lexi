#!/usr/bin/env bash
# usage: push.sh <label>
#
# Commits whatever the builder left uncommitted, refuses to push if any new
# commit carries a staging credential (raw or encoded), pushes the branch with a
# freshly minted App token (GH_TOKEN), and makes sure the draft PR into the
# default branch exists. Writes the PR number to $RUNNER_TEMP/pr-number.
set -uo pipefail
source "$(dirname "$0")/git-auth.sh"

LABEL="$1"
cd "$GITHUB_WORKSPACE"

git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "wip(${LEXI_APP}): checkpoint — session ${LEXI_SESSION}, ${LABEL}" \
    -m "Committed by the workflow: the builder left these changes uncommitted when the segment ended."
fi

START_SHA="$(cat "$RUNNER_TEMP/start-sha")"
if [ "$(git rev-parse HEAD)" = "$START_SHA" ] && [ -s "$RUNNER_TEMP/pr-number" ]; then
  echo "Nothing new since the session started; nothing to push."
  exit 0
fi

# The builder signs in to staging with these; they must never leave the runner.
# Check the raw, JSON-escaped and URL-encoded forms that reports redact; a scan
# that fails also refuses the push.
if ! FOUND="$(git log -p "${START_SHA}..HEAD" | node "$(dirname "$0")/redact-output.mjs" --find)"; then
  FOUND="${FOUND//$'\n'/, }"
  echo "::error::Refusing to push: a commit in this session contains ${FOUND:+a form of }${FOUND:-a value that could not be scanned}. The commits stay on the runner."
  exit 1
fi

REMOTE="https://github.com/${GITHUB_REPOSITORY}.git"
PUSHED=""
# A token minted seconds ago can be refused with "Repository not found". A push can also be
# refused because the branch moved during the session (a person merged a PR into it): then the
# remote branch is merged in and the push tried again. Only a merge conflict stops the session;
# its commits are then pushed to a side branch so nothing is lost.
for DELAY in 0 3 6 12 24; do
  sleep "$DELAY"
  if github_git push -q "$REMOTE" "HEAD:refs/heads/${LEXI_BRANCH}"; then
    PUSHED=1
    break
  fi
  github_git fetch -q "$REMOTE" "refs/heads/${LEXI_BRANCH}" || continue
  git merge-base --is-ancestor FETCH_HEAD HEAD && continue
  if git merge -q --no-edit -m "Merge ${LEXI_BRANCH} into session ${LEXI_SESSION} (it moved during the session)" FETCH_HEAD; then
    echo "${LEXI_BRANCH} moved during the session; merged its $(git rev-parse --short FETCH_HEAD) and pushing again."
  else
    git merge --abort
    SIDE="${LEXI_BRANCH}-session-${LEXI_SESSION}"
    github_git push -q "$REMOTE" "HEAD:refs/heads/${SIDE}" || true
    echo "::error::${LEXI_BRANCH} moved during the session and merging it conflicts. This session's commits are on ${SIDE}; merge them by hand and resume."
    exit 1
  fi
done
if [ -z "$PUSHED" ]; then
  echo "::error::Could not push ${LEXI_BRANCH}."
  exit 1
fi
echo "Pushed ${LEXI_BRANCH} at $(git rev-parse --short HEAD)."

# Only a PR from this repository's own branch: a fork can open a PR from a
# branch of the same name.
PR="$(gh pr list --repo "$GITHUB_REPOSITORY" --head "$LEXI_BRANCH" --state open --json number,isCrossRepository,headRepositoryOwner \
  | jq -r --arg owner "${GITHUB_REPOSITORY%%/*}" '[.[] | select(.isCrossRepository == false and ((.headRepositoryOwner.login // "") | ascii_downcase) == ($owner | ascii_downcase))] | sort_by(.number) | last | .number // empty')"
if [ -z "$PR" ]; then
  BODY="$RUNNER_TEMP/pr-body.md"
  {
    if [ -n "${LEXI_TRACK:-}" ]; then
      echo "Lexi is building the **${LEXI_TRACK}** track of the ${LEXI_APP_LABEL} in \`${LEXI_APP_DIR}/\`, beside the other tracks. Its scope is the \`${LEXI_TRACK}\` entry of BUILD.md's \"Tracks\" section."
    else
      echo "Lexi is building the ${LEXI_APP_LABEL} in \`${LEXI_APP_DIR}/\` as one builder with the whole app in view."
    fi
    echo
    echo "- **What and how:** [\`${LEXI_APP_DIR}/BUILD.md\`](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/blob/${LEXI_BRANCH}/${LEXI_APP_DIR}/BUILD.md)"
    echo "- **Progress:** [\`${LEXI_DOCS_DIR:-${LEXI_APP_DIR}/docs/build}/PROGRESS.md\`](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/blob/${LEXI_BRANCH}/${LEXI_DOCS_DIR:-${LEXI_APP_DIR}/docs/build}/PROGRESS.md)"
    echo "- Each session posts a comment here: what it did, check results and screenshots against the prototype."
    echo
    echo "**Feedback:** comment on this PR. The next sessions read every comment not delivered yet, in batches, and act on it first."
    echo "**Stop:** add the label \`app-build:stop\`, or close the PR."
    echo
    echo "This PR is a draft and must not be merged until a person decides the app is ready."
  } > "$BODY"
  PR="$(gh pr create --repo "$GITHUB_REPOSITORY" --draft --base "$LEXI_BASE" --head "$LEXI_BRANCH" \
    --title "Lexi builds the ${LEXI_APP_LABEL}${LEXI_TRACK:+ — ${LEXI_TRACK} track}" --body-file "$BODY" | sed -n 's#.*/pull/\([0-9][0-9]*\).*#\1#p')"
  echo "Opened draft PR #${PR}."
fi
if [ -n "$PR" ]; then printf '%s' "$PR" > "$RUNNER_TEMP/pr-number"; fi
