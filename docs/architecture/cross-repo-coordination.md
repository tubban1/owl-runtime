# Cross-Repo Coordination

Status: **normative during the OWL split**.

This document defines how `owl-runtime`, `computer-mcp`, and `owl-worker` develop in parallel without duplicating Runtime behavior.

## Dependency direction

```text
computer-mcp ─┐
              ├──> OWL Runtime public contract
owl-worker  ──┘

OWL Runtime -X-> computer-mcp product code
OWL Runtime -X-> owl-worker product code
```

OWL Runtime is the only source of truth for generic execution behavior:
Primitive/Skill execution, persistent tasks, scheduler, processes, workspace ownership, providers, Observation, Verifier, policy/approval, health, state/recovery, memory/staging, and later sandbox/execution targets.

## What can proceed in parallel now

### computer-mcp does NOT need to wait for Runtime 1.0

It may immediately:
- stabilize MCP transport/session identity;
- fix cancellation/orphan-process behavior;
- build a `RuntimeClient` boundary;
- keep a temporary legacy backend for personal-use stability;
- write compatibility/conformance tests;
- migrate one capability at a time after that Runtime contract passes its gate.

It must NOT:
- copy new Runtime implementations into computer-mcp;
- import `owl-runtime/src/**` internals;
- silently switch to OWL Runtime without compatibility evidence;
- block personal daily use on unfinished Runtime features.

### owl-worker does NOT need to wait for Runtime 1.0

It may immediately build with a MockRuntimeClient:
- My Workers;
- Create Worker;
- Test Run;
- Confirm/Activate;
- Schedule;
- Run History;
- Approval;
- Health/Needs Attention;
- Notifications/templates/billing/product UX.

It must NOT:
- implement its own scheduler/process manager/verifier/approval engine;
- import Runtime internals;
- invent a second persistent task model merely to unblock UI work.

When a backend capability is missing, create a **Contract Request** instead.

## What MUST wait for Runtime contract readiness

A consumer may switch from mock/legacy behavior to OWL Runtime only when the specific capability has:

1. a public RuntimeClient method or equivalent versioned public contract;
2. conformance tests;
3. restart/recovery semantics where relevant;
4. cancellation/ownership behavior where relevant;
5. compatibility evidence for computer-mcp migrations;
6. no dependency on Runtime private source paths.

This is per-capability, not all-or-nothing. `fs.read` may migrate before browser automation; approvals may integrate before sandbox.

## Public API migration gate

```text
INTERNAL
  implementation exists only inside Runtime
        ↓
CANDIDATE
  public contract + conformance test
        ↓
READY_FOR_CONSUMERS
  recovery/compatibility evidence complete
        ↓
MIGRATED
  computer-mcp/Worker uses Runtime contract
        ↓
LEGACY_REMOVED
  duplicate consumer implementation deleted
```

Do not delete the computer-mcp legacy path before the migrated capability has proven stable in real personal use.

## Contract Request format

Consumers should add requests in their own repo and communicate the same payload to the Runtime session:

```text
CONTRACT REQUEST
Consumer: computer-mcp | owl-worker
Capability: runtime.schedule.pause
Why: Worker Detail needs a Pause action.
Blocking: No | Yes
Temporary path: MockRuntimeClient | legacy backend | UI disabled
Required semantics:
- idempotent pause
- durable across restart
- returns updated schedule state
Acceptance:
- conformance test
- restart test
- no duplicate scheduled execution
```

A Contract Request is not permission to implement the missing Runtime behavior in the consumer repo.

## Current public boundary

OWL Runtime now defines `RuntimeClient` v0.1 under `src/public/`.

Initial surface:
- capabilities;
- Primitive catalog/call;
- Skill catalog/run;
- Persistent Task create/list/get/run/pause/cancel/resolve/delete;
- Schedule create/list/get/cancel/delete;
- Approval list/get/approve/deny;
- Process operations;
- Health operations.

The in-process implementation is the reference implementation. IPC/HTTP/native transports must preserve the same semantics.

## Current known dogfood P0 issues

Real use of computer-mcp exposed these issues and they are release blockers for heavy multi-session use:
- MCP transport/session identity can change between calls;
- a process can become uncontrollable because ownership is tied too tightly to transport session identity;
- long-running process default write lease can block unrelated work in the same repo;
- transport timeout/cancellation can leave the underlying process alive;
- orphan reclaim semantics are too strict for reconnect/recovery cases;
- desktop provider can be technically available while Accessibility/Screen Recording permissions are missing.

These belong in Runtime/computer-mcp boundary work, not Worker UI work.

## Session ownership

During parallel development:
- Runtime Session edits `owl-runtime`;
- computer-mcp Session edits `computer-mcp`;
- Worker Session edits `owl-worker`.

Cross-repo edits should normally be documentation-only unless explicitly coordinated.

## Integration cadence

Do not wait for a large merge window.

Preferred cadence:
1. Runtime publishes/stabilizes one contract.
2. Consumer adds a conformance adapter.
3. Consumer dogfoods it.
4. If stable, consumer switches that capability.
5. Duplicate legacy implementation is removed only afterward.

This is a strangler migration, not a big-bang rewrite.
