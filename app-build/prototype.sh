#!/usr/bin/env bash
# usage: prototype.sh
#
# Serves the design prototype (a Next.js app in the submodule named by
# LEXI_PROTOTYPE_DIR) on :4000, so the builder and the visual check can compare
# against it, and exports LEXI_PROTOTYPE_URL when it answers. No prototype
# configured, or one that does not start, is a warning: the build goes on.
# segment.sh starts it for each segment and stops it with the segment, so its
# dependencies are installed once and reused.
set -uo pipefail
cd "$GITHUB_WORKSPACE"
DIR="${LEXI_PROTOTYPE_DIR:-}"
if [ -z "$DIR" ] || [ ! -f "$DIR/package.json" ]; then
  echo "No prototype to serve${DIR:+ (no package.json in ${DIR}/)}."
  exit 0
fi
cd "$DIR"
if [ ! -d node_modules ] && ! npm ci --no-audit --no-fund > "$RUNNER_TEMP/prototype-install.log" 2>&1; then
  tail -n 40 "$RUNNER_TEMP/prototype-install.log"
  echo "::warning::The prototype's dependencies did not install; the builder can try itself."
  exit 0
fi
nohup npx --no-install next dev -p 4000 > "$RUNNER_TEMP/prototype.log" 2>&1 &
for i in $(seq 1 120); do
  if curl -s -o /dev/null -w '%{http_code}' http://localhost:4000/ | grep -q '^[23]'; then
    echo "Prototype is up."
    echo "LEXI_PROTOTYPE_URL=http://localhost:4000" >> "$GITHUB_ENV"
    exit 0
  fi
  sleep 1
done
tail -n 40 "$RUNNER_TEMP/prototype.log"
echo "::warning::The prototype did not answer on :4000; the builder can start it itself."
exit 0
