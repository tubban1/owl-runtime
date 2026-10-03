# OWL OS architecture contract — 1.x

Status: accepted architectural direction; migration specification only.
Implementation and acceptance gates below are not claimed complete.
Owner: OWL Runtime. Desktop owns MCP presentation; Cloud/Worker consume it.
Baseline inspected: Runtime bf7f8e0, Desktop b8ea390, 2026-10-03.

## Constitution

```text
ChatGPT / Planner
       ↓
L2 Skill
       ↓
L1 Primitive ISA       stable public execution ABI
       ↓
L0.5 Action + Contract Runtime-private execution ABI
       ↓
L0 Provider / Driver   Runtime-private implementation
       ↓
OS / Browser / Cloud
```

Planner may call a Skill or a Primitive. Primitive is the only public low-level
execution vocabulary; Action must not become a second ISA. Task lifecycle,
capability discovery, Observation and Verification remain public contracts.
Provider health may be exposed as sanitized capability evidence through the
existing ABI; driver methods and implementation-specific routing are private.

L2 execution depends only on L1: no direct Action dispatch, Provider execution
or OS/driver calls in Skill implementations. Runtime-owned orchestration and
capability assembly are separate from Skill execution. Existing mixed modules
must be assessed before claiming this invariant enforced.

Freeze Primitive ABI v1: preserve IDs, operations, argument/result meanings,
security and verification semantics. This document neither deletes existing
methods nor changes the frozen public Runtime HTTP API 0.1 / DTO v1. New
canonical envelopes and presentation profiles require versioned additive 1.x
contracts and owner-first acceptance. Incompatible ISA changes require a
separate ABI decision.

## Observed migration inventory

| Surface | Inspected behavior | Required migration |
| --- | --- | --- |
| Runtime src/adapters/mcp/server.ts | router_catalog, computer_action/batch/graph execute or advertise internal routes; task_create expects action | Explicit compatibility/debug exposure; canonical Primitive entry points |
| Desktop mcp/create-server.mjs | router_catalog returns unavailable; computer_action/batch/graph reject, but remain registered | Remove from normal discovery; preserve bounded deprecation behavior for cached clients |
| Desktop task_create | Action-shaped steps forwarded to tasks.create | Versioned canonical Primitive-shaped request |
| Runtime tasks/taskRuntime.ts and taskStore.ts | Both Primitive and Action execution paths; persisted steps carry action | Canonical public Primitive shape with private lowering and legacy read compatibility |
| Runtime public/runtimeDtos.ts | PublicTaskStepV1 includes action | Additive versioned projection; do not silently change DTO v1 |
| Runtime executionContext.ts | Task context selects task:<id>; otherwise session:<id> | Prove durable ownership propagated through every long-running path |
| scripts/verify-skill-abi.ts | Checks catalog dependency declarations/version metadata | Add implementation dependency checks and execution-path conformance |

Desktop compatibility tools often already map to Primitives. Their aliases
must not be confused with executable direct-Action routes. Audit both Runtime
and Desktop adapters, manifests, tool descriptions and instructions; hiding a
name in one catalog alone does not close another public entry point.

## Canonical Graph and Task

The proposed canonical step has id, primitive, op, args, explicit dependencies
and existing versioned verification requirements. It contains no caller-chosen
Action route or Provider. Dependency references, bounded concurrency, fail-fast
behavior, cancellation and verification must preserve accepted semantics.

Runtime validates the complete graph before side effects, resolves Primitive
operations and lowers them internally into Action contracts. Resource conflicts
are decided from validated Runtime contracts, never a Planner-supplied claim
that an operation is parallel-safe. Dry-run performs validation, not execution.
Durable or long-running graphs execute under an existing or explicitly created
Task; reconnect must not synthesize a replacement Task.

Reject ambiguous mixed Action/Primitive steps in the new canonical envelope.
Legacy Action graphs/tasks are compatibility-only and retain an explicit schema
version/profile. Do not reinterpret computer_graph silently as Primitive Graph
or alter cached schemas under the same contract version. Publish primitive_graph
additively only after its Runtime owner contract is accepted.

Persisted legacy tasks remain readable and controllable. Migration must preserve
Task/step identity, completed outputs, approval fingerprints, execution revision,
replay keys and ownership. Do not recompute or invalidate an approved revision
on read by rewriting an Action name to a Primitive. Any executable conversion
requires an explicit versioned migration/re-activation policy and receipts.

## Public surface and compatibility

