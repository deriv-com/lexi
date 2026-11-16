#!/usr/bin/env bash
# usage: install-tools.sh
#
# Installs Claude Code, Playwright (MCP server + Chromium) and the screenshot
# scoring libraries into $RUNNER_TEMP/tools, and writes the MCP config the
# builder runs with. Used by the build and the assess jobs.
#
# Every package is pinned to an exact version, so a new release cannot change
# what runs with the job's credentials. LEXI_CLAUDE_CODE_VERSION and
# LEXI_PLAYWRIGHT_MCP_VERSION (the workflow inputs claude_code_version and
# playwright_mcp_version) override the two that move fastest; Chromium follows
# the Playwright that @playwright/mcp pins.
set -euo pipefail
CLAUDE_CODE_VERSION="${LEXI_CLAUDE_CODE_VERSION:-2.1.319}"
PLAYWRIGHT_MCP_VERSION="${LEXI_PLAYWRIGHT_MCP_VERSION:-0.0.84}"
for V in "$CLAUDE_CODE_VERSION" "$PLAYWRIGHT_MCP_VERSION"; do
  if ! printf '%s' "$V" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'; then
    echo "::error::'$V' is not an exact version; pin claude_code_version and playwright_mcp_version to x.y.z."
    exit 1
  fi
done
npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
TOOLS="$RUNNER_TEMP/tools"
mkdir -p "$TOOLS"
cd "$TOOLS"
echo "LEXI_TOOLS_DIR=$TOOLS" >> "$GITHUB_ENV"
# browser_check "false": the builder gets no browser at all, so skip Chromium
# and give it an MCP config with no servers. The assess job always installs it.
if [ "${LEXI_INSTALL_BROWSER:-true}" = "false" ]; then
  echo '{"mcpServers": {}}' > "$RUNNER_TEMP/mcp.json"
  echo "No browser for the builder (browser_check is false)."
  claude --version
  exit 0
fi
npm init -y > /dev/null
npm install --no-audit --no-fund --save-exact "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" pngjs@7.0.0 pixelmatch@8.0.0
"$TOOLS/node_modules/.bin/playwright" install --with-deps chromium
# @playwright/mcp renamed its binary from `mcp-server-playwright` to `playwright-mcp`; with the old
# name the server never started and every builder ran with `status: failed` and no browser tools.
MCP_BIN="$TOOLS/node_modules/.bin/playwright-mcp"
[ -x "$MCP_BIN" ] || MCP_BIN="$TOOLS/node_modules/.bin/mcp-server-playwright"
if ! "$MCP_BIN" --help > /dev/null 2>&1; then
  echo "::error::The Playwright MCP server did not start ($MCP_BIN); the builder would run without a browser."
  exit 1
fi
jq -n --arg bin "$MCP_BIN" --arg out "$RUNNER_TEMP/mcp-output" \
  '{mcpServers: {playwright: {command: $bin, args: ["--headless", "--isolated", "--browser", "chromium", "--output-dir", $out]}}}' \
  > "$RUNNER_TEMP/mcp.json"
echo "LEXI_TOOLS_DIR=$TOOLS" >> "$GITHUB_ENV"
claude --version
