# Production Runtime

OWL Runtime separates the **development source tree** from the **production Runtime**.

Production runs compiled JavaScript from an immutable release directory. It never runs a source watcher.

## Runtime modes and state roots

Default state roots are mode-specific:

```text
development -> ~/.owl-runtime-dev
production  -> ~/.owl-runtime
test        -> ~/.owl-runtime-test
```

`OWL_STATE_ROOT` is the canonical explicit override. Legacy `AGENTOS_STATE_ROOT` remains a compatibility fallback.

This prevents development verifiers, source restarts, and experimental tasks from silently sharing production Scheduler, Loop, Task, Process, Session, or Memory state.

## Production layout

```text
~/Applications/
  OWL Runtime.app/                # stable permission-bearing native host

~/.owl/
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

~/.owl-runtime/                   # persistent Runtime state
```

The stable Runtime Host and persistent Runtime state both live outside versioned code releases.

This gives OWL Runtime three independent lifecycles:

```text
native permission host
        ≠
versioned Runtime code
        ≠
persistent Runtime state
```

## Stable macOS Runtime Host

The production host is:

```text
~/Applications/OWL Runtime.app
Contents/MacOS/OwlRuntimeHost
bundle id: fan.fde.owl.runtime
```

It is intentionally not rebuilt or replaced during ordinary Runtime promotions. That keeps macOS Full Disk Access attached to a stable executable identity rather than a versioned Node/JavaScript release path.

Install the host once:

```bash
npm run install:runtime-host
```

If the exact same host source is already installed, the installer preserves the existing binary unchanged. Native host replacement requires an explicit reviewed host update.

See [Permissions](../security/permissions.md).

## Install or upgrade

Production release operations refuse tracked dirty source by default.

For the first production installation:

```bash
npm run install:production
```

The install path:

1. ensures the stable OWL Runtime Host is installed;
2. builds `dist/`;
3. creates an immutable release directory;
4. installs production dependencies into that release;
5. atomically updates `~/.owl/current`;
6. installs/reloads `com.owl.runtime`;
7. launchd starts the fixed Runtime Host, which supervises Node running `current/dist/server.js`;
8. `/health` must report the expected version, production mode, and state root;
9. if startup health fails and a previous release exists, code selection is rolled back.

For an existing Runtime that supports graceful drain:

```bash
npm run upgrade:production
```

The upgrade path requires the stable Runtime Host to already exist. A normal server upgrade never replaces the host.

See [Production upgrades](production-upgrades.md).

## Production execution chain

```text
launchd
  ↓
~/Applications/OWL Runtime.app/Contents/MacOS/OwlRuntimeHost
  ↓
Node
  ↓
~/.owl/current/dist/server.js
```

A versioned release may change while the native permission identity remains constant.

## Environment

Production environment is stored at:

```text
~/.owl/runtime.env
```

The installer sets:

```text
OWL_RUNTIME_MODE=production
OWL_STATE_ROOT=~/.owl-runtime
```

unless explicit production overrides are configured.

Keep capability flags and `ALLOWED_DIRECTORIES` in the production environment file.

## Status

Use:

```bash
npm run status:production
```

A healthy production response must report the selected release version, `runtime.mode = production`, and the expected state root.

## Rollback

Code rollback switches `~/.owl/current` back to the previous immutable release and restarts the service. Persistent state is not automatically rolled back.

```text
code rollback != state rollback
```

If a migration changes durable state incompatibly, it must define its own compatibility policy.

The stable Runtime Host is not rolled back during an ordinary code rollback because it has an independent lifecycle.

## Runtime self-mutation

Production Runtime code is immutable from the Runtime's own filesystem/Git/shell write surfaces by default.

Upgrade by creating and validating a new immutable release; never edit the active release in place.

## Uninstall

Use:

```bash
npm run uninstall:production
```

The production service can be removed while preserving releases, environment, logs, and persistent state for recovery. The stable Runtime Host should be treated separately because removing/replacing it may affect macOS permission grants.

## Verification

Run:

```bash
npm run verify:runtime-host
npm run verify:production-runtime
npm run verify:upgrade-runtime
```

The release candidate gate additionally validates the native host source/fingerprint contract and shell syntax.
