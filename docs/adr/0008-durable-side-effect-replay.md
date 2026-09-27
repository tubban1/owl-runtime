# ADR-0008: Persist Intent Before Side Effects and Make Recovery Replay-Safe

Status: Accepted

## Context

A durable agent can crash between any two writes.

The dangerous windows are not limited to process crashes. They include:

- a scheduler recording a wake but not yet creating its Task
- a Task or adapter performing a side effect before writing its receipt
- a semantic memory write completing before provenance is linked
- a workspace lease being released before handoff state is advanced
- a Git transaction being marked complete before cleanup finishes

Retries that generate a fresh identity can duplicate work.

## Decision

For recoverable operations, persist a deterministic identity or durable intent receipt before the side effect whenever possible.

On retry:

- reuse the same Task, lease, memory, transaction, or occurrence identity
- treat already committed side effects as reconciliation work
- separate completion receipts from best-effort cleanup
- freeze replay when an external side effect is genuinely uncertain and cannot be proven idempotent

Fault injection is available only in test Runtime mode so these boundaries can be exercised deterministically.

## External-world exception

Exactly-once delivery cannot be assumed for arbitrary browser or GUI messaging.

For those adapters, AgentOS persists `pendingSend` before the possible external send. If the Runtime cannot prove whether the send committed, it stops automatic replay and requires explicit resolution.

## Alternatives

- retry everything from the beginning
- rely only on in-memory mutexes
- generate new Tasks after every restart
- treat duplicate external sends as acceptable
- make every recovery path operator-only

## Consequences

- internal durable workflows converge after restart
- duplicate scheduler/loop Tasks are avoided
- semantic promotion can repair incomplete provenance
- workspace handoff and Git cleanup are replay-safe
- truly uncertain external messages remain conservative rather than falsely claiming exactly-once semantics
