#!/usr/bin/env bash
# usage: slack-post.sh
#
# Posts the messages the phase gate queued in $RUNNER_TEMP/slack-outbox/ to
# LEXI_SLACK_WEBHOOK_URL, then removes them.
#
# It runs in a step of its own, after the builder's segment has ended and
# everything the builder started has been stopped. The builder's step never
# holds the webhook: a child that unsets a variable is no protection when the
# builder can read its parent's environment from /proc. segment.sh empties the
# outbox once the builder is done, so only what the gate queued after that is
# sent.
set -uo pipefail
PATH=/usr/bin:/bin:/usr/local/bin
OUTBOX="$RUNNER_TEMP/slack-outbox"
if [ -z "${LEXI_SLACK_WEBHOOK_URL:-}" ]; then
  rm -rf "$OUTBOX"
  exit 0
fi
[ -d "$OUTBOX" ] || exit 0
SENT=0
for F in "$OUTBOX"/*.json; do
  [ -f "$F" ] || continue
  # Only {"text": "..."}: nothing else in the file reaches Slack.
  if ! BODY="$(jq -c '{text: (.text | tostring)}' "$F" 2>/dev/null)"; then
    echo "::warning::Skipped a queued Slack message that was not valid JSON."
    continue
  fi
  CODE="$(printf '%s' "$BODY" | curl -q -sS -m 20 -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' --data-binary @- "$LEXI_SLACK_WEBHOOK_URL" 2>/dev/null || true)"
  case "$CODE" in
    2*) SENT=$((SENT + 1)) ;;
    *) echo "::warning::Could not post a gate verdict to Slack (HTTP ${CODE:-none})." ;;
  esac
done
rm -rf "$OUTBOX"
echo "Posted ${SENT} gate verdict(s) to Slack."
exit 0
