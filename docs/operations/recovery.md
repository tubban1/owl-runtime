# Recovery

Recovery policy depends on the side effect being protected.

## Runtime restart

Durable Tasks, schedules, loops, process metadata, session bindings, memory, and workspace ownership live outside the process lifetime.

Managed processes are reconciled against the OS after restart.

## Uncertain external sends

Browser-agent and WeChat adapters persist `pendingSend` before the external side effect. If the Runtime crashes after a possible send but before the receipt is committed, automatic replay freezes until the pending state is explicitly resolved.

## Workspace ownership

Session-only orphan leases from an older Runtime instance can be reclaimed when they have no Task owner and no pinned process. v0.9.15 also reclaims a session-only lease inside the same Runtime after the owning MCP transport is explicitly disconnected, the short reconnect grace period has elapsed, and no durable Task/process pin exists.

Task/Process/Transaction ownership survives transport reconnects.

## Git transactions

Transactions create checkpoints and can be completed or rolled back across MCP transport reconnects.

## Production release failure

Production installation health-checks the new immutable release. If it fails, the installer switches back to the previous release and verifies rollback health.

Persistent state is not automatically rolled back with code.

## Fault recovery matrix

v0.9.15 adds deterministic test-only fault injection and replay-safe recovery across filesystem mutation, scheduler/loop occurrence creation, semantic promotion, workspace handoff, and Git transaction cleanup.

Existing managed-process, browser-session, WeChat-session, and durable-state migration recovery verifiers are combined with those crash-window tests by:

```bash
npm run verify:recovery-matrix
```

See [Fault recovery matrix](fault-recovery.md).
