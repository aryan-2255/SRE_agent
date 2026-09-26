#!/usr/bin/env bash
# Start TrueForge (unmodified, pinned) so it can reach NightShift's MCP servers on localhost.
# If a bundled TrueForge database exists at .data/trueforge.sqlite (shipped in the team zip), use it,
# so this machine starts with the same models, connectors, sandbox and agents. Otherwise TrueForge uses
# its default data folder and keeps whatever was set up in its UI.
set -euo pipefail
cd "$(dirname "$0")/.."
export OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'
if [ -f .data/trueforge.sqlite ]; then
  export SQLITE_PATH="$PWD/.data/trueforge.sqlite"
  echo "Using bundled TrueForge setup: $SQLITE_PATH"
fi
exec npx -y @truefoundry/trueforge@0.2.1 --port "${TRUEFORGE_PORT:-8790}"
