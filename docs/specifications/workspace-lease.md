# Workspace Lease Contract

Status: **v1 candidate**

A workspace lease protects long-lived write ownership over a canonical workspace.

## Ownership identities

Durable write ownership uses stable workflow identities:

```text
task:<taskId>
process:<processId>
transaction:<txId>
```

A raw MCP transport session is not a durable owner.

## Scope

- ordinary one-shot actions use Resource Arbiter locks only
- Persistent Tasks may hold Task-scoped leases
- managed write processes pin Process-scoped leases until exit
- Git transactions hold Transaction-scoped leases until complete/rollback
- explicit `runtime.workspace acquire` can be used for deliberate manual ownership

## Conflict rule

Workspace overlap is hierarchical. A parent and child workspace conflict for incompatible write ownership.

Sibling repositories do not conflict.

## Read behavior

A durable write lease protects mutation ownership; read-only inspection remains allowed unless a lower-level resource contract requires exclusivity.

## Wait and handoff

`runtime.workspace wait` waits for an overlapping owner to release without mutating ownership.

Normal takeover is explicit and two-sided:

```text
request_takeover → handoff(confirm=true) → takeover(confirm=true)
```

The handoff request persists the original lease ID and owner. The current owner must explicitly release that exact snapshot, and handoff is blocked while managed processes pin the lease. The requester then explicitly confirms acquisition.

There is no silent force-steal in the normal contract.

## Recovery

- expired unpinned leases are removed
- session-only leases from a previous Runtime instance are reclaimable
- Task/Process/Transaction ownership is not discarded merely because an MCP transport reconnects
- managed processes can be explicitly claimed after Runtime recovery or original transport disconnection

Verification: `npm run verify:concurrency` and `npm run verify:drain-handoff`.
