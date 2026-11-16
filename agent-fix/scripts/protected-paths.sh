#!/usr/bin/env bash
# protected-paths.sh — the one definition of "a path the agent may not change".
#
# Sourced, never executed. Used by the pre-push hook (what the agent actually
# changed) and by check-brief.sh (what the brief asks for before the agent
# starts), so the two can never disagree.
#
# Patterns are shell globs, matched case-insensitively against BOTH the full
# repository-relative path and the file's basename. `*` crosses directory
# boundaries, as in a `case` pattern. One pattern per line; blank lines and
# lines starting with `#` are ignored.
#
# A repository overrides the defaults by setting LEXI_PROTECTED_PATHS_FILE to
# a file of its own patterns. The file replaces the defaults; it does not add
# to them, so a repository can see exactly what applies by reading one list.

# Workflow and deployment definitions, dependency manifests, and anything named
# production. YAML is blocked wholesale rather than by pipeline name: it is how
# most repositories declare what runs and with what (Actions workflows,
# Kubernetes manifests, docker-compose, pubspec.yaml).
LEXI_DEFAULT_PROTECTED_PATTERNS='*.toml
*.yaml
*.yml
.github/production*
.github/release*
*/.github/production*
*/.github/release*
production/*
*/production/*
production
production.*
production-*
production_*'

lexi_protected_patterns() {
  if [ -n "${LEXI_PROTECTED_PATHS_FILE:-}" ] && [ -r "$LEXI_PROTECTED_PATHS_FILE" ]; then
    grep -v '^[[:space:]]*#' "$LEXI_PROTECTED_PATHS_FILE" | sed 's/[[:space:]]*$//' | grep -v '^$' || true
  else
    printf '%s\n' "$LEXI_DEFAULT_PROTECTED_PATTERNS"
  fi
}

# Prints the first pattern that protects $1 and returns 0, or returns 1.
#
# tr rather than ${p,,}: bash 3.2 (macOS) has no case-conversion expansion, and
# a guard that can only be exercised on the runner is a guard nobody checks.
lexi_protecting_pattern() {
  local p base pattern
  p="${1#./}"
  p="${p#/}"
  p=$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')
  [ -n "$p" ] || return 1
  base="${p##*/}"
  while IFS= read -r pattern; do
    [ -n "$pattern" ] || continue
    pattern=$(printf '%s' "$pattern" | tr '[:upper:]' '[:lower:]')
    # Unquoted on purpose: the pattern is a glob.
    # shellcheck disable=SC2254
    case "$p" in $pattern) printf '%s\n' "$pattern"; return 0 ;; esac
    # shellcheck disable=SC2254
    case "$base" in $pattern) printf '%s\n' "$pattern"; return 0 ;; esac
  done <<EOF
$(lexi_protected_patterns)
EOF
  return 1
}

lexi_is_protected_path() {
  lexi_protecting_pattern "$1" >/dev/null
}
