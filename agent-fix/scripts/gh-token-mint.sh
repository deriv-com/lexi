#!/usr/bin/env bash
#
# Mints one GitHub App installation token and exits.
#
# WHY A ONE-SHOT
#   Installation tokens last an hour, and the agents run for longer. An earlier
#   design kept a background daemon alive for the whole job with the App
#   private key in its environment; the agent runs as the same user and could
#   read that environment from /proc. Now nothing that holds the key outlives
#   its step: the workflows mint a fresh token in a step of its own before
#   each stretch of agent work, after agent-sandbox.sh stopped everything the
#   agent left running. The agent only ever sees tokens.
#
#   The workflows run this script from a copy whose digest they recorded
#   before any repository or agent code ran, so an edited copy is refused.
#   It resets PATH and HOME first, so a binary the agent planted on PATH, a
#   ~/.curlrc or a ~/.jq is never used while the key is in memory.
#
# REQUIRED ENVIRONMENT
#   APP_ID            GitHub App id or client id.
#   APP_PRIVATE_KEY   PEM private key for that App. Literal \n escapes are
#                     accepted as well as real newlines.
#   PERMISSIONS_JSON  JSON object of the permissions the token carries, e.g.
#                     {"contents":"write","pull_requests":"write"}; every value
#                     "read" or "write". Required: GitHub reads a request with
#                     no permissions as "every permission the installation
#                     has", so the script refuses to mint without it rather
#                     than let a step that forgot it get everything.
#
# OPTIONAL ENVIRONMENT
#   OWNER             Account the installation belongs to. Default: the owner
#                     of GITHUB_REPOSITORY.
#   REPOSITORIES      Repository names, separated by spaces or commas. Default:
#                     the repository in GITHUB_REPOSITORY.
#   OPTIONAL_PERMISSIONS_JSON
#                     Permissions to add only where the installation grants
#                     them (at least that level), e.g. {"checks":"read"} for a
#                     feature that degrades without it. An installation without
#                     them still gets a token, with PERMISSIONS_JSON alone.
#   TOKEN_FILE        Write the token here (mode 0600, atomically). A token
#                     already in the file is revoked once the new one is in
#                     place, so at most one token is live at a time.
#   OUTPUT_NAME       Also set the step output of this name to the token.
#
# The token is registered with ::add-mask:: before it is written anywhere, and
# never printed. Do not add debug output that would print it or the key.

PATH=/usr/bin:/bin:/usr/local/bin
export PATH
set -euo pipefail
unset LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV CURL_HOME OPENSSL_CONF SSL_CERT_FILE SSL_CERT_DIR 2>/dev/null || true

: "${APP_ID:?APP_ID is required}"
: "${APP_PRIVATE_KEY:?APP_PRIVATE_KEY is required}"

API_URL=${GITHUB_API_URL:-https://api.github.com}
OWNER=${OWNER:-${GITHUB_REPOSITORY%%/*}}
REPOSITORIES=$(printf '%s' "${REPOSITORIES:-${GITHUB_REPOSITORY#*/}}" | tr ',' ' ')
PERMISSIONS_JSON=${PERMISSIONS_JSON:-}
OPTIONAL_PERMISSIONS_JSON=${OPTIONAL_PERMISSIONS_JSON:-}

log() { printf 'gh-token-mint: %s\n' "$*"; }
fail() { printf '::error::gh-token-mint: %s\n' "$*"; exit 1; }

for tool in curl jq openssl mktemp; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: $tool"
done
[ -n "$OWNER" ] || fail "no OWNER, and GITHUB_REPOSITORY is unset"
# Fail closed: no permission set means GitHub grants every permission the
# installation has.
valid_permissions() { # json -> 0 when a non-empty object of name: read|write
  printf '%s' "$1" | jq -e 'type == "object" and length > 0
    and all(to_entries[]; (.key | test("^[a-z][a-z_]*$")) and (.value == "read" or .value == "write"))' >/dev/null 2>&1
}
[ -n "$PERMISSIONS_JSON" ] || fail "PERMISSIONS_JSON is required: name the permissions this token needs"
valid_permissions "$PERMISSIONS_JSON" || fail "PERMISSIONS_JSON must be a non-empty JSON object of read/write permissions"
if [ -n "$OPTIONAL_PERMISSIONS_JSON" ]; then
  valid_permissions "$OPTIONAL_PERMISSIONS_JSON" || fail "OPTIONAL_PERMISSIONS_JSON must be a non-empty JSON object of read/write permissions"
fi
# shellcheck disable=SC2086 # deliberate split of the repository list
set -- $REPOSITORIES
[ "$#" -gt 0 ] || fail "no repositories to scope the token to"
for r in "$@"; do
  printf '%s' "$r" | grep -Eq '^[A-Za-z0-9._-]+$' || fail "repository '$r' must be a bare name under $OWNER"
done
FIRST_REPO=$1

umask 077
WORK_DIR=$(mktemp -d)
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT
HOME="$WORK_DIR/home"
mkdir "$HOME"
export HOME
PEM_FILE="$WORK_DIR/app.pem"

# Secrets that travel through single-line stores arrive with literal \n escapes
# rather than real newlines. Mirrors normalizePrivateKey() in @lexi/github: a
# key with real line breaks is used as it is.
case "$APP_PRIVATE_KEY" in
  *$'\n'*) printf '%s\n' "$APP_PRIVATE_KEY" > "$PEM_FILE" ;;
  *) printf '%s\n' "$APP_PRIVATE_KEY" | sed 's/\\n/\
/g' > "$PEM_FILE" ;;
esac
openssl pkey -in "$PEM_FILE" -noout >/dev/null 2>&1 \
  || fail "APP_PRIVATE_KEY is not a usable PEM private key after normalisation"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# GitHub rejects App JWTs with more than 10 minutes of life; 9 is the usual