Target normal discovery: capability_manifest; skill_catalog/skill_run;
primitive_catalog/primitive_call/primitive_graph; Task create/start/run/status/
pause/cancel and required process/approval/observation controls. These names
express a target surface, not a claim that every tool already exists.

Normal manifests, tools/list, instructions and examples must not advertise
router_catalog, computer_action/batch/graph or driver-oriented aliases as the
preferred execution path. Legacy browser_click, desktop_click, execute_command
and similar wrappers are classified and progressively deprecated; preserve
explicit migration mappings to their canonical Primitives.

A developer/debug compatibility profile is explicit, disabled by default and
separately authorized. It cannot bypass access leases, approval, ownership,
verification, resource arbitration or audit. Cached legacy calls fail closed
with a bounded deprecation response and canonical replacement guidance, without
side effects. Removal from tools/list and behavior for cached calls require
separate tests. Cloud tool catalogs must consume the accepted presentation
contract, not invent a second execution vocabulary.

## Task ownership through every layer

```text
Task → Primitive → Action → Process / Transaction / Workspace Lease
```

Durable execution records propagate Task/step identity, revision, request/replay
identity and authorization attribution through the entire chain. Process,
transaction and workspace leases retain their stable resource identities while
linking to the owning Task. MCP sessions, Tunnel connections and ChatGPT streams
are transport/audit facts, not replacement durable owners.

Disconnect alone neither cancels accepted durable work nor authorizes takeover.
Reconnection must authenticate/authorize access to the same Task; stable Task
identity is not itself permission. Explicit cancel is distinct from transport
abort and from rollback. Uncertain completion reconciles durable evidence
instead of replaying a side effect. Adoption of legacy orphan processes requires
an explicit authorized claim/handoff, not an idle-time guess.

Action contracts internally cover authorization, risk, side effects, ownership,
resource arbitration, workspace lease, retry policy, execution, observation and
verification. Adapters must not reimplement that execution authority.

The reported screen-recording owner-loss incident is motivation, not a confirmed
root cause. Capture its exact invocation and Task/process/transport evidence
before changing ownership code.

## Capability gaps before ISA expansion

For recording, first specify media.screen_record as a Skill with Task ownership,
permission requirements, lifecycle (start/status/stop/cancel), bounded cleanup,
artifact receipt, observation and verification. ScreenCaptureKit or another
backend belongs to Action/Provider, not Planner-facing arguments.

The Skill must use existing Primitives if they can express the contract safely.
If they cannot, document the concrete composition gap first. Do not introduce a
hidden direct-Provider Skill call or an arbitrary shell escape to evade L1.
Only a proven general, orthogonal atomic capability warrants an additive op or
ABI v2 proposal. This contract does not implement or approve a new recording op.

## Serialized migration and acceptance

The active packaged stability/fault-matrix/readiness program keeps priority.
This documentation slice does not restart services, change release pins, alter
soak artifacts or reopen Runtime 1.0. Subsequent implementation is serialized:

1. Architecture inventory and invariant specification (this document).
2. Runtime canonical Primitive Graph/Task request and projection contracts;
   backward-compatible legacy storage/approval/replay conformance first.
3. Task-owned execution propagation and disconnect/recovery conformance before
   any new durable capability. Correctness fixes may proceed only with evidence.
4. Desktop normal discovery/profile migration against accepted Runtime contracts;
   test cached legacy calls, Primitive wrappers and manifest consistency.
5. Cloud catalog/distribution and Worker consumers after owner/consumer gates.
6. Specific capability gap proposals; no speculative ISA expansion.

Extend existing ISA, Skill ABI, public DTO, request replay, detached Task,
concurrency, cancellation and recovery gates. Add proof for no direct L2→Action/
Provider execution; Primitive-only canonical Graph/Task validation; equivalent
policy/observation/verifier behavior across compatibility and canonical paths;
and reconnect/restart preserving Task, process and lease identity with no
replacement Task or duplicate side effect. Frozen ABI fixtures must remain
unchanged. Static declarations alone cannot prove the execution invariant.

Record documented, implemented, targeted-test, full-repo, live and packaged
acceptance separately. This contract reaches only the documented stage.

References: ../architecture/layers.md, ../architecture/concurrency-and-ownership.md,
../specifications/primitive-abi.md, ../specifications/skill-abi.md,
../runtime/EXECUTION_REVISION_V1.md, ../runtime/SAME_EXECUTION_APPROVAL_RESUME_V1.md.
