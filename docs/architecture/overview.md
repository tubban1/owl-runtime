# AgentOS Runtime Architecture

AgentOS Runtime is the post-v0.8 evolution of `computer-mcp`: a stable execution runtime beneath an external planner such as ChatGPT.

The runtime does **not** embed a second general-purpose LLM planner. ChatGPT remains L3.

## Layer model

```text
L3  Planner
    ChatGPT
      ↓
L2  Skills
    reusable workflows + state logic + governance metadata
      ↓
L1  Primitive ISA
    small, stable, orthogonal capability surface
      ↓
L0.5 Actions
    provider-specific routed operations with contracts
      ↓
L0  Providers / Drivers
    macOS Helper, browser/CDP, filesystem, shell, Git, transactions
      ↓
Environment
    macOS apps, web apps, files, repositories, processes, services
```

## Current mapping

### L3 — Planner

- ChatGPT
- goal decomposition
- capability selection
- novel composition
- user interaction

### L2 — Skills

Examples:

- `wechat.read`
- `wechat.copy_at`
- `wechat.read_points`
- `wechat.send`
- `xhs.publish`
- `email.compose`
- `media.transcode`

Definition:

```text
Skill = Primitive Graph + State Logic + Governance Metadata
```

Skills may change and grow frequently. Adding a Skill should not require changing the L1 ISA.

### L1 — Primitive ISA

Current Primitive families:

- `provider.status`
- `vision.capture`
- `ui.query`
- `pointer.click`
- `keyboard.type`
- `keyboard.press`
- `clipboard`
- `app.lifecycle`
- `web.open`
- `web.query`
- `web.act`
- `web.transfer`
- `web.session`
- `fs.read`
- `fs.write`
- `fs.list`
- `fs.stat`
- `fs.manage`
- `fs.search`
- `process.manage`
- `git.query`
- `git.mutate`
- `tx.manage`

Non-core extensions:

- `sys.exec` — privileged escape hatch; use typed Primitives/Skills when available.
- `admin.permission` — experimental administrative extension for native Helper permission diagnostics and prompts.

Compatibility alias during v0.9:

- `fs.query` → `fs.stat` (deprecated)

The L1 ISA should be:

- small
- stable
- orthogonal
- composable
- provider-independent where practical
- explicit about side effects
- versionable without forcing Skill rewrites

### L0.5 — Actions

Examples:

- `desktop.ui_tree`
- `desktop.click`
- `desktop.clipboard_copy_selection`
- `browser.click`
- `browser.upload`
- `shell.exec`
- `git.push`

Every action has an Action Contract:

```text
riskLevel
idempotent
sideEffects
retryPolicy
requiresVerification
parallelSafe
resources
```

Actions are implementation-facing and may evolve faster than the Primitive ISA.

### L0 — Providers / Drivers

Current providers:

- Filesystem
- Shell / managed processes
- Git
- Transaction
- Browser / Chrome CDP
- macOS Desktop
- Computer MCP Helper.app

Providers translate Actions into real platform behavior.

## Control plane

The stable model-facing control surface should converge on:

```text
capability_manifest

skill_catalog
skill_run

primitive_catalog
primitive_call

computer_graph

task_create
task_run
task_status
task_pause
task_cancel
task_resolve_step
task_delete
```

Legacy direct tools can remain temporarily for compatibility/debugging, but new capability growth should happen behind Skills, Primitives, Actions, and Providers.

## Version boundary

### v0.8.0

Stable pre-AgentOS release.

Characteristics:

- direct MCP-tool architecture
- persistent encrypted tasks
- graph execution
- browser + desktop providers
- 63 annotated tools
- simpler mental model
- preserved as a public GitHub Release

### v0.9.x

AgentOS Runtime transition.

Introduces:

- Primitive ISA
- Skill Runtime
- Capability Manifest
- Action Contracts
- Resource Arbiter
- native macOS Helper
- richer perception channels
- visual + clipboard WeChat perception

