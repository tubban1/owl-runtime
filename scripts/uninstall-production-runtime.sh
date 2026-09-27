#!/bin/zsh
set -euo pipefail

AGENTOS_HOME="${AGENTOS_HOME:-$HOME/.agentos}"
LABEL="com.agentos.runtime"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "AgentOS Runtime launchd service removed."
echo "Releases, runtime.env, logs, and persistent state were intentionally kept."
echo "  releases: $AGENTOS_HOME/releases"
echo "  env:      $AGENTOS_HOME/runtime.env"
echo "  state:    ${AGENTOS_PRODUCTION_STATE_ROOT:-$HOME/.computer-mcp}"
