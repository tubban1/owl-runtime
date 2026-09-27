# Repository Boundaries

Status: normative for the OWL extraction.

## Repositories

### `owl-runtime`
Open source. Source of truth for reliable execution. It owns Primitive and Skill contracts, persistent tasks, scheduler/trigger runtime, concurrency and resource ownership, observation/verification contracts, policy enforcement, traces, secrets interfaces, health, sandbox interfaces, providers, recovery, migrations, and production lifecycle.

### `computer-mcp`
Compatibility product. It should become a thin MCP-facing facade that translates MCP requests to OWL Runtime. It may keep compatibility aliases and historical tool schemas, but must not maintain a second implementation of Runtime behavior.

### `owl-worker`
Commercial product. It owns end-user UX such as My Workers, Create Worker, Test Run, approvals, run history, templates, notifications, billing/licensing, setup service, and later enterprise control features. It consumes OWL Runtime through a stable local API/SDK/IPC boundary.

## Dependency direction

```text
computer-mcp ─┐
              ├──> OWL Runtime
owl-worker  ──┘

OWL Runtime -X-> owl-worker
OWL Runtime -X-> computer-mcp product UI
```

Runtime must not depend on a specific LLM planner. Planner/model choice belongs above the runtime boundary. MCP is one transport/adapter, not the internal architecture.

## Extraction rules

1. Preserve behavior before adding new capability.
2. Preserve Git history and durable-state compatibility where practical.
3. New OWL names are canonical; legacy `AGENTOS_*` configuration remains a compatibility fallback during migration.
4. Keep app-specific integrations behind adapters/providers.
5. Do not duplicate Runtime source into Worker or computer-mcp.
6. Runtime 1.0 is gated by ABI compatibility, recovery, production lifecycle, and soak evidence rather than tool count.

## Near-term sequence

1. Complete repository extraction and compatibility boundary.
2. Add Observation ABI.
3. Add Verifier contract and evidence model.
4. Harden managed-process state machine.
5. Add policy/approval receipts and Worker health model.
6. Build the first self-service `owl-worker` flow: Create → Test → Confirm → Schedule → History.
