#!/usr/bin/env bash
# usage: intake.sh
#
# Gives the builder the feature-intake issues it builds from. Every OPEN issue
# carrying LEXI_INTAKE_LABEL (for example `ready-for-agent`) is written to
# intake/<number>.md beside the app: title, labels, body, and the comments of
# the people in LEXI_FEEDBACK_AUTHORS (where the team answers the intake's
# open decisions). Anyone else's comment is dropped and only counted, as in
# feedback.sh: the builder runs unattended, so what it reads must come from a
# person the caller chose.
#
# Only issues the intake workflow filed (its `lexi-feature-intake` marker) or
# that an allowlisted person opened are taken; a labelled issue from anyone
# else is skipped with a notice.
#
# The intake's screenshots live on the never-merged `lexi/intake-assets`
# branch; it is cloned read-only into intake/assets/, with the token stripped
# from the clone. intake/ is in .git/info/exclude, so it is never committed.
#
# Writes $RUNNER_TEMP/intake-note.md, the sentence the prompts show the builder.
# Needs GH_TOKEN. With LEXI_INTAKE_LABEL empty it does nothing.
set -uo pipefail

cd "$GITHUB_WORKSPACE"
NOTE="$RUNNER_TEMP/intake-note.md"
LABEL="${LEXI_INTAKE_LABEL:-}"
if [ -z "$LABEL" ]; then
  echo "No feature-intake issues are configured for this build." > "$NOTE"
  exit 0
fi

DIR="intake"
mkdir -p .git/info
grep -qxF "/${DIR}/" .git/info/exclude 2>/dev/null || echo "/${DIR}/" >> .git/info/exclude
rm -rf "$DIR"
mkdir -p "$DIR"
REPO="$GITHUB_REPOSITORY"
ALLOWED="$(printf '%s' "${LEXI_FEEDBACK_AUTHORS:-}" | tr 'A-Z' 'a-z' | tr -d ' ' | jq -R -c 'split(",") | map(select(length > 0))')"

ISSUES="$(gh issue list --repo "$REPO" --state open --label "$LABEL" --limit 50 \
  --json number,title,author,labels,body,url 2>/dev/null || echo '[]')"
COUNT=0
SKIPPED=0
INDEX=()
for N in $(jq -r '.[].number' <<< "$ISSUES" | sort -n); do
  ISSUE="$(jq -c --argjson n "$N" '.[] | select(.number == $n)' <<< "$ISSUES")"
  AUTHOR="$(jq -r '.author.login // ""' <<< "$ISSUE" | tr 'A-Z' 'a-z')"
  if ! jq -e '.body | contains("<!-- lexi-feature-intake")' <<< "$ISSUE" > /dev/null \
     && ! jq -e --arg a "$AUTHOR" 'index($a)' <<< "$ALLOWED" > /dev/null; then
    echo "::notice::Skipping #${N}: labelled ${LABEL}, but neither filed by the intake workflow nor opened by an allowlisted person."
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  COMMENTS="$(gh api --paginate "repos/${REPO}/issues/${N}/comments" \
    --jq '.[] | {at: .created_at, who: .user.login, body: .body}' 2>/dev/null | jq -s '.' || echo '[]')"
  {
    jq -r '"# #\(.number) \(.title)\n\nLabels: \([.labels[].name] | join(", ")). Source: \(.url)\n"' <<< "$ISSUE"
    jq -r '.body // ""' <<< "$ISSUE" | grep -v '^<!-- lexi-feature-intake'
    echo
    echo "## Comments from the team"
    echo
    echo "These answer the issue's open decisions; where one does, it overrides the issue's suggested default."
    echo
    jq -r --argjson allowed "$ALLOWED" '
      [ .[] | select((.who | ascii_downcase) as $w | $allowed | index($w)) ]
      | if length == 0 then "(none)" else .[] | "- **\(.who)** (\(.at)): \(.body | gsub("\r"; ""))" end
    ' <<< "$COMMENTS"
  } > "${DIR}/${N}.md"
  INDEX+=("#${N} $(jq -r '.title' <<< "$ISSUE") → \`${DIR}/${N}.md\`")
  COUNT=$((COUNT + 1))
done

ASSETS=""
if [ "$COUNT" -gt 0 ]; then
  for DELAY in 0 3 6; do
    sleep "$DELAY"
    if git clone -q --depth 1 --branch lexi/intake-assets --single-branch \
         "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "${DIR}/assets" 2>/dev/null; then
      # Files only: no history and no remote that carries the token.
      rm -rf "${DIR}/assets/.git"
      ASSETS=1
      break
    fi
  done
fi

if [ "$COUNT" -eq 0 ]; then
  echo "No open issue carries the \`${LABEL}\` label, so there is no feature intake to build from this session." > "$NOTE"
else
  {
    echo "The feature-intake issues in scope (open, labelled \`${LABEL}\`) are copied read-only into \`${DIR}/\`. Each records how the live product does the feature (design, copy, API calls in order, console output) and how it differs from the spec, with the team's answers to its open decisions in its comments:"
    for LINE in "${INDEX[@]}"; do echo "- ${LINE}"; done
    if [ -n "$ASSETS" ]; then
      echo "Their screenshots are in \`${DIR}/assets/intake/<run id>/\` (the run id is in each issue's links). Look at them."
    else
      echo "Their screenshots could not be fetched this session; the issues' links point at them on the \`lexi/intake-assets\` branch."
    fi
    echo "Never edit or commit \`${DIR}/\`."
  } > "$NOTE"
fi
echo "Feature intake: ${COUNT} issue(s) labelled ${LABEL} given to the builder; ${SKIPPED} skipped."
exit 0