v0.9.4 tightens the architecture boundary:

- Primitive ABI version is explicit (`abiVersion=1`).
- Primitive catalog exposes stability/tier/deprecation metadata.
- `fs.stat` becomes canonical while `fs.query` remains a deprecated alias.
- duplicate transitional ops remain accepted but advertise replacements.
- `sys.exec` is classified as privileged.
- built-in Skills execute through the L1 Primitive ISA rather than directly invoking L0.5 Actions.
- `npm run verify:isa` checks the L2→L1 dependency boundary and catalog invariants.


v0.9.5 adds the durable-memory foundation:

- persistent tasks can be represented internally as Primitive graphs
- Task Working Memory persists step outputs and $ref state
- task-local Staging preserves intermediate file artifacts with hashes and provenance
- downstream Primitive steps can consume staged copies through $ref
- task event history forms task-local Episodic Memory
- Skill metadata declares version, Primitive ABI requirements, execution mode, and memory policy
- Semantic Memory uses explicit gated promotion rather than implicit auto-learning; v0.9.9 adds unified recall across global M2 and M3.

Memory architecture: [../runtime/tasks-and-staging.md](../runtime/tasks-and-staging.md)

Skill ABI: [../specifications/skill-abi.md](../specifications/skill-abi.md)

v0.9.6 adds the persistent wake/scheduler foundation:

- schedules are encrypted durable Runtime state, separate from the L1 ISA
- `runtime.schedule` creates once, interval, or daily wake plans through the existing `skill_run` surface
- each occurrence creates/resumes a Persistent Primitive Task
- yielded tasks resume on a later wake instead of requiring one multi-hour MCP request
- result-based `stop_when`, `max_runs`, and `end_at` bound monitoring loops
- due schedules are picked up again after Runtime restart
- no new top-level MCP tool or schema refresh is required

Scheduler architecture: [../runtime/scheduler-and-wake.md](../runtime/scheduler-and-wake.md)

### v1.0 readiness

AgentOS Runtime should not be called 1.0 until these are stable:

1. L1 Primitive ISA reviewed and frozen for 1.x compatibility.
2. Skill schema/versioning rules defined.
3. Action Contract semantics stable.
4. Resource arbitration supports leases/timeouts and deadlock-safe composition.
5. Durable Skills can compile into persistent task graphs.
6. Persistent scheduler/wake semantics are stable; event triggers and stateful Loop Controller semantics are defined.
7. Capability discovery is dynamic and does not require MCP schema refresh for ordinary new Skills.
8. Provider diagnostics and permission reporting are standardized.
9. End-to-end conformance tests exist for each Primitive family.
10. Security boundaries and side-effect verification are documented.

## Naming

Public product/runtime name:

```text
AgentOS Runtime
```

Compatibility identifiers remain unchanged for now:

```text
GitHub repository: tubban1/computer-mcp
npm package:       computer-mcp
MCP server name:   computer-mcp
```

This avoids breaking existing tunnels, plugin connections, scripts, documentation links, and local installations while the architecture stabilizes.

A repository/package rename can be evaluated at the 1.0 boundary.


### v0.9.8 — Semantic Promotion Pipeline

v0.9.8 closes the first executable M2 Episodic → M3 Semantic path.

- completed task episodes become promotion evidence
- Quality Gate rejects incomplete or unresolved task evidence
- Privacy / Secret Gate blocks obvious credential-bearing candidates
- promotion requires an explicit confirm=true operation
- M3 records are AES-256-GCM encrypted in runtime-owned storage
- every record keeps source task/evidence hashes and gate receipts
- the source task receives a semantic_promoted episodic event
- semantic memory supports status/search/list/get/delete through runtime.memory

No new L1 Primitive or top-level MCP tool is required.

Architecture: [../runtime/memory/semantic-memory.md](../runtime/memory/semantic-memory.md)


