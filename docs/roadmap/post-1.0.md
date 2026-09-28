# Post-1.0 Directions

These are intentionally not release blockers for OWL Runtime 1.0.

Post-1.0 work is governed by the [Architecture Constitution](../architecture/constitution.md), [Owl Lab philosophy alignment audit](../architecture/owl-lab-philosophy-alignment.md), and [Evolution Discipline](evolution-discipline.md). Owl Lab is an architecture research source, not a feature checklist. Ideas enter Runtime only when they become generic execution invariants backed by consumer evidence.

Priority research candidates for 1.1 are intentionally capped at three protocol surfaces: GroundedState v1, RemediationReceipt v1, and a Governed Capability Manifest v1. They remain proposals until Computer MCP or OWL Worker provides concrete evidence.

- event-driven adapters beyond polling
- additional desktop messaging adapters
- richer local neural embedding providers and reranking
- multi-machine Runtime federation
- remote worker pools
- richer scheduler triggers
- artifact retention/compaction policies
- semantic-memory consolidation and contradiction handling
- UI for Runtime tasks, leases, processes, memory, and audit
- organization/multi-user policy layers
- sandboxed execution backends
- pluggable secret managers
- distributed tracing and metrics exporters

New ideas must pass the Evolution Discipline review before entering Runtime. Prefer a receipt/field/contract over a new subsystem, and prefer a consumer-side solution when the invariant is not generic.
