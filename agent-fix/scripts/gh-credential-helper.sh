#!/usr/bin/env bash
#
# git credential helper backed by the token files that gh-token-mint.sh writes.
#
# git invokes this on every authenticated github.com operation, so a push that
# happens 90 minutes into a run reads the token minted before the current agent
# segment rather than the one the job started with. Nothing caches the
# credential: it is not in a remote URL, not in an http.extraheader, and not in
# ~/.gitconfig.
#
# Routing comes from a map file (default /tmp/gh-credential-map), one entry per
# line, written by the workflow:
#
#     acme/shared-sdk=/tmp/gh-token-read
#     *=/tmp/gh-token
#
# A key other than "*" names one repository and matches git's `path` credential
# attribute exactly, with or without `.git` (so `acme/shared-sdk` does not also
# match `acme/shared-sdk-fork`), which git only supplies when
# `credential.https://github.com.useHttpPath = true` is set. A job that needs
# one token for everything can therefore write a single `*` line and skip
# useHttpPath; a job mixing tokens from different Apps (a read-only dependency
# alongside write access, say) must set it, or every repository silently falls
# through to `*` and gets the wrong credential.
#
# Exiting 0 with no output means "I have no credential for this"; git then falls
# through to its normal behaviour, which in CI is a clear
# "could not read Username" rather than a confusing 403.

set -euo pipefail

MAP_FILE=${GH_CREDENTIAL_MAP:-/tmp/gh-credential-map}

# `store` and `erase` are accepted and ignored — there is nothing to persist,
# and erroring would make git treat the helper as broken.
[ "${1:-}" = "get" ] || exit 0

protocol=""
host=""
request_path=""
while IFS= read -r line; do
  [ -n "$line" ] || break
  case "$line" in
    protocol=*) protocol=${line#protocol=} ;;
    host=*) host=${line#host=} ;;
    path=*) request_path=${line#path=} ;;
  esac
done

[ "$protocol" = "https" ] || exit 0
[ "$host" = "github.com" ] || exit 0
[ -r "$MAP_FILE" ] || exit 0

default_file=""
matched_file=""
while IFS='=' read -r prefix file; do
  case "$prefix" in
    ''|'#'*) continue ;;
    '*') default_file=$file ;;
    *)
      case "$request_path" in
        "$prefix" | "$prefix.git" | "$prefix/"*) matched_file=$file ;;
      esac
      ;;
  esac
done < "$MAP_FILE"

token_file=${matched_file:-$default_file}
[ -n "$token_file" ] || exit 0
[ -s "$token_file" ] || exit 0

printf 'username=x-access-token\n'
printf 'password=%s\n' "$(tr -d '\r\n' < "$token_file")"