### v0.9.9 — Global Recall, Durable Agent Sessions & Runtime Identity

v0.9.9 adds three Runtime surfaces without adding new top-level MCP tools:

- `runtime.recall` — unified global M2 Episodic + M3 Semantic retrieval
- `runtime.session` — durable ChatGPT/Antigravity/generic browser session bindings
- `runtime.identity` — product identity, wake name and aliases

Terminal Persistent Tasks are automatically indexed into encrypted global M2 memory, including failed/blocked/cancelled tasks so failure experience remains recallable without being promoted as semantic truth.

Recall supports lexical, vector and hybrid modes. v0.9.10 routes vector generation through the Embedding Provider Contract; `feature-hash-v1` remains the local zero-dependency default/fallback, with Ollama, OpenAI-compatible, and explicitly opted-in OpenAI providers available.

Session adapters bind exact conversation URLs/fingerprints, capture the last assistant message, persist turn receipts, and freeze automatic replay if a send is interrupted in an uncertain state.

Persistent Loop phases can now execute either Primitive graphs or Session Adapter operations. This closes the Runtime-level ChatGPT ↔ Antigravity relay path.

The managed browser uses a stable Runtime-owned profile across restarts. `web.session` is the canonical tab/session Primitive family with `tabs`, `use_tab`, `new_tab`, and `close`.

The formal name remains AgentOS Runtime. A configurable wake name such as `Jarvis` is exposed through MCP metadata and capabilities for chats where computer-mcp is connected.


### v0.9.10 — Embedding Provider ABI & Persistent WeChat Sessions

Vector generation is now a provider contract rather than a hard-coded retrieval implementation. M2 and M3 vectors persist their provider/model/dimension/config descriptor; query-time vector generation follows the descriptor of each stored vector. Supported provider families are local feature-hash, Ollama, OpenAI-compatible endpoints and explicitly opted-in OpenAI embeddings.

The Runtime also adds a durable WeChat Session Endpoint. Background CGWindow capture plus Apple Vision OCR supports non-consuming low-interruption probes without activating WeChat. Foreground contact selection/send runs inside a focus transaction that records the previous frontmost application and restores it afterward.

Browser-agent and WeChat bindings now share the Session Endpoint abstraction used by Persistent Loop. Session phases support `identify`, `probe`, `capture_latest` and `send`.

See [Embedding Provider](../specifications/embedding-provider.md) and [WeChat adapter](../adapters/wechat.md).


### v0.9.11 — Concurrency Ownership & Production Runtime

v0.9.11 hardens AgentOS Runtime for concurrent ChatGPT sessions and long-lived production use.

The central ownership change is that a raw MCP transport session is no longer treated as the durable identity of complex work. Transport sessions may rotate while one visible ChatGPT conversation continues.

Runtime ownership is now split by lifetime:

- ordinary routed actions use short-lived Resource Arbiter workspace locks
- Persistent Tasks own workspaces as `task:<taskId>`
- managed write processes own workspaces as `process:<processId>`
- Git transactions own workspaces as `transaction:<txId>`
- explicit `runtime.workspace acquire` remains available for deliberate manual ownership

Workspace conflicts are hierarchical. A parent workspace and child repository cannot bypass one another merely because their resource keys are different strings. Independent sibling repositories remain concurrent.

Managed processes persist PID/log/ownership metadata, pin workspace ownership while alive, reconcile after Runtime restart, and support explicit claim when the former transport is gone. Process exit releases process-scoped workspace ownership.

Session-only leases from a previous Runtime instance are reclaimed when they have no durable Task owner and no pinned process.

Production mode now has an explicit deployment boundary:

- development state defaults to `~/.computer-mcp-dev`
- production state defaults to `~/.computer-mcp`
- test state defaults to `~/.computer-mcp-test`
- production executes compiled `dist/server.js` from immutable release directories
- launchd keeps the service alive
- installation health-checks the selected release
- failed installation switches back to the previous release
- the production Runtime refuses to mutate its own active code workspace by default

