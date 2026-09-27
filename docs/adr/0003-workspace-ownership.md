# ADR-0003: Durable Ownership Is Task/Process/Transaction Scoped

Status: Accepted

## Context

MCP transport session IDs can rotate while a visible ChatGPT conversation continues. Action-only locks also fail to protect multi-step work and long-running processes.

## Decision

Use short-lived Resource Arbiter locks for ordinary actions and stable durable ownership identities for long-lived work:

- `task:<taskId>`
- `process:<processId>`
- `transaction:<txId>`

Workspace conflicts are hierarchical.

## Alternatives

- treat MCP session ID as the durable owner
- use only per-action mutexes
- use one global shell/repository mutex

## Consequences

- transport reconnects do not invalidate durable work
- unrelated repositories can execute concurrently
- competing mutation of the same repository is visible and governable
- wait/takeover/handoff can be built as explicit Runtime protocols
