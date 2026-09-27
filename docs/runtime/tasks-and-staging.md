# AgentOS Runtime Memory & Staging

Status: **v0.9.10 foundation**

AgentOS Runtime treats memory as a runtime plane beside the Primitive ISA, not as a replacement for the ISA.

    ChatGPT / L3 Planner
            |
            v
       L2 Skill
            |
      Primitive Graph
            |
            v
     L1 Primitive ISA
            |
            v
    Actions / Providers

    ---- Runtime Memory Plane ----
    Working -> Staging -> Episodic -> Semantic

The Primitive ISA remains small and mostly stateless. Durable context belongs to the runtime that executes Primitive graphs.

The memory plane uses `M0–M3` names deliberately so it is not confused with the execution stack's `L0–L3` layers. Memory cuts across the execution layers rather than replacing them.

## Why memory is not baked into every Primitive

A Primitive describes a capability such as fs.read, web.query, pointer.click, clipboard, or git.mutate. It should not need to know the full history of the task.

This keeps L1 stable, replayable, composable, testable, and provider-independent. Complex Skills and Tasks receive memory through Runtime context.

## M0 — Task Working Memory

Purpose: current task state, succeeded step outputs, dependency values, and variables passed between steps.

Current implementation:

- every successful persistent-task step stores its result
- later steps can read it with $ref
- task records are AES-256-GCM encrypted at rest
- working state survives ChatGPT, tunnel, MCP server, and Mac restarts

Example:

    {
      "path": {
        "$ref": "generate.path"
      }
    }

This is intentionally task-scoped, not global memory.

## M1 — Staging / Artifact Memory

Purpose: preserve intermediate files, separate transient assets from final outputs, make complex multi-step tasks resumable, and avoid putting large binaries directly into encrypted JSON task state.

Default layout:

    ~/.computer-mcp/staging/<task_id>/
    ├── manifest.json
    ├── inputs/
    ├── research/
    ├── drafts/
    ├── assets/
    ├── outputs/
    └── scratch/

The manifest tracks artifact provenance and survives independently of the encrypted task JSON record. This gives staged assets a durable index even if task metadata is later archived or migrated.

v0.9.5 automatically detects absolute file paths returned by successful task steps. Files inside an allowed workspace are copied into the task staging area.

Each staged artifact records artifact id, source path, staged path, step id, size, SHA-256, creation time, and category.

For object-shaped step results, the runtime adds:

    result.staging.artifacts[]

A downstream Primitive can reference the preserved copy:

    {
      "path": {
        "$ref": "render.staging.artifacts.0.stagedPath"
      }
    }

The runtime-owned staging directory can be exposed to filesystem/browser Primitives with:

    TASK_STAGING_EXPOSE_TO_FS=true

This allows a later step to upload, read, transcode, inspect, or publish an intermediate artifact after the producer step has finished.

## M2 — Episodic Memory

Purpose: what happened, when it happened, attempts/retries, failures, recovery decisions, execution durations, and task lifecycle.

Current implementation:

- persistent task event stream
- run count
- step attempt count
- recovery notes
- pause/cancel/block history

Task-local events remain the source-of-truth M2 trace. v0.9.9 additionally maintains an encrypted global episodic index of terminal completed/failed/blocked/cancelled tasks so the Planner can recall experience across tasks without changing the Primitive ISA.

## M3 — Semantic Memory

Purpose: reusable facts, proven patterns, successful workflow strategies, promoted knowledge, and learned preferences/rules.

Status in v0.9.8: implemented as an explicit, gated promotion pipeline.

    completed Task + M2 evidence
        |
        v
    Promotion Candidate
        |
        +--> Quality Gate
        |
        +--> Privacy / Secret Gate
        |
        v
    explicit promote(confirm=true)
        |
        v
    encrypted M3 Semantic Memory

