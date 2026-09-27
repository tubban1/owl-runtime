# OWL Runtime Public API v0.1

Status: **candidate public contract**.

The purpose of this API is to let `computer-mcp`, `owl-worker`, CLI tools, and future transports consume OWL Runtime without importing Runtime internals.

## Rule

Consumers depend on:

```text
RuntimeClient
```

Consumers must not depend on:

```text
src/runtime/**
src/router/**
src/providers/**
src/tasks/**
src/skills/**
```

The reference implementation is `InProcessRuntimeClient`. IPC/HTTP/native implementations must preserve the same semantics.

## Surface

### Discovery
- `info()`
- `getCapabilities(goal?)`
- `getExecutionTargets()`
- `getPrimitiveCatalog()`
- `getSkillCatalog()`

### Execution
- `callPrimitive(...)`
- `runSkill(...)`

### Persistent Tasks
- `createTask(...)`
- `listTasks()`
- `getTask(...)`
- `runTask(...)`
- `pauseTask(...)`
- `cancelTask(...)`
- `resolveTaskStep(...)`
- `deleteTask(...)`

### Scheduler
- `createSchedule(...)`
- `listSchedules()`
- `getSchedule(...)`
- `cancelSchedule(...)`
- `deleteSchedule(...)`

### Approval
- `listApprovals(...)`
- `getApproval(...)`
- `approve(...)`
- `deny(...)`

### Runtime state
- `process(...)`
- `health(...)`

## Public input contracts

Task, schedule, verification, approval-state, health, and process request types are declared under `src/public/runtimeClient.ts`.

The generated package declaration must remain self-contained. It must not reference private Runtime source paths.

## Readiness

The v0.1 interface is **candidate**, not a claim that every capability is ready to migrate from computer-mcp.

Use the per-capability migration gate:

1. contract exists;
2. conformance test passes;
3. recovery/cancellation semantics are known where relevant;
4. consumer compatibility test passes;
5. dogfood evidence exists;
6. only then switch the consumer backend.

Current guidance:

| Area | Contract | Consumer migration |
|---|---|---|
| capability discovery | candidate | can integrate |
| Primitive call | candidate | read-only first |
| Skill run | candidate | selective |
| file read/write | candidate + observation | migrate incrementally |
| Tasks | candidate | Worker mock can target now; real integration after current verification wiring settles |
| Scheduler | candidate | UI may mock now; real integration after pause/resume contract is completed |
| Approvals | candidate | UI may integrate after transport is available |
| Health | candidate | provider/task/process/approval states can integrate |
| Process | candidate | **do not rely on heavy multi-session control yet**; ownership/reconnect P0 remains |
| Browser/Desktop | internal execution works | real consumer migration waits for Observation/Verifier and provider permission semantics to settle |
| ExecutionTarget / Provider Affinity | candidate v1 | `host` ready; `sandbox` / `remote` explicitly fail closed until providers exist |

## Transport

v0.1 intentionally does not define MCP as the Runtime transport.

```text
consumer
  ↓
RuntimeClient
  ├─ InProcessRuntimeClient  ← reference/conformance
  ├─ HttpRuntimeClient       ← candidate local cross-process transport
  ├─ local IPC               ← future option
  └─ MockRuntimeClient       ← Worker development
```

The Runtime daemon exposes:

- `GET /runtime/v0.1/info`
- `POST /runtime/v0.1/rpc`

RPC calls require `x-owl-session-id`. This value is a **logical consumer session identity**, not an HTTP connection id and not an MCP transport id. A consumer must keep it stable across reconnects if it expects to retain ownership of processes/workspaces created by that logical session.

`x-owl-request-id` is optional and identifies one request only.

If `OWL_RUNTIME_API_TOKEN` is configured, callers must send the matching Bearer token. The production listener remains bound to loopback by default.

The HTTP conformance test proves:
- stable logical identity across separate requests;
- same-session process control survives request boundaries;
- a different logical session is rejected with `PROCESS_OWNED`;
- File Observation + Verification receipts survive the transport boundary;
- missing logical session identity is rejected.

Cancellation is now available for the local HTTP transport through request-scoped AbortSignal propagation and `POST /runtime/v0.1/cancel`. The caller session may cancel only its own active request; cross-session cancellation is rejected with `REQUEST_OWNED`. Synchronous shell execution terminates the whole POSIX process group, so nested `npm -> tsc` style children do not survive cancellation.

This is a **P0 foundation, not blanket cancellation readiness for every provider**. Consumers may rely on it for cancellation-aware shell execution and bounded Runtime waits that use the cancellation context. Browser/Desktop/provider-specific cancellation still needs capability-level conformance before migration.

MCP remains a consumer/adapter concern.

## Versioning

- Public contract version: `0.1`
- Runtime implementation version is independent.
- A RuntimeClient implementation must expose both through `info()`.
- Breaking public changes require a public API version change.
- Internal refactors do not require a public API change if semantics are preserved.

## Contract Requests

If a consumer needs a missing capability, it must request the contract instead of implementing a duplicate Runtime subsystem.

See [Cross-Repo Coordination](../architecture/cross-repo-coordination.md).
