#!/usr/bin/env bash
# usage: reference.sh
#
# Clones the reference repositories (LEXI_REFERENCE_REPOSITORIES, comma- or
# space-separated `owner/repo`) read-only into reference/<repo> beside the app.
# A reference is something the builder may read and borrow from (for example
# the production app it replaces), never a source of truth and never a place
# it writes to:
#   - the token (GH_TOKEN) is minted with contents:read only, used for the
#     clone and then stripped from the clone's remote, so the agent never holds it;
#   - reference/ is in .git/info/exclude, so `git add -A` never stages it and it
#     can never be pushed with the app;
#   - the workflow only ever pushes to the calling repository.
# A reference that cannot be fetched is a warning: the build goes on without it.
set -uo pipefail

cd "$GITHUB_WORKSPACE"
mkdir -p .git/info
grep -qxF '/reference/' .git/info/exclude 2>/dev/null || echo '/reference/' >> .git/info/exclude
REFS="$(printf '%s' "${LEXI_REFERENCE_REPOSITORIES:-}" | tr ',' ' ')"
[ -n "${REFS// /}" ] || exit 0
if [ -z "${GH_TOKEN:-}" ]; then
  echo "::warning::No token for the reference repositories (is the builder App installed on their organisation?); building without them."
  exit 0
fi

: > "$RUNNER_TEMP/references.md"
for REF in $REFS; do
  NAME="${REF##*/}"
  DEST="reference/${NAME}"
  rm -rf "$DEST"
  OK=""
  for DELAY in 0 3 6 12; do
    sleep "$DELAY"
    if git clone -q --depth 1 --no-recurse-submodules "https://x-access-token:${GH_TOKEN}@github.com/${REF}.git" "$DEST" 2>/dev/null; then OK=1; break; fi
  done
  if [ -z "$OK" ]; then
    echo "::warning::Could not clone the reference ${REF}; building without it."
    continue
  fi
  git -C "$DEST" remote set-url origin "https://github.com/${REF}.git"
  echo "- \`${DEST}/\` — ${REF} at \`$(git -C "$DEST" rev-parse --short HEAD)\` (read-only reference)" >> "$RUNNER_TEMP/references.md"
  echo "Cloned ${REF} into ${DEST} at $(git -C "$DEST" rev-parse --short HEAD)."
done
exit 0
