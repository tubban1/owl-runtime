#!/bin/zsh
set -euo pipefail

OWL_HOME="${OWL_HOME:-${AGENTOS_HOME:-$HOME/.owl}}"
ENV_FILE="${OWL_RUNTIME_ENV:-${AGENTOS_RUNTIME_ENV:-$OWL_HOME/runtime.env}}"
LABEL="com.owl.runtime"

PORT_VALUE="$(
  /bin/zsh -c '
    set -a
    [[ -f "$1" ]] && source "$1"
    set +a
    print -r -- "${PORT:-8787}"
  ' _ "$ENV_FILE"
)"

echo "OWL Runtime production status"
echo "  current: $(readlink "$OWL_HOME/current" 2>/dev/null || echo "(not installed)")"
echo "  env:     $ENV_FILE"
echo "  launchd:"
launchctl print "gui/$UID/$LABEL" 2>/dev/null | sed -n '1,32p' || echo "    not loaded"
echo "  health:"
/usr/bin/curl -fsS "http://127.0.0.1:$PORT_VALUE/health" || true
echo
