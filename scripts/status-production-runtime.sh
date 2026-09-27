#!/bin/zsh
set -euo pipefail

AGENTOS_HOME="${AGENTOS_HOME:-$HOME/.agentos}"
ENV_FILE="${AGENTOS_RUNTIME_ENV:-$AGENTOS_HOME/runtime.env}"
LABEL="com.agentos.runtime"

PORT_VALUE="$(
  /bin/zsh -c '
    set -a
    [[ -f "$1" ]] && source "$1"
    set +a
    print -r -- "${PORT:-8787}"
  ' _ "$ENV_FILE"
)"

echo "AgentOS production status"
echo "  current: $(readlink "$AGENTOS_HOME/current" 2>/dev/null || echo "(not installed)")"
echo "  env:     $ENV_FILE"
echo "  launchd:"
launchctl print "gui/$UID/$LABEL" 2>/dev/null | sed -n '1,32p' || echo "    not loaded"
echo "  health:"
/usr/bin/curl -fsS "http://127.0.0.1:$PORT_VALUE/health" || true
echo
