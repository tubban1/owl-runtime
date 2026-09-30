# Runtime Daemon and MCP Adapter Boundary

Status: **normative during the OWL split**.

OWL Runtime production is now a standalone local daemon. It does not require the MCP adapter to start, upgrade, drain, migrate state, or serve its public API.

## Production topology

```text
computer-mcp                     owl-worker
    │                                │
    └──────── RuntimeClient ─────────┘
                  │
             loopback HTTP
                  │
        ┌─────────▼─────────┐
        │   OWL Runtime     │
        │ production daemon │
        ├───────────────────┤
        │ /runtime/v0.1/*   │
        │ /health           │
        └───────────────────┘
```

The production entrypoint is `dist/server.js`, which maps to the standalone Runtime daemon.

The transitional in-repo MCP adapter is a separate entrypoint: `dist/mcp-server.js`. It is retained temporarily for compatibility/conformance work while `computer-mcp` becomes the official MCP product.

## Scripts

- `npm run dev` — standalone Runtime daemon
- `npm start` — compiled production Runtime daemon
- `npm run dev:mcp` — transitional MCP adapter
- `npm run start:mcp` — compiled transitional MCP adapter

## Production lifecycle

Install, health, candidate preflight, drain, wait, state migration, resume, cutover, and rollback operate through the standalone daemon/public Runtime API.

Production upgrade control no longer depends on `/mcp`.

The production verifier asserts that `/mcp` returns 404 on the standalone daemon.

## Authentication

Production public API calls require `OWL_RUNTIME_API_TOKEN`.

The installer generates a token into the production environment file when one is absent. Upgrade control/state clients read and pass that token explicitly.

The token is a local Runtime API credential; it is not an MCP session identity and not a process-control capability.

## Identity layers

Keep these distinct:

```text
MCP transport session      ephemeral protocol connection
OWL logical session        durable consumer ownership identity
Runtime request id         one cancellable request
process control capability process-scoped reconnect authority
task id                    durable task ownership identity
```

Conflating these identities caused real dogfood failures and is prohibited by the public boundary.

## Migration consequence

`computer-mcp` should not wait for removal of the transitional adapter. It should consume the standalone Runtime daemon through its RuntimeClient adapter and migrate capabilities incrementally.

`owl-worker` may use MockRuntimeClient now and Local/HttpRuntimeClient selectively as contracts become ready.
