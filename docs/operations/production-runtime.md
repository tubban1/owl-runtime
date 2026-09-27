# Production Runtime

AgentOS Runtime separates the **development source tree** from the **production Runtime**.

The production service runs compiled JavaScript from an immutable release directory. It does not run `tsx watch src/server.ts`.

## Runtime modes and state roots

Default state roots are mode-specific:

```text
development -> ~/.computer-mcp-dev
production  -> ~/.computer-mcp
test        -> ~/.computer-mcp-test
```

`AGENTOS_STATE_ROOT` can explicitly override the default.

This prevents development verifiers, source restarts, and experimental tasks from silently sharing production scheduler, loop, task, process, session, and memory state.

## Production layout

The installer uses:

```text
~/.agentos/
  current -> releases/<version>-<git-sha>/
  releases/
    <version>-<git-sha>/
      dist/
      node_modules/
      package.json
      package-lock.json
      run.sh
  runtime.env
  logs/
```

Persistent Runtime state remains outside the release tree:

```text
~/.computer-mcp/
```

This lets code releases be replaced or rolled back without replacing memory, scheduler, tasks, process records, or other persistent Runtime state.

## Install or upgrade

Production release operations refuse tracked dirty source by default.

For the **first** production installation:

```bash
npm run install:production
```

For an existing Runtime that supports graceful drain:

```bash
npm run upgrade:production
```

See [Production upgrades](production-upgrades.md) for candidate preflight, drain, cutover, and rollback semantics.

A recommended release flow is:

```bash
npm run typecheck
npm run verify:concurrency
npm run verify:drain-handoff
npm run verify:state-schema
npm run verify:upgrade-runtime
npm run verify:production-runtime
git status
git commit
git push
npm run upgrade:production
```

The first-install path:

1. builds `dist/`
2. creates a new release directory
3. installs production dependencies into that release
4. atomically updates `~/.agentos/current`
5. installs/reloads the macOS LaunchAgent
6. starts the Runtime in `AGENTOS_RUNTIME_MODE=production`
7. checks `/health` for the expected version, production mode, and state root
8. restores the previous release if the new release fails health verification

The production entry point is:

```text
node <release>/dist/server.js
```

not a source watcher. Production normally owns port `8787`; source development defaults to `8788`.

## Environment

Production environment is stored at:

```text
~/.agentos/runtime.env
```

The first install copies the project `.env` when available; otherwise it creates a minimal environment file.

Keep capability flags and `ALLOWED_DIRECTORIES` there.

The installer explicitly sets:

```text
AGENTOS_RUNTIME_MODE=production
AGENTOS_STATE_ROOT=~/.computer-mcp
```

unless a production state-root override is supplied.

## Status

Use:

```bash
npm run status:production
```

It reports:

- the current release symlink
- LaunchAgent status
- the production environment file
- `/health`

A healthy production response should report:

```json
{
  "ok": true,
  "version": "0.9.16",
  "runtime": {
    "mode": "production"
  }
}
```

## Rollback

Install-time rollback is automatic when the newly selected release fails health verification and a previous release exists.

The rollback switches `~/.agentos/current` back to the previous immutable release and restarts the LaunchAgent. Persistent state is not rolled back.

That distinction is intentional:

```text
code rollback != state rollback
```

If a migration ever changes durable state incompatibly, it must define its own forward/backward compatibility policy rather than relying on a code symlink rollback.

## Runtime self-mutation

Production Runtime code is immutable from the Runtime's own filesystem/Git/shell write surfaces by default.

This prevents a production Jarvis instance from rewriting the same release that is currently executing.

Upgrade by creating a new immutable release. For an existing graceful-drain capable Runtime, prefer `npm run upgrade:production`.

## Uninstall

Use:

```bash
npm run uninstall:production
```

This removes the LaunchAgent but intentionally preserves:

- releases
- `runtime.env`
- logs
- persistent Runtime state

That makes reinstall/recovery possible without deleting memory or durable workflows.

## Verification

Run:

```bash
npm run verify:production-runtime
npm run verify:upgrade-runtime
```

The verifier builds the project, starts `dist/server.js` on an isolated port/state root, and asserts:

- production mode
- isolated state root
- expected current release health version
- session-aware concurrency capabilities
- workspace leases
- persistent process ownership
- production self-protection
- no source watcher