# margin, and iat is backdated a minute to tolerate runner clock skew.
make_jwt() {
  local now header payload signing_input signature
  now=$(date +%s)
  header='{"alg":"RS256","typ":"JWT"}'
  payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$APP_ID")
  signing_input="$(printf '%s' "$header" | b64url).$(printf '%s' "$payload" | b64url)"
  signature=$(printf '%s' "$signing_input" | openssl dgst -sha256 -sign "$PEM_FILE" -binary | b64url)
  printf '%s.%s' "$signing_input" "$signature"
}

# curl -q (first) ignores any .curlrc. The bearer header goes through a file,
# not the command line, so it never shows in a process list.
HTTP_CODE=""
HTTP_BODY=""
http() { # method url credential [body]
  local method=$1 url=$2 auth=$3 body=${4:-} hdr="$WORK_DIR/headers" raw
  printf 'Authorization: Bearer %s\nAccept: application/vnd.github+json\nX-GitHub-Api-Version: 2022-11-28\n' "$auth" > "$hdr"
  if [ -n "$body" ]; then
    raw=$(curl -q -sS --max-time 30 -X "$method" "$url" -H @"$hdr" -H 'Content-Type: application/json' \
      --data-binary "$body" -w '\n%{http_code}') || { rm -f "$hdr"; return 1; }
  else
    raw=$(curl -q -sS --max-time 30 -X "$method" "$url" -H @"$hdr" -w '\n%{http_code}') || { rm -f "$hdr"; return 1; }
  fi
  rm -f "$hdr"
  HTTP_CODE=${raw##*$'\n'}
  HTTP_BODY=${raw%$'\n'*}
  case "$HTTP_CODE" in 2*) return 0 ;; *) return 1 ;; esac
}
api_message() { printf '%s' "$HTTP_BODY" | jq -r '.message // empty' 2>/dev/null || true; }

JWT=$(make_jwt) || fail "could not sign an App JWT"
http GET "$API_URL/repos/$OWNER/$FIRST_REPO/installation" "$JWT" \
  || fail "installation lookup for $OWNER/$FIRST_REPO failed: HTTP $HTTP_CODE $(api_message)"
INSTALLATION_ID=$(printf '%s' "$HTTP_BODY" | jq -r '.id // empty')
[ -n "$INSTALLATION_ID" ] || fail "installation lookup returned no id"

REPOS_JSON=$(printf '%s\n' "$@" | jq -R . | jq -s .)
# Optional permissions are added only at a level the installation grants; a
# required permission always wins over an optional one of the same name.
GRANTED=$(printf '%s' "$HTTP_BODY" | jq -c '.permissions // {}')
OPTIONAL=${OPTIONAL_PERMISSIONS_JSON:-'{}'}
PERMISSIONS=$(jq -cn --argjson req "$PERMISSIONS_JSON" --argjson opt "$OPTIONAL" --argjson granted "$GRANTED" '
  ($opt | with_entries(select(($granted[.key] // "") as $g | $g == "write" or ($g == "read" and .value == "read"))))
  + $req')
BODY=$(jq -n --argjson r "$REPOS_JSON" --argjson p "$PERMISSIONS" '{repositories: $r, permissions: $p}')
http POST "$API_URL/app/installations/$INSTALLATION_ID/access_tokens" "$JWT" "$BODY" \
  || fail "mint failed: HTTP $HTTP_CODE $(api_message)"
TOKEN=$(printf '%s' "$HTTP_BODY" | jq -r '.token // empty')
[ -n "$TOKEN" ] || fail "mint response carried no token"
EXPIRES=$(printf '%s' "$HTTP_BODY" | jq -r '.expires_at // "unknown"')
unset JWT

# Masked before it can reach a file the log might later show.
printf '::add-mask::%s\n' "$TOKEN"

if [ -n "${TOKEN_FILE:-}" ]; then
  PREVIOUS=""
  if [ -f "$TOKEN_FILE" ] && [ ! -L "$TOKEN_FILE" ]; then
    PREVIOUS=$(tr -d '\r\n' < "$TOKEN_FILE")
  fi
  # Atomic: git and gh read this file on every operation, so a reader sees the
  # whole previous token or the whole new one.
  TMP=$(mktemp "${TOKEN_FILE}.XXXXXX")
  printf '%s' "$TOKEN" > "$TMP"
  chmod 600 "$TMP"
  mv -f "$TMP" "$TOKEN_FILE"
  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$TOKEN" ]; then
    printf '::add-mask::%s\n' "$PREVIOUS"
    if http DELETE "$API_URL/installation/token" "$PREVIOUS"; then
      log "revoked the previous token"
    else
      log "could not revoke the previous token (HTTP $HTTP_CODE); it expires on its own within the hour"
    fi
  fi
fi
if [ -n "${OUTPUT_NAME:-}" ]; then
  [ -n "${GITHUB_OUTPUT:-}" ] || fail "OUTPUT_NAME is set but GITHUB_OUTPUT is not"
  printf '%s=%s\n' "$OUTPUT_NAME" "$TOKEN" >> "$GITHUB_OUTPUT"
fi
log "minted a token for $OWNER ($*) with $PERMISSIONS, expires $EXPIRES"
