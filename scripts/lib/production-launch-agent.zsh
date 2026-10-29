#!/bin/zsh
# Retry transient macOS launchd bootstrap failures while preserving testability.
# A failed 'bootstrap' can still have registered the job; verify via 'print'.
owl_launch_agent_bootstrap() {
  emulate -L zsh
  local domain="$1" label="$2" plist="$3" max_attempts="${4:-3}"
  local attempt=1
  while (( attempt <= max_attempts )); do
    if launchctl bootstrap "$domain" "$plist"; then
      return 0
    fi
    if launchctl print "$domain/$label" >/dev/null 2>&1; then
      return 0
    fi
    if (( attempt < max_attempts )); then
      sleep "$attempt"
    fi
    (( attempt++ ))
  done
  return 1
}
