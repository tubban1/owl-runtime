# Detached Task Progress v1

Status: **1.x candidate / integration baseline**

## Why

Long Runtime work must not depend on one ChatGPT, MCP, HTTP, tunnel, or browser request staying open. An interactive frontend may time out while canonical work is still healthy. OWL therefore separates **execution lifetime** from **transport lifetime**.

This contract does not create fake heartbeat work. User-facing progress must always be derived from canonical Runtime Task state.

## Public contract

### Start detached work

`tasks.start` and MCP `task_start` start or resume one existing durable Task and return an acceptance receipt promptly.

The receipt contains:

- Task ID;
- accepted / already-running / already-completed state;
- acceptance timestamp;
- current Task status;
- current progress projection.

Existing `tasks.run` / `task_run` remains the synchronous compatibility path.

### Observe progress

`tasks.get` and MCP `task_status` expose `progress`:

- monotonic `revision`, advanced by real Task lifecycle events;
- `phase` and `terminal`;
- bounded step counts;
- active step IDs/actions and elapsed active time;
- latest meaningful privacy-bounded event;
- latest meaningful timestamp;
- recommended polling interval.

Elapsed active time may change without a new revision. That is a truthful projection of one still-running step, not evidence that new work occurred.

## Agent/frontend behavior

For long interactive work, an agent should:

1. create the durable Task;
2. call `task_start`;
3. return to normal tool orchestration immediately;
4. poll `task_status` at a bounded cadence;
5. before its own frontend/gateway idle deadline, surface a concise update based on the latest real progress projection;
6. continue polling until terminal state, approval/review boundary, cancellation, or an explicit user stop.

The agent must not claim completion until canonical Task state is terminal.

## Disconnect and retry

A ChatGPT/MCP/HTTP disconnect does not cancel detached Runtime work after `task_start` has accepted it.

Repeating `task_start` while the same Task is already active reports `alreadyRunning=true`; it does not launch a competing run.

Runtime restart remains governed by the existing persistent Task recovery policy. Interrupted steps are recovered according to their retry and side-effect semantics.

## Event-journal boundary

Detached Task progress is **not** inserted into Public Event Journal v1.

The v1 journal currently provides one globally ordered AgentRequest channel. Existing filtered AgentRequest consumers require contiguous global sequence/cursor semantics; adding unrelated Task progress records to that sequence would create apparent gaps.

A future observability stream or native MCP progress notification may provide push delivery, but push is an optimization. Durable Task state remains the correctness boundary.

## Privacy and boundedness

Progress projections must not contain:

- credentials or secrets;
- raw prompt/message bodies;
- unbounded stdout/stderr;
- private staging paths that are not part of the public contract.

## Verification

The integration gate must prove:

- detached acceptance returns before a synthetic slow Task completes;
- duplicate start is deduplicated at Task lifecycle level;
- active step progress is observable;
- progress revision is monotonic;
- the Task reaches its canonical terminal state;
- HTTP RuntimeClient exposes the same contract;
- existing public DTO, request replay, and AgentRequest event behavior remain compatible.
