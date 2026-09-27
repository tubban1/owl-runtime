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
LABEL="com.agentos.runtime"
NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"
CONTROL_CLIENT="$REPO_ROOT/scripts/runtime-control-client.mjs"
STATE_CLIENT="$REPO_ROOT/scripts/runtime-state-client.mjs"
PREVIOUS_RELEASE="$(readlink "$CURRENT_LINK" 2>/dev/null || true)"
DRAIN_TIMEOUT_MS="${AGENTOS_UPGRADE_DRAIN_TIMEOUT_MS:-120000}"

if ! [[ "$DRAIN_TIMEOUT_MS" =~ ^[0-9]+$ ]]; then
  echo "AGENTOS_UPGRADE_DRAIN_TIMEOUT_MS must be an integer number of milliseconds."
  exit 2
fi

if [[ -z "$PREVIOUS_RELEASE" || ! -d "$PREVIOUS_RELEASE" ]]; then
  echo "No active AgentOS production release is installed."
  echo "Use: npm run install:production"
  exit 2
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Production environment does not exist: $ENV_FILE"
  exit 2
fi

if [[ "${ALLOW_DIRTY_PRODUCTION_INSTALL:-false}" != "true" ]]; then
  TRACKED_DIRTY="$(git status --porcelain --untracked-files=no)"
  if [[ -n "$TRACKED_DIRTY" ]]; then
    echo "Refusing production upgrade from tracked dirty source."
    echo "Commit/verify the release first, or set ALLOW_DIRTY_PRODUCTION_INSTALL=true for an intentional development upgrade."
    echo "$TRACKED_DIRTY"
    exit 2
  fi
fi

mkdir -p "$AGENTOS_HOME/releases" "$LOG_DIR"

PRODUCTION_PORT="$(
  /bin/zsh -c '
    set -a
    [[ -f "$1" ]] && source "$1"
    set +a
    print -r -- "${PORT:-8787}"
  ' _ "$ENV_FILE"
)"
MCP_URL="http://127.0.0.1:$PRODUCTION_PORT/mcp"
HEALTH_URL="http://127.0.0.1:$PRODUCTION_PORT/health"
CURRENT_HEALTH="$AGENTOS_HOME/upgrade-current-health.json"

if ! /usr/bin/curl -fsS "$HEALTH_URL" > "$CURRENT_HEALTH" 2>/dev/null; then
  echo "Current AgentOS Runtime is not healthy at $HEALTH_URL."
  echo "Use npm run status:production and repair the current service before upgrading."
  exit 1
fi

if ! "$NODE_BIN" -e '
  const fs=require("fs");
  const h=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  process.exit(
    h?.ok === true &&
    h?.runtime?.mode === "production" &&
    h?.capabilities?.gracefulDrain === true
      ? 0
      : 2
  );
' "$CURRENT_HEALTH"; then
  echo "Current Runtime does not advertise gracefulDrain. A legacy install/cutover is required."
  exit 2
fi

echo "Building AgentOS Runtime $VERSION..."
"$NPM_BIN" run build

rm -rf "$TMP_RELEASE"
mkdir -p "$TMP_RELEASE"
cp -R dist "$TMP_RELEASE/dist"
cp package.json package-lock.json "$TMP_RELEASE/"

echo "Installing production dependencies into candidate release..."
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

if [[ -e "$RELEASE_DIR" ]]; then
  rm -rf "$RELEASE_DIR"
fi
mv "$TMP_RELEASE" "$RELEASE_DIR"

CANDIDATE_PORT="$(
  "$NODE_BIN" -e '
    const net=require("net");
    const server=net.createServer();
    server.listen(0,"127.0.0.1",()=>{
      const address=server.address();
      console.log(address.port);
      server.close();
    });
  '
)"
CANDIDATE_HEALTH_URL="http://127.0.0.1:$CANDIDATE_PORT/health"
CANDIDATE_MCP_URL="http://127.0.0.1:$CANDIDATE_PORT/mcp"
CANDIDATE_HEALTH="$AGENTOS_HOME/upgrade-candidate-health.json"
CANDIDATE_STDOUT="$LOG_DIR/candidate-$RELEASE_NAME.stdout.log"
CANDIDATE_STDERR="$LOG_DIR/candidate-$RELEASE_NAME.stderr.log"
CANDIDATE_PID=""
OLD_DRAINED=false
SWITCHED=false

resume_old_runtime() {
  if [[ "$OLD_DRAINED" == "true" && "$SWITCHED" == "false" ]]; then
    "$NODE_BIN" "$CONTROL_CLIENT" "$MCP_URL" resume >/dev/null 2>&1 || true
    OLD_DRAINED=false
  fi
}