v0.9.11 also fixes same-file `batch_edit_files` composition so multiple ordered edits to one file are validated in memory and written once instead of overwriting one another.

See:

- [Concurrency and ownership](concurrency-and-ownership.md)
- [Production Runtime](../operations/production-runtime.md)

Verification:

```bash
npm run verify:concurrency
npm run verify:production-runtime
```


### v0.9.12 — Graceful Drain, Wait & Explicit Workspace Handoff

v0.9.12 adds a Runtime lifecycle foundation for safe maintenance and future zero/low-downtime upgrades.

The Runtime can enter a `DRAINING` state through `runtime.control`. While draining, new side-effecting ad-hoc work is rejected, new Persistent Task runs are not admitted, and Scheduler/Loop ticks stop launching new work. Work already admitted before the drain request can finish its current safe run boundary.

`runtime.control wait` waits for active mutation scopes and managed write processes to clear; `resume` reopens mutation admission.

Workspace coordination is extended with `runtime.workspace wait` and an explicit ownership-transfer protocol:

```text
request_takeover
      ↓
handoff(confirm=true)
      ↓
takeover(confirm=true)
```

A takeover request records the original lease ID and owner. Handoff fails if ownership changed in the meantime or if managed processes still pin the lease. Ownership is never silently stolen by the normal protocol.

Durable handoff receipts are stored separately from workspace leases so the transfer remains reviewable.

See [Graceful drain and workspace handoff](../operations/graceful-drain-and-handoff.md) and [ADR-0005](../adr/0005-graceful-drain-handoff.md).

Verification:

```bash
npm run verify:drain-handoff
```

This is the foundation for the next upgrade-coordinator work: candidate Runtime startup, compatibility validation, old-Runtime drain, routing switch, shutdown, and rollback integration.


### v0.9.13 — Candidate Preflight & Graceful Production Upgrade

v0.9.13 turns the v0.9.12 drain lifecycle into an executable production-upgrade protocol.

A new release is first started on an alternate loopback port in **candidate mode** against the same production state root. Candidate mode starts in `DRAINING` and deliberately disables Persistent Scheduler, Persistent Loop Controller, and Process Monitor, so compatibility can be checked without creating a second active executor.

After candidate health passes, the upgrade coordinator controls the currently active Runtime through its existing MCP surface:

```text
skill_run
  → runtime.control drain
  → runtime.control wait
```

Only after the old Runtime reaches a safe mutation/write-process boundary does the coordinator switch `~/.agentos/current`, replace the launchd process, and verify the new production health response.

If cutover health fails, the previous immutable release is restored and rollback health is verified. If drain fails before cutover, the old Runtime is resumed and the release symlink is never changed.

Immutable release `run.sh` files now resolve their own release-local `dist/server.js`, removing an indirect dependency on the mutable `current` symlink.

The upgrade path reuses MCP lifecycle control rather than adding a separate local admin HTTP endpoint.

See [Production upgrades](../operations/production-upgrades.md) and [ADR-0006](../adr/0006-production-upgrade-protocol.md).

Verification:

```bash
npm run verify:upgrade-runtime
```

Persistent-state schema migration remains a separate hardening milestone; candidate preflight does not mutate state merely to prove compatibility.


### v0.9.14 — Versioned Durable State & Migration Registry

v0.9.14 gives the production state root an explicit schema contract.

A state root with no manifest is schema 0. The current Runtime schema is 1, represented by `runtime-state.json`.

The L2 Skill `runtime.state` exposes:

```text
status
plan
migrate
```

Migration does not add a Primitive and does not change Primitive ABI v1.

Production ordering is:

```text
candidate reads state
→ old Runtime drains
→ candidate applies only auto-safe + rollback-compatible migrations
→ candidate verifies native state schema
→ cutover
```

