#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

VERSION="$(node -p "require('./package.json').version")"
SHORT_SHA="$(git rev-parse --short=12 HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
AGENTOS_HOME="${AGENTOS_HOME:-$HOME/.agentos}"
RELEASE_NAME="$VERSION-$SHORT_SHA"
RELEASE_DIR="$AGENTOS_HOME/releases/$RELEASE_NAME"
TMP_RELEASE="$AGENTOS_HOME/releases/.tmp-$RELEASE_NAME-$$"
CURRENT_LINK="$AGENTOS_HOME/current"
ENV_FILE="${AGENTOS_RUNTIME_ENV:-$AGENTOS_HOME/runtime.env}"
STATE_ROOT="${AGENTOS_PRODUCTION_STATE_ROOT:-$HOME/.computer-mcp}"
LOG_DIR="$AGENTOS_HOME/logs"
PLIST="$HOME/Library/LaunchAgents/com.agentos.runtime.plist"
PREVIOUS_RELEASE="$(readlink "$CURRENT_LINK" 2>/dev/null || true)"
LABEL="com.agentos.runtime"
NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"

if [[ "${ALLOW_DIRTY_PRODUCTION_INSTALL:-false}" != "true" ]]; then
  TRACKED_DIRTY="$(git status --porcelain --untracked-files=no)"
  if [[ -n "$TRACKED_DIRTY" ]]; then
    echo "Refusing production install from tracked dirty source."
    echo "Commit/verify the release first, or set ALLOW_DIRTY_PRODUCTION_INSTALL=true for an intentional development install."
    echo "$TRACKED_DIRTY"
    exit 2
  fi
fi

mkdir -p "$AGENTOS_HOME/releases" "$LOG_DIR" "$(dirname "$PLIST")"

echo "Building AgentOS Runtime $VERSION..."
"$NPM_BIN" run build

rm -rf "$TMP_RELEASE"
mkdir -p "$TMP_RELEASE"
cp -R dist "$TMP_RELEASE/dist"
cp package.json package-lock.json "$TMP_RELEASE/"

echo "Installing production dependencies into immutable release..."
(
  cd "$TMP_RELEASE"
  "$NPM_BIN" ci --omit=dev --ignore-scripts --no-audit --no-fund
)

cat > "$TMP_RELEASE/run.sh" <<EOF
#!/bin/zsh
set -euo pipefail

ENV_FILE="${AGENTOS_RUNTIME_ENV:-$ENV_FILE}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

export AGENTOS_RUNTIME_MODE=production
export AGENTOS_STATE_ROOT="${AGENTOS_PRODUCTION_STATE_ROOT:-$STATE_ROOT}"
RELEASE_ROOT="\$(cd "\$(dirname "\$0")" && pwd)"
exec "$NODE_BIN" "\$RELEASE_ROOT/dist/server.js"
EOF
chmod 700 "$TMP_RELEASE/run.sh"

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$REPO_ROOT/.env" ]]; then
    cp "$REPO_ROOT/.env" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "Created $ENV_FILE from the current project .env."
  else
    cat > "$ENV_FILE" <<'EOF'
# AgentOS Runtime production environment.
# Add ALLOWED_DIRECTORIES and capability flags here.
PORT=8787
AGENTOS_WAKE_NAME=Jarvis
EOF
    chmod 600 "$ENV_FILE"
    echo "Created minimal $ENV_FILE. Configure permissions before relying on production actions."
  fi
fi

if [[ -e "$RELEASE_DIR" ]]; then
  rm -rf "$RELEASE_DIR"
fi
mv "$TMP_RELEASE" "$RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CURRENT_LINK/run.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$CURRENT_LINK</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/runtime.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/runtime.stderr.log</string>
</dict>
</plist>
EOF
chmod 600 "$PLIST"

launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL"

# Read PORT from the production environment without allowing it to change the
# installer's release/state decisions.
HEALTH_PORT="$(
  /bin/zsh -c '
    set -a
    [[ -f "$1" ]] && source "$1"
    set +a
    print -r -- "${PORT:-8787}"
  ' _ "$ENV_FILE"
)"

HEALTH_URL="http://127.0.0.1:$HEALTH_PORT/health"
HEALTH_FILE="$AGENTOS_HOME/last-health.json"
HEALTHY=false
for _ in {1..80}; do
  if /usr/bin/curl -fsS "$HEALTH_URL" > "$HEALTH_FILE" 2>/dev/null; then
    if "$NODE_BIN" -e '
      const fs = require("fs");
      const [file, version, expectedState] = process.argv.slice(1);
      const health = JSON.parse(fs.readFileSync(file, "utf8"));
      const ok =
        health?.ok === true &&
        health?.version === version &&
        health?.runtime?.mode === "production" &&
        health?.runtime?.stateRoot === expectedState;
      process.exit(ok ? 0 : 2);
    ' "$HEALTH_FILE" "$VERSION" "$STATE_ROOT"; then
      HEALTHY=true
      break
    fi
  fi
  sleep 0.25
done

if [[ "$HEALTHY" != "true" ]]; then
  echo "AgentOS Runtime failed health check: $HEALTH_URL"
  echo "stdout: $LOG_DIR/runtime.stdout.log"
  echo "stderr: $LOG_DIR/runtime.stderr.log"

  if [[ -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
    echo "Rolling current symlink back to previous release:"
    echo "  $PREVIOUS_RELEASE"
    PREVIOUS_VERSION="$(
      "$NODE_BIN" -e '
        const fs = require("fs");
        const path = require("path");
        const release = process.argv[1];
        const pkg = JSON.parse(fs.readFileSync(path.join(release, "package.json"), "utf8"));
        process.stdout.write(String(pkg.version || ""));
      ' "$PREVIOUS_RELEASE" 2>/dev/null || true
    )"

    ln -sfn "$PREVIOUS_RELEASE" "$CURRENT_LINK"
    launchctl kickstart -k "gui/$UID/$LABEL" >/dev/null 2>&1 || true

    ROLLBACK_HEALTHY=false
    for _ in {1..80}; do
      if /usr/bin/curl -fsS "$HEALTH_URL" > "$HEALTH_FILE" 2>/dev/null; then
        if "$NODE_BIN" -e '
          const fs = require("fs");
          const [file, expectedVersion, expectedState] = process.argv.slice(1);
          const health = JSON.parse(fs.readFileSync(file, "utf8"));
          const versionOk = !expectedVersion || health?.version === expectedVersion;
          const ok =
            health?.ok === true &&
            versionOk &&
            health?.runtime?.mode === "production" &&
            health?.runtime?.stateRoot === expectedState;
          process.exit(ok ? 0 : 2);
        ' "$HEALTH_FILE" "$PREVIOUS_VERSION" "$STATE_ROOT"; then
          ROLLBACK_HEALTHY=true
          break
        fi
      fi
      sleep 0.25
    done

    if [[ "$ROLLBACK_HEALTHY" != "true" ]]; then
      echo "Rollback failed health verification; stopping the launchd service."
      launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
      exit 1
    fi

    echo "Rollback health verified for previous release ${PREVIOUS_VERSION:-unknown}."
  else
    echo "No previous release is available; stopping the unhealthy launchd service."
    launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
  fi
  exit 1
fi

echo "AgentOS Runtime production release installed."
echo "  version: $VERSION"
echo "  release: $RELEASE_DIR"
echo "  current: $CURRENT_LINK"
echo "  state:   $STATE_ROOT"
echo "  env:     $ENV_FILE"
echo "  health:  $HEALTH_URL"
cat "$AGENTOS_HOME/last-health.json"
echo