stop_candidate() {
  if [[ -n "$CANDIDATE_PID" ]] && kill -0 "$CANDIDATE_PID" 2>/dev/null; then
    kill -TERM "$CANDIDATE_PID" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "$CANDIDATE_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$CANDIDATE_PID" 2>/dev/null || true
    wait "$CANDIDATE_PID" 2>/dev/null || true
  fi
  CANDIDATE_PID=""
}

cleanup() {
  stop_candidate
  resume_old_runtime
}
trap cleanup EXIT INT TERM

echo "Starting candidate preflight on port $CANDIDATE_PORT..."
(
  set -a
  source "$ENV_FILE"
  set +a
  export PORT="$CANDIDATE_PORT"
  export AGENTOS_RUNTIME_MODE=production
  export AGENTOS_STATE_ROOT="$STATE_ROOT"
  export AGENTOS_CANDIDATE_MODE=true
  exec "$NODE_BIN" "$RELEASE_DIR/dist/server.js"
) >"$CANDIDATE_STDOUT" 2>"$CANDIDATE_STDERR" &
CANDIDATE_PID=$!

CANDIDATE_HEALTHY=false
for _ in {1..160}; do
  if ! kill -0 "$CANDIDATE_PID" 2>/dev/null; then
    break
  fi
  if /usr/bin/curl -fsS "$CANDIDATE_HEALTH_URL" > "$CANDIDATE_HEALTH" 2>/dev/null; then
    if "$NODE_BIN" -e '
      const fs=require("fs");
      const [file,version,state,release]=process.argv.slice(1);
      const h=JSON.parse(fs.readFileSync(file,"utf8"));
      const ok =
        h?.ok === true &&
        h?.version === version &&
        h?.runtime?.mode === "production" &&
        h?.runtime?.candidateMode === true &&
        h?.runtime?.stateRoot === state &&
        h?.runtime?.codeRoot === release &&
        h?.runtime?.backgroundControllersStarted === false &&
        h?.runtime?.lifecycle?.state === "draining" &&
        h?.runtime?.stateSchema?.readable === true &&
        (
          h?.runtime?.stateSchema?.migrationRequired !== true ||
          (
            h?.runtime?.stateSchema?.autoMigrationSafe === true &&
            h?.runtime?.stateSchema?.rollbackCompatible === true
          )
        ) &&
        h?.capabilities?.upgradeCandidateMode === true &&
        h?.capabilities?.versionedStateSchema === true &&
        h?.capabilities?.stateMigrationRegistry === true;
      process.exit(ok ? 0 : 2);
    ' "$CANDIDATE_HEALTH" "$VERSION" "$STATE_ROOT" "$RELEASE_DIR"; then
      CANDIDATE_HEALTHY=true
      break
    fi
  fi
  sleep 0.25
done

if [[ "$CANDIDATE_HEALTHY" != "true" ]]; then
  echo "Candidate Runtime failed preflight health verification."
  echo "stdout: $CANDIDATE_STDOUT"
  echo "stderr: $CANDIDATE_STDERR"
  exit 1
fi

echo "Candidate preflight healthy. Requesting graceful drain of current Runtime..."
DRAIN_RESULT="$AGENTOS_HOME/upgrade-drain.json"
WAIT_RESULT="$AGENTOS_HOME/upgrade-wait.json"

if ! "$NODE_BIN" "$CONTROL_CLIENT" "$MCP_URL" drain   "{\"reason\":\"production upgrade to $VERSION\"}" > "$DRAIN_RESULT"; then
  echo "Current Runtime rejected the drain request."
  exit 1
fi
OLD_DRAINED=true

if ! "$NODE_BIN" "$CONTROL_CLIENT" "$MCP_URL" wait   "{\"timeout_ms\":$DRAIN_TIMEOUT_MS}" > "$WAIT_RESULT"; then
  echo "Drain wait call failed. Resuming current Runtime."
  exit 1
fi

if ! "$NODE_BIN" -e '
  const fs=require("fs");
  const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  process.exit(r?.drained === true && r?.timedOut !== true ? 0 : 2);
' "$WAIT_RESULT"; then
  echo "Current Runtime did not drain within $DRAIN_TIMEOUT_MS ms."
  echo "Current Runtime will be resumed; no release switch was performed."
  exit 1
fi

STATE_MIGRATION_RESULT="$AGENTOS_HOME/upgrade-state-migration.json"
STATE_MIGRATION_REQUIRED=false
if "$NODE_BIN" -e '
  const fs=require("fs");
  const h=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  process.exit(h?.runtime?.stateSchema?.migrationRequired === true ? 0 : 1);
' "$CANDIDATE_HEALTH"; then
  STATE_MIGRATION_REQUIRED=true
fi

