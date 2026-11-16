#!/usr/bin/env bash
# usage: sources.sh
#
# Fetches the submodules the builder reads (LEXI_SUBMODULES, space or comma
# separated) and, when LEXI_TRACK_SOURCES is "true", moves each one to the tip
# of the branch `.gitmodules` names for it, so every session builds against
# the latest spec instead of the commit recorded when the repo was set up.
#
# A moved source is committed on the build branch ("build: update sources"),
# so the branch always records exactly which spec revision the code was built
# from, and what changed is written to $RUNNER_TEMP/source-changes.md for the
# builder's prompt. A source whose branch cannot be fetched (deleted, no
# access) keeps its recorded commit and the session goes on with a warning:
# a stale spec is better than no build.
#
# Needs GH_TOKEN (an App token that can read the source repositories).
set -uo pipefail

cd "$GITHUB_WORKSPACE"
: > "$RUNNER_TEMP/source-changes.md"
AUTH=(-c "url.https://x-access-token:${GH_TOKEN}@github.com/.insteadOf=https://github.com/")
SUBS="$(printf '%s' "${LEXI_SUBMODULES:-}" | tr ',' ' ')"
CHANGED=()

for SUB in $SUBS; do
  OK=""
  for DELAY in 0 3 6 12; do
    sleep "$DELAY"
    if git "${AUTH[@]}" submodule update --init --depth 1 "$SUB" > /dev/null 2>&1; then OK=1; break; fi
  done
  if [ -z "$OK" ] || [ ! -e "$SUB/.git" ]; then
    echo "::error::could not fetch the ${SUB} submodule (is the builder App installed on its repository?)"
    exit 1
  fi
  [ "${LEXI_TRACK_SOURCES:-false}" = "true" ] || continue

  OLD="$(git -C "$SUB" rev-parse HEAD)"
  BRANCH="$(git config -f .gitmodules --get "submodule.${SUB}.branch" || true)"
  MOVED=""
  for DELAY in 0 3 6; do
    sleep "$DELAY"
    if git "${AUTH[@]}" submodule update --remote --depth 1 "$SUB" > /dev/null 2>&1; then MOVED=1; break; fi
  done
  if [ -z "$MOVED" ]; then
    echo "::warning::could not move ${SUB} to the tip of ${BRANCH:-its default branch}; building against its recorded commit ${OLD:0:8}."
    continue
  fi
  NEW="$(git -C "$SUB" rev-parse HEAD)"
  if [ "$OLD" != "$NEW" ]; then
    CHANGED+=("$SUB")
    # Enough history to name the commits and files in between; best effort.
    git "${AUTH[@]}" -C "$SUB" fetch -q --deepen 200 > /dev/null 2>&1 || true
    {
      echo "### \`${SUB}\` moved from \`${OLD:0:8}\` to \`${NEW:0:8}\`${BRANCH:+ (tip of \`${BRANCH}\`)}"
      echo
      if git -C "$SUB" cat-file -e "${OLD}^{commit}" 2>/dev/null; then
        echo "Commits:"
        git -C "$SUB" log --format='- %h %s' "${OLD}..${NEW}" | head -n 40
        echo
        echo "Files changed:"
        git -C "$SUB" diff --stat=120 "${OLD}" "${NEW}" | tail -n 60 | sed 's/^/    /'
      else
        echo "The previous commit is not in the fetched history; compare the files yourself."
      fi
      echo
    } >> "$RUNNER_TEMP/source-changes.md"
    echo "::notice::${SUB} moved ${OLD:0:8} → ${NEW:0:8}."
  fi
done

if [ "${#CHANGED[@]}" -gt 0 ]; then
  git add -- "${CHANGED[@]}"
  git commit -q -m "build: update sources (${CHANGED[*]})" \
    -m "Moved by the workflow at the start of session ${LEXI_SESSION} to the tip of each source's tracked branch."
fi
exit 0
