# OWL Runtime Provider Contract v1

Status: **Normative**.

OWL Runtime is the canonical provider of local execution semantics.

## Runtime owns

- Primitive and Skill execution semantics
- Task lifecycle
- managed Process lifecycle and ownership
- Runtime Schedule / Loop execution
- Workspace ownership / concurrency
- Observation / Verifier truth
- Approval execution semantics and one-time receipts
- Execution Health
- Diagnostics
- ExecutionTarget
- cancellation / recovery behavior
- local provider execution

## Runtime does not own

- MCP schema compatibility
- product UI
- Account / Organization
- Device registration / grant
- cloud command persistence
- billing/subscription
- Worker product state
- global platform integration orchestration

## Public consumption boundary

Consumers may use:

- published RuntimeClient/public package exports
- versioned Runtime HTTP API
- documented events/receipts/diagnostics

Consumers may not:

- import `src/**`
- edit Runtime state stores
- reimplement Runtime Task/Process/Scheduler/Verifier semantics
- assume transport session identity is durable ownership

## Cloud command relationship

A Cloud RemoteCommand is not a Runtime Task.

Runtime only becomes authoritative after a command is accepted into execution.

The accepting consumer records an explicit mapping:

```text
commandId → Runtime execution identity
```

## Approval relationship

Cloud/Worker may provide an ApprovalDecision.

Runtime remains responsible for deciding whether that evidence is sufficient to issue/consume an exact-action Approval Receipt.

## Compatibility

Within Runtime API v1:

- additive fields/operations may be added in compatible minor releases
- existing semantics cannot silently change
- breaking public contract requires a new major contract version

## Shared development protocol

All cross-repo implementation follows [OWL Cross-Repo Development Protocol v1](https://github.com/tubban1/owl-desktop/blob/main/docs/architecture/CROSS_REPO_DEVELOPMENT_PROTOCOL_V1.md).
