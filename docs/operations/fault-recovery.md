# Fault Recovery Matrix

AgentOS Runtime v0.9.15 hardens the Runtime around crash windows where a durable receipt and a side effect can become temporarily out of sync.

The governing pattern is:

```text
persist identity / intent
        ↓
perform side effect
        ↓
persist completion receipt
        ↓
cleanup
```

If the Runtime stops between those steps, retry must converge on the same durable identity instead of replaying a second logical operation.

## Test-only fault injection

Fault injection is enabled only when:

```text
AGENTOS_RUNTIME_MODE=test
```

and a named point is present in:

```text
AGENTOS_FAULT_INJECTION
```

Production ignores these injected faults.

## Filesystem mutation

Text writes and edits use a temporary file in the destination directory followed by an atomic replace.

Fault point:

```text
filesystem.after_temp_before_commit
```

Expected recovery:

- the original file remains intact
- the temporary file is removed
- retry writes the intended new content

## Scheduler wake

Each scheduled occurrence derives a deterministic Task id from:

- schedule id
- persisted occurrence time
- run count

The schedule persists `activeTaskId` before Task creation.

Fault point:

```text
scheduler.after_occurrence_receipt_before_task
```

After restart/retry, the same occurrence creates or resumes the same Task id instead of generating a second task.

## Persistent Loop phase

A loop phase occurrence derives a deterministic Task id from:

- loop id
- phase id
- transition count

The loop persists `activeTaskId` before Task creation.

Fault point:

```text
loop.after_phase_receipt_before_task
```

Retry converges on the same phase Task.

## Semantic promotion

M3 memory is written before the M2 task backlink is committed.

Fault point:

```text
semantic.after_memory_write_before_backlink
```

If the memory exists but the backlink is missing, retry recognizes the same task + candidate digest, returns the existing memory record, and repairs the provenance backlink.

A normal later duplicate with a different promotion candidate digest is still rejected.

## Workspace handoff

Handoff now has an explicit intermediate state:

```text
requested → releasing → released → completed
```

Important fault points:

```text
handoff.after_releasing_receipt_before_release
handoff.after_lease_release_before_released_receipt
handoff.after_takeover_lease_before_completed_receipt
```

Retry behavior:

- `releasing` + original lease present → finish release
- `releasing` + original lease absent → commit `released`
- requester lease already acquired → reuse the same lease and commit `completed`

The normal protocol never silently steals ownership.

## Git transaction

Transaction metadata is written atomically.

Completion commits its durable receipt before deleting the optional checkpoint reference.

Rollback commits its durable receipt before releasing workspace ownership.

Fault points include:

```text
git.transaction.after_complete_receipt_before_ref_cleanup
git.transaction.after_rollback_receipt_before_lease_release
```

Retry finishes cleanup and returns `recovered: true` instead of replaying the transaction.

## Managed process ownership

Managed process metadata persists outside the Runtime process. Reconciliation checks the operating-system process after Runtime recovery.

A disconnected transport may explicitly claim a recovered process. Workspace ownership remains `process:<processId>` until process exit.

Covered by:

```bash
npm run verify:concurrency
```

## Browser-agent sends

Browser session adapters persist `pendingSend` before an external send and a durable receipt after a confirmed send.

If the Runtime stops in the uncertain window, automatic replay freezes until the pending send is explicitly resolved.

Covered by:

```bash
npm run verify:session-adapters
```

## WeChat sends

The WeChat Session Adapter uses the same pending-send/receipt pattern.

This prevents an uncertain GUI send from being silently repeated after restart.

Covered by:

```bash
npm run verify:wechat-session
```

## State migration

Durable state migration uses an atomic manifest plus migration journal. An idempotent migration interrupted after its journal can be resumed.

Covered by:

```bash
npm run verify:state-schema
```

## MCP transport reconnect and workspace leases

A session-only workspace lease is not allowed to outlive a clearly disconnected MCP transport indefinitely.

Within the same Runtime, if:

- the owner session is explicitly disconnected
- there is no durable Task owner
- there are no pinned managed processes
- the reconnect grace period has elapsed

the lease is treated as orphaned and can be reclaimed.

Default grace:

```text
WORKSPACE_SESSION_RECLAIM_GRACE_MS=5000
```

This directly handles ChatGPT stream recovery cases where the transport session id changes but the Runtime itself did not restart.

## Verification

Focused crash-window verifier:

```bash
npm run verify:fault-recovery
```

Unified recovery release gate:

```bash
npm run verify:recovery-matrix
```

The aggregate gate runs:

- fault recovery
- concurrency/process recovery
- browser session pending-send recovery
- WeChat pending-send recovery
- durable state migration recovery
