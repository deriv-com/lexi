#!/usr/bin/env bash
# Keep tokens out of remote URLs, command arguments and persisted git config.
github_git() {
  git -c credential.helper= -c 'credential.helper=!f() { printf "username=x-access-token\npassword=%s\n" "$GH_TOKEN"; }; f' "$@"
}
