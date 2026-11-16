#!/usr/bin/env bash
# usage: assess.sh checks | review
#
# Runs one part of the assessment, then stops everything it started.
#
#   checks  serves the prototype and runs checks.sh: the app's own test and
#           build scripts, which the builder wrote
#   review  runs review.sh, a read-only model session over the builder's diff
#
# Both run code or read text the builder controls. The step after them mints a
# GitHub App token with the private key, and a process left running from here
# could read that step's environment through /proc. So, as segment.sh does for
# the builder, this script ends by stopping every process of this user that
# started after it did (agent-sandbox.sh) and truncating the step's
# GITHUB_ENV, GITHUB_PATH and GITHUB_OUTPUT. If a process survives, it exits 1,
# and the workflow mints no token after it.
#
# The workflow runs this from a copy whose digest it recorded before any of the
# builder's code ran. The body is one function, so bash has read all of it
# before anything else starts.

main() {
  set -uo pipefail
  local PART=${1:?checks or review} TOOLS MARK RC=0 STOP_RC=0
  TOOLS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck source=/dev/null
  source "$TOOLS/agent-sandbox.sh"
  MARK="$(sandbox_mark)"

  case "$PART" in
    checks)
      LEXI_PROTOTYPE_URL=""
      if [ -n "${LEXI_PROTOTYPE_DIR:-}" ]; then
        : > "$RUNNER_TEMP/prototype.env"
        GITHUB_ENV="$RUNNER_TEMP/prototype.env" /bin/bash "$TOOLS/prototype.sh"
        LEXI_PROTOTYPE_URL="$(sed -n 's/^LEXI_PROTOTYPE_URL=//p' "$RUNNER_TEMP/prototype.env" | tail -n 1)"
      fi
      export LEXI_PROTOTYPE_URL
      # Inside the step's 50 minutes, so the sweep below always runs.
      timeout --signal=TERM --kill-after=30s 47m /bin/bash "$TOOLS/checks.sh" || RC=$?
      ;;
    review)
      # The reviewer needs only the model token.
      env -u GH_TOKEN -u GITHUB_TOKEN -u STAGING_TEST_EMAIL -u STAGING_TEST_PASSWORD \
        -u STAGING_REAL_EMAIL -u STAGING_REAL_PASSWORD -u MAILISK_API_KEY -u MAILISK_NAMESPACE \
        timeout --signal=TERM --kill-after=30s 28m /bin/bash "$TOOLS/review.sh" || RC=$?
      ;;
    *)
      echo "usage: assess.sh checks | review" >&2
      RC=2
      ;;
  esac

  sandbox_stop "$MARK" || STOP_RC=$?
  sandbox_reset_file_commands
  if [ "$STOP_RC" -ne 0 ]; then
    echo "::error::assess.sh: processes started by the ${PART} could not be stopped; no token is minted after this step."
    ASSESS_RC=1
    return
  fi
  ASSESS_RC=$RC
}

ASSESS_RC=1
main "$@"; exit "${ASSESS_RC:-1}"
