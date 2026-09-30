# Configuration

AgentOS Runtime reads environment variables from the process environment. Production installation stores them in:

```text
~/.agentos/runtime.env
```

Development normally uses the project `.env` and defaults to port `8788`, keeping it separate from the production service on `8787`.

## Runtime mode

```text
AGENTOS_RUNTIME_MODE=development|production|test
AGENTOS_STATE_ROOT=/custom/path
```

Default state roots:

```text
development -> ~/.computer-mcp-dev
production  -> ~/.computer-mcp
test        -> ~/.computer-mcp-test
```

## Core capability gates

Common gates include filesystem scope, shell, browser, GUI, Git push, rollback, and delete permissions. Keep `ALLOWED_DIRECTORIES` as narrow as practical.

## Identity

```text
AGENTOS_NAME=AgentOS Runtime
AGENTOS_WAKE_NAME=Jarvis
AGENTOS_ALIASES=AgentOS,OWL,Jarvis
```

## Browser startup

Chrome startup can vary significantly by macOS/Chrome version and machine load. The Runtime waits up to 60 seconds for the local DevTools endpoint by default. Override with:

```text
BROWSER_STARTUP_TIMEOUT_MS=60000
BROWSER_CONNECT_TIMEOUT_MS=30000
```

The startup timeout covers waiting for Chrome's local DevTools endpoint. The connect timeout covers Playwright's subsequent CDP/WebSocket handshake. Both values are bounded between 5 and 120 seconds.

## Embeddings

See [Embedding Provider Contract](../specifications/embedding-provider.md). Remote endpoints require explicit remote opt-in.

## Production

Do not run production through `tsx watch`. Use [Production Runtime](production-runtime.md).

For an existing v0.9.12+ production installation, use the [Production upgrade protocol](production-upgrades.md). The coordinator defaults to a 120-second graceful drain timeout; override it with `AGENTOS_UPGRADE_DRAIN_TIMEOUT_MS` when long-running write processes legitimately need more time. v0.9.14+ also validates the [Runtime Durable State Schema](../specifications/state-schema.md) before cutover.


## Workspace session-lease recovery

MCP transport sessions are not durable workflow identities. Session-only workspace leases can be reclaimed when the Runtime **knows the owning transport disconnected**, or when a lease belongs to a previous Runtime instance.

Default disconnect grace:

```text
WORKSPACE_SESSION_RECLAIM_GRACE_MS=5000
```

OWL Runtime 1.0 deliberately does **not** reclaim a still-connected session's write lease merely because the session has been idle. Idle time is not proof that write ownership ended, and stealing a live lease can permit concurrent writers.

The legacy `WORKSPACE_SESSION_IDLE_RECLAIM_MS` setting is no longer used for lease reclamation.

For work that spans many tool calls, prefer durable Task/Process/Transaction ownership. Explicit session leases end by release, handoff, their own TTL, known disconnect, or Runtime-instance replacement.
