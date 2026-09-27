# Concurrency and Workspace Ownership

AgentOS Runtime v0.9.11 separates **short-lived action concurrency** from **durable workflow ownership**.

This matters because an MCP transport session is not a reliable long-lived identity for one logical ChatGPT conversation. A client may reconnect, rotate MCP session IDs, or restart the Runtime while the user still considers the work to be one continuous task.

## Ownership model

```text
ordinary action
  └─ action-scoped Resource Arbiter lock
     └─ released when the action returns

Persistent Task
  └─ task:<taskId> workspace lease
     └─ survives MCP transport changes

Managed process
  └─ process:<processId> workspace lease
     └─ pinned while the OS process is alive

Git transaction
  └─ transaction:<txId> workspace lease
     └─ held until complete/rollback
```

Raw MCP session IDs remain useful for audit and immediate process control, but they are not the durable identity of a multi-step workflow.

## Action-scoped locks

Every routed filesystem, Git, shell, or transaction action resolves the canonical workspace it touches and contributes a workspace resource to the Resource Arbiter.

- read actions request a shared workspace resource
- write actions request an exclusive workspace resource
- unrelated sibling repositories can run concurrently
- parent/child workspaces conflict hierarchically

For example, an exclusive action on:

```text
/Projects/world2_v3
```

conflicts with another action that resolves to the same repository or an overlapping parent/child workspace, but it does not serialize work in:

```text
/Projects/computer-mcp
```

This prevents the former loophole where a shell command launched from a broad parent directory could mutate a child repository while another agent owned that child repository.

## Durable workspace leases

Durable leases are stored under the Runtime state root in `workspace-leases/`.

They are intentionally used only when the work itself outlives one MCP tool call:

- Persistent Tasks
- managed long-running processes
- Git transactions
- explicit `runtime.workspace acquire`

Ordinary ad-hoc writes do **not** leave a 30-minute transport-session lease behind.

This is important because transport sessions can rotate even inside one visible ChatGPT conversation.

## Parent/child conflicts

Workspace conflicts are hierarchical.

```text
/Projects
/Projects/world2_v3
```

cannot both hold incompatible write ownership at the same time. The same hierarchy is enforced by the in-memory Resource Arbiter for live actions and by the durable lease layer for long-running ownership.

## Process ownership

`shell.start` creates a durable managed-process record and, for write-mode processes, a process-scoped workspace lease.

The process record includes:

- process ID and PID
- canonical workspace
- owner MCP session for immediate control/audit
- optional owning Task
- stdout/stderr log paths
- recovery state after Runtime restart

A process lease remains pinned while the OS process is alive. When the final process pin is removed, a process-scoped lease is released immediately.

If the Runtime restarts while the child process survives, the process is reconciled as recovered. A new session can explicitly claim it. Claim is also allowed when the original MCP transport session is known to have disconnected.

There is no silent takeover of a live process owned by another active session.

## Git transaction ownership

A transaction receives a stable owner:

```text
transaction:<txId>
```

rather than relying on the MCP transport session that happened to create it.

That allows a later transport session to complete or roll back the same transaction without losing workspace ownership. The lease is released when the transaction becomes terminal.

## Orphan lease reclamation

Session-only leases from a previous Runtime instance are reclaimable when they have:

- no durable Task owner
- no pinned managed process

This prevents a Runtime restart from leaving an otherwise idle repository blocked until TTL expiry.

Task-, process-, and transaction-owned leases are not treated as disposable session orphans.

## Production self-protection

When `AGENTOS_RUNTIME_MODE=production`, the Runtime refuses writes to its own active code workspace by default:

```text
RUNTIME_SELF_IMMUTABLE
```

Production upgrades should build and install a new immutable release, switch the release symlink, health-check it, and roll back if necessary.

`ALLOW_RUNTIME_SELF_MUTATION=true` is an explicit escape hatch and should not be part of normal production operation.

## Verification

Run:

```bash
npm run verify:concurrency
```

The verifier covers:

- ad-hoc writes are action-scoped
- sibling workspaces run concurrently
- parent/child action locks conflict
- Task ownership survives transport changes
- process-scoped workspace ownership
- disconnected-process claim
- process exit releases its lease
- orphan session lease reclamation
- transaction ownership survives transport changes
- multiple edits to the same file compose in order
- production Runtime self-mutation is blocked


## Transport-session churn and interactive leases

A visible ChatGPT conversation may survive while its underlying MCP transport session rotates because of reconnects, stream recovery, or client-side network faults.

That has an important consequence:

- a raw `session:<mcp-session-id>` is suitable for short-lived audit/control attribution
- it is **not** a stable durable identity for a long interactive workflow

For this reason, AgentOS prefers Task-, Process-, and Transaction-scoped ownership for work that spans multiple tool calls.

Session-only leases support two recovery paths when they have no Task owner and no pinned process:

1. reclaim after the Runtime knows the owning MCP session disconnected
2. conservative reclaim after the owning session remains active-but-idle beyond the configured timeout

The same-Runtime idle timeout defaults to 15 minutes and can be configured with:

```text
WORKSPACE_SESSION_IDLE_RECLAIM_MS
```

This timeout is intentionally conservative. It is a safety valve for stale transport state, not a substitute for durable Task ownership.

A stream-recovery incident should therefore not be solved by silently stealing a Task/Process/Transaction lease. Only disposable session-only ownership is eligible for idle reclamation.
