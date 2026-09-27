# ADR-0001: Keep L1 Primitive ISA Small

Status: Accepted

## Context

A computer agent can expose hundreds of narrow actions, but a large unstable tool surface increases planning cost, refresh requirements, and compatibility risk.

## Decision

Use a compact versioned Primitive ABI at L1. Reusable workflows live at L2 as Skills. Scheduling, loops, durable memory, and orchestration remain above L1 rather than becoming new Primitives by default.

## Alternatives

- expose every workflow as a top-level tool
- continuously add specialized Primitives
- let Skills call provider actions directly

## Consequences

- the model-facing execution vocabulary stays small
- Skills can evolve faster than the ABI
- provider changes do not require Planner-facing ABI changes
- Primitive additions require stronger justification and conformance tests
