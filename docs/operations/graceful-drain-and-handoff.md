# Graceful Drain and Workspace Handoff

AgentOS Runtime v0.9.12 introduces a lifecycle state used to prepare the Runtime for maintenance, restart, and future blue-green upgrades.

## Runtime lifecycle

Current states:

```text
RUNNING
   ↓ runtime.control drain
DRAINING
   ↓ runtime.control resume
RUNNING
```

A future upgrade coordinator may add an explicit STOPPED/REPLACED terminal state, but v0.9.12 keeps process termination under the external supervisor.

## Drain behavior

While RUNNING, new side-effecting Actions, Skills, and Persistent Task runs are admitted normally.

When DRAINING:

- new side-effecting ad-hoc Actions are rejected with `RUNTIME_DRAINING`
- read-only Actions remain available
- new Persistent Task runs are rejected
- Scheduler ticks do not start new occurrences
- Loop Controller ticks do not start new phases
- Task runs that were already admitted may finish their current run
- cleanup/control operations remain available
- long-running write processes are reported as drain blockers

Use:

```text
runtime.control
  status
  drain
  wait
  resume
```

`wait` reports drained only after active mutation scopes have completed and no managed write process remains running.

## Workspace wait

`runtime.workspace wait` waits for an overlapping durable workspace lease to become available without stealing it.

This is useful when another Task, Process, Transaction, or explicit owner is still active.

## Explicit takeover protocol

Ownership transfer is deliberately multi-step:

```text
request_takeover
      ↓
durable request receipt
      ↓
handoff(confirm=true)
      ↓
original lease released
      ↓
takeover(confirm=true)
      ↓
new lease acquired
```

A takeover request does not mutate ownership.

`handoff` validates that the lease ID and owner still match the snapshot captured by the request. If ownership changed meanwhile, the handoff fails instead of releasing a different owner's lease.

A lease with pinned managed processes cannot be handed off.

Both handoff and takeover require `confirm=true`.

## Why takeover is not automatic

AgentOS intentionally does not implement silent force-steal as the normal path.

A competing agent must either:

- wait for release,
- request takeover and obtain explicit handoff,
- or use an administrative force-release only after independent verification that the owner is stale.

This makes cross-Chat interference visible and auditable.

## Recovery

Handoff requests are durable under the Runtime state root in:

```text
workspace-handoffs/
```

The request record stores the source lease ID/owner snapshot, requester session, purpose, status, and completion receipt.

## Verification

Run:

```bash
npm run verify:drain-handoff
```

The verifier covers drain admission, read access, Task/Scheduler/Loop pausing, wait semantics, explicit handoff, and rejection of unconfirmed takeover.
