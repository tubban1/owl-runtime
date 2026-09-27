#!/bin/zsh
set -euo pipefail

OWL_HOME="${OWL_HOME:-${AGENTOS_HOME:-$HOME/.owl}}"
LABEL="com.owl.runtime"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "OWL Runtime launchd service removed."
echo "Releases, runtime.env, logs, and persistent state were intentionally kept."
echo "  releases: $OWL_HOME/releases"
echo "  env:      $OWL_HOME/runtime.env"
echo "  state:    ${OWL_PRODUCTION_STATE_ROOT:-${AGENTOS_PRODUCTION_STATE_ROOT:-$HOME/.owl-runtime}}"
