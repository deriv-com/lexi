#!/usr/bin/env bash
# Sourced by every script that runs git with a GitHub App token (push.sh,
# report.sh).
#
# The builder, and the app's own test code in the assess job, run as this same
# user before those scripts. Whatever git configuration they could leave behind
# (a hook, core.hooksPath, core.fsmonitor, a credential helper, a filter
# driver, url.*.insteadOf pointing github.com elsewhere, a global or XDG config
# file, a template directory) must not run a command, or receive the token,
# when git runs with credentials. So from here on:
#
# - git reads no system, global or XDG configuration: HOME is a fresh empty
#   directory and GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM point at /dev/null.
# - Settings given in the environment (GIT_CONFIG_COUNT), which outrank every
#   configuration file including the repository's own, turn off hooks and the
#   file-system monitor and clear every credential helper.
# - The token is handed out only for https://github.com, so a rewritten remote
#   URL cannot carry it to another host.
#
# The repository's .git/config is restored and verified by segment.sh before
# these scripts run; the overrides above hold even if it was not.

_LEXI_GIT_HOME="$(mktemp -d "${RUNNER_TEMP:-/tmp}/git-home.XXXXXX")"
export HOME="$_LEXI_GIT_HOME"
export XDG_CONFIG_HOME="$_LEXI_GIT_HOME/.config"
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/false
export SSH_ASKPASS=/bin/false
unset GIT_SSH GIT_SSH_COMMAND GIT_EXEC_PATH GIT_TEMPLATE_DIR GIT_DIR GIT_WORK_TREE GIT_PROXY_COMMAND
export GIT_CONFIG_COUNT=4
export GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null
export GIT_CONFIG_KEY_1=core.fsmonitor GIT_CONFIG_VALUE_1=false
export GIT_CONFIG_KEY_2=credential.helper GIT_CONFIG_VALUE_2=
export GIT_CONFIG_KEY_3=core.sshCommand GIT_CONFIG_VALUE_3=/bin/false

# Keep tokens out of remote URLs, command arguments and persisted git config.
# The helper answers only for github.com over https.
github_git() {
  git -c credential.helper= -c 'credential.helper=!f() { [ "$1" = get ] || exit 0; ok=; while IFS= read -r l && [ -n "$l" ]; do case "$l" in host=github.com) ok=1;; protocol=https) ;; protocol=*) exit 0;; esac; done; [ -n "$ok" ] || exit 0; printf "username=x-access-token\npassword=%s\n" "$GH_TOKEN"; }; f' "$@"
}