The Runtime does not turn every execution trace into long-term knowledge. Failed, partial, accidental, or obvious credential-bearing candidates are blocked. Every promoted record keeps sourceTaskId, evidence step ids, event types, evidence/content digests, and gate receipts. The source Task receives a semantic_promoted event so provenance is bidirectional.

v0.9.9 M3 retrieval supports lexical, local-vector, and hybrid modes. The current local vectorizer is deterministic feature hashing rather than a neural embedding model, and can be replaced later without changing the L1 ISA or promotion provenance contract.

See [Semantic memory](memory/semantic-memory.md).

## Complex Tasks

A durable task can now be represented internally as a Primitive graph with createPersistentPrimitiveTask.

Each step stores:

    executionKind = primitive
    primitive
    op
    routed Action
    Action Contract
    dependencies
    retry policy
    resources
    result
    staged artifacts

Execution path:

    Persistent Task
          |
          v
      Primitive
          |
          v
    Action Contract
          |
          v
    Resource Arbiter
          |
          v
       Provider

Legacy Action-based persistent tasks remain supported for compatibility.

## Complex Skills

A complex Skill should be:

    Skill
    = Primitive Graph
    + State Logic
    + Governance Metadata
    + Memory Policy

Skill metadata now declares:

    skillVersion
    requiredPrimitiveAbi
    requiredPrimitives
    executionMode
    memoryPolicy

Application-specific built-in Skills currently remain executionMode=inline.

v0.9.5 adds runtime.compile_task as a generic executionMode=durable Skill. It accepts a Primitive graph and emits a Persistent Primitive Task without adding a new top-level MCP tool:

    skill_run("runtime.compile_task")
       |
       v
    Durable Skill compiler
       |
       v
    Persistent Primitive Graph
       |
       v
    Working Memory + Staging + Episodic Memory
       |
       v
    pause / resume / recovery

No L1 ISA redesign is required.

## ISA compatibility

Memory is compatible with the current Primitive ISA because responsibilities are separated:

| Concern | Layer |
| --- | --- |
| What operation is possible? | L1 Primitive ISA |
| How is it implemented? | L0.5 Action / L0 Provider |
| What workflow should run? | L2 Skill / Task graph |
| What values are alive now? | Working Memory |
| Where are intermediate files? | Staging |
| What happened previously? | Episodic Memory |
| What should be remembered long-term? | Semantic Memory |

A future semantic-memory engine can therefore be replaced without changing fs.read, web.act, clipboard, and other core Primitives.

## Security and storage

Persistent task JSON state:

    AES-256-GCM encrypted
    ~/.computer-mcp/tasks/

Task staging:

    local file-backed
    ~/.computer-mcp/staging/
    directories mode 700
    staged files mode 600

Staged binary files are not encrypted at rest in v0.9.5 because external tools such as FFmpeg, Chrome upload, and native applications need ordinary file access.

Future options include encrypted dormant staging, sensitivity labels, TTL/garbage collection, secure-delete policy, promotion redaction, and content-addressed deduplication across tasks.

## Current lifecycle

    create task
       |
       v
    create staging directories
       |
       v
    run Primitive wave
       |
       +--> persist step result       (Working Memory)
       |
       +--> copy result files         (Staging)
       |
       +--> record task events        (Episodic)
       |
       v
    next step can $ref result/staged artifact
       |
       v
    complete / pause / recover
       |
       v
    explicit gated promotion          (Semantic)

## v1 direction

Before AgentOS Runtime v1.0:

1. Freeze the durable Skill compiler contract.
2. Add embedding cache/rotation and controlled background re-embedding while preserving historical provider descriptors.
3. Add staging TTL, selection/finalization, and garbage collection.
4. Add artifact sensitivity and retention metadata.
5. Expand memory conformance tests and promotion policy fixtures.
6. Add retention/compaction policy for the global episodic index.
7. Keep memory APIs outside the frozen core ISA unless a truly provider-independent memory Primitive proves necessary.
