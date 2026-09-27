# ADR-0007: Version Durable State Before Adding Incompatible Migrations

Status: Accepted

## Context

AgentOS Runtime persists Tasks, Scheduler state, Loops, Memory, Sessions, Process ownership, handoff receipts, and other Runtime data outside the immutable code release.

A code upgrade can therefore succeed while the durable state is incompatible with the new or previous release.

Without an explicit state schema, candidate health only proves that the process started. It does not provide a durable compatibility contract.

## Decision

Introduce a Runtime-level state schema manifest and migration registry.

Missing manifest is schema 0.

v0.9.14 defines schema 1 and an additive schema 0 → 1 bootstrap migration that creates only the manifest.

Migration is exposed through the governed L2 Skill `runtime.state`.

Automatic production migration is permitted only when every migration in the path is:

- auto-safe
- rollback-compatible
- idempotent where crash recovery may replay it

Migration requires the Runtime to be DRAINING and requires explicit confirmation.

A migration journal is written before the atomic manifest commit.

A Runtime refuses a state schema newer than it supports.

## Production upgrade ordering

The production coordinator follows:

```text
candidate preflight
→ old Runtime drain
→ old Runtime wait
→ candidate state migration
→ verify candidate state schema
→ cutover
→ verify production
```

The candidate never migrates state while the old Runtime is still accepting side effects.

## Why not migrate at startup

Automatic migration during ordinary startup would mix process boot with durable mutation and make rollback semantics ambiguous.

Startup may validate state compatibility, but migration is an explicit operation.

## Why schema 0 exists

Existing installations predate the manifest. Treating absence as a known legacy schema allows a controlled transition without rewriting existing data.

## Consequences

- upgrades can reason about durable state explicitly
- future schemas can fail closed instead of guessing
- code rollback safety becomes a declared migration property
- crash recovery has a durable journal boundary
- the Primitive ABI remains unchanged
- per-store schema ownership remains future work