if [[ "$STATE_MIGRATION_REQUIRED" == "true" ]]; then
  echo "Current Runtime drained. Applying candidate state-schema migration..."
  if ! "$NODE_BIN" "$STATE_CLIENT" "$CANDIDATE_MCP_URL" migrate     "{\"confirm\":true}" > "$STATE_MIGRATION_RESULT"; then
    echo "Candidate state-schema migration failed. Current Runtime will be resumed."
    exit 1
  fi

  if ! /usr/bin/curl -fsS "$CANDIDATE_HEALTH_URL" > "$CANDIDATE_HEALTH" 2>/dev/null; then
    echo "Candidate health failed after state migration. Current Runtime will be resumed."
    exit 1
  fi

  if ! "$NODE_BIN" -e '
    const fs=require("fs");
    const h=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const s=h?.runtime?.stateSchema;
    process.exit(
      s?.readable === true &&
      s?.migrationRequired === false &&
      s?.nativeSchema === true &&
      s?.schemaVersion === s?.currentSchemaVersion
        ? 0
        : 2
    );
  ' "$CANDIDATE_HEALTH"; then
    echo "Candidate state-schema migration did not verify. Current Runtime will be resumed."
    exit 1
  fi
else
  echo "Current Runtime drained. State schema already current."
fi

echo "Stopping candidate preflight before cutover..."
stop_candidate

echo "Switching production current symlink to:"
echo "  $RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
SWITCHED=true

CUTOVER_STARTED=true
if ! launchctl kickstart -k "gui/$UID/$LABEL"; then
  CUTOVER_STARTED=false
fi

NEW_HEALTH="$AGENTOS_HOME/last-health.json"
NEW_HEALTHY=false
if [[ "$CUTOVER_STARTED" == "true" ]]; then
for _ in {1..120}; do
  if /usr/bin/curl -fsS "$HEALTH_URL" > "$NEW_HEALTH" 2>/dev/null; then
    if "$NODE_BIN" -e '
      const fs=require("fs");
      const [file,version,state,release]=process.argv.slice(1);
      const h=JSON.parse(fs.readFileSync(file,"utf8"));
      const ok =
        h?.ok === true &&
        h?.version === version &&
        h?.runtime?.mode === "production" &&
        h?.runtime?.candidateMode === false &&
        h?.runtime?.stateRoot === state &&
        h?.runtime?.codeRoot === release &&
        h?.runtime?.lifecycle?.state === "running";
      process.exit(ok ? 0 : 2);
    ' "$NEW_HEALTH" "$VERSION" "$STATE_ROOT" "$RELEASE_DIR"; then
      NEW_HEALTHY=true
      break
    fi
  fi
  sleep 0.25
done
fi

if [[ "$NEW_HEALTHY" != "true" ]]; then
  echo "New Runtime failed post-cutover health verification. Rolling back..."
  PREVIOUS_VERSION="$(
    "$NODE_BIN" -e '
      const fs=require("fs");
      const path=require("path");
      const release=process.argv[1];
      const pkg=JSON.parse(fs.readFileSync(path.join(release,"package.json"),"utf8"));
      process.stdout.write(String(pkg.version || ""));
    ' "$PREVIOUS_RELEASE" 2>/dev/null || true
  )"

  ln -sfn "$PREVIOUS_RELEASE" "$CURRENT_LINK"
  launchctl kickstart -k "gui/$UID/$LABEL" >/dev/null 2>&1 || true

  ROLLBACK_HEALTHY=false
  for _ in {1..120}; do
    if /usr/bin/curl -fsS "$HEALTH_URL" > "$NEW_HEALTH" 2>/dev/null; then
      if "$NODE_BIN" -e '
        const fs=require("fs");
        const [file,version,state,release]=process.argv.slice(1);
        const h=JSON.parse(fs.readFileSync(file,"utf8"));
        const versionOk=!version || h?.version===version;
        const ok =
          h?.ok===true &&
          versionOk &&
          h?.runtime?.mode==="production" &&
          h?.runtime?.stateRoot===state &&
          h?.runtime?.codeRoot===release;
        process.exit(ok ? 0 : 2);
      ' "$NEW_HEALTH" "$PREVIOUS_VERSION" "$STATE_ROOT" "$PREVIOUS_RELEASE"; then
        ROLLBACK_HEALTHY=true
        break
      fi
    fi
    sleep 0.25
  done

  if [[ "$ROLLBACK_HEALTHY" != "true" ]]; then
    echo "Rollback failed health verification; stopping launchd service."
    launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
  else
    echo "Rollback health verified for previous release ${PREVIOUS_VERSION:-unknown}."
  fi
  exit 1
fi

OLD_DRAINED=false
echo "AgentOS Runtime graceful production upgrade completed."
echo "  version:   $VERSION"
echo "  release:   $RELEASE_DIR"
echo "  previous:  $PREVIOUS_RELEASE"
echo "  candidate: preflight passed on port $CANDIDATE_PORT"
echo "  drain:     completed"
echo "  health:    $HEALTH_URL"
cat "$NEW_HEALTH"
echo