The first migration, `0001-bootstrap-state-manifest`, is additive and leaves all existing Task, Memory, Scheduler, Loop, Session, Process, browser, and WeChat data formats unchanged.

Migration writes a durable journal before commit and uses atomic rename for the manifest. An idempotent pending migration can resume after a crash. A newer-than-supported state schema fails closed.

This makes code rollback safety an explicit state-migration property instead of an assumption.

See [Runtime Durable State Schema](../specifications/state-schema.md) and [ADR-0007](../adr/0007-versioned-durable-state.md).

Verification:

```bash
npm run verify:state-schema
npm run verify:upgrade-runtime
```


### v0.9.15 — Crash-Replay Recovery Matrix

v0.9.15 hardens durable execution around crash windows where the Runtime can stop between a receipt and its side effect.

The core rule is:

```text
persist deterministic identity / intent
        ↓
perform side effect
        ↓
persist completion receipt
        ↓
cleanup
```

Recovery reuses the same durable identity rather than generating a second logical operation.

Key changes:

- filesystem text writes/edits use temp + atomic replace
- Scheduler occurrences persist a deterministic Task id before Task creation
- Loop phases persist a deterministic Task id before Task creation
- semantic promotion can repair a missing M2 provenance backlink after the M3 write committed
- workspace handoff adds a durable `releasing` state and replay-safe takeover completion
- Git transaction completion/rollback receipts commit before cleanup and lease release
- same-Runtime disconnected MCP session-only workspace leases are reclaimed after a reconnect grace period when no Task/process pin exists
- test-only named fault injection exercises these windows deterministically

Existing managed-process recovery, browser-session pending-send protection, WeChat pending-send protection, and state-migration journal recovery are combined with the new crash-window verifier by:

```bash
npm run verify:recovery-matrix
```

See [Fault recovery matrix](../operations/fault-recovery.md) and [ADR-0008](../adr/0008-durable-side-effect-replay.md).

The Primitive ABI remains unchanged; these changes live in Runtime durability/orchestration and provider-side mutation semantics.


### v0.9.16 — Multi-Agent Soak Harness & Stale Session Lease Recovery

v0.9.16 turns long-duration concurrency testing into a repeatable Runtime release gate.

The soak harness exercises multiple independent MCP execution contexts, deliberate same-workspace contention, Persistent Scheduler, Persistent Loop Controller, managed processes, browser Session Adapter fixtures, and WeChat Session Adapter fixtures inside an isolated test state root.

The harness separates independent foreground repositories from Scheduler/Loop repositories so expected background ownership contention does not contaminate the independent-concurrency signal.

It records periodic heartbeats and final machine-readable reports with:

- independent action success/error counts
- resource wait max/p95
- same-workspace contention rejection counts
- Scheduler and Loop exactly-once side-effect counts
- durable Task IDs and terminal-state checks
- managed-process leak checks
- workspace-lease leak checks
- adapter fixture health
- event-loop lag max/p95
- RSS growth

Named profiles are provided for smoke, 2-hour, 6-hour, and 24-hour runs. A profile only counts as a release-gate pass after a real completed report returns `success=true`.

v0.9.16 also hardens session-only workspace ownership for ChatGPT stream/network recovery. An MCP transport can remain apparently active even after the visible conversation has moved to a replacement transport. Session-only leases with no Task owner and no pinned managed process can therefore be reclaimed after a conservative active-but-idle timeout, in addition to known-disconnected-session reclamation.

This does **not** weaken Task-, Process-, or Transaction-scoped ownership. Long-lived work should continue to use those stable durable owner identities rather than a raw MCP transport session.

Verification and long-run commands:

```bash
npm run soak:smoke
npm run soak:2h
npm run soak:6h
npm run soak:24h
npm run soak:status
```

See [Multi-agent soak testing](../operations/soak-testing.md) and [Concurrency and workspace ownership](concurrency-and-ownership.md).
