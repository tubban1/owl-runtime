# ADR-0002: Layer Memory and Gate Semantic Promotion

Status: Accepted

## Context

Execution state, intermediate artifacts, historical experience, and long-term knowledge have different trust and retention requirements.

## Decision

Use M0 Working, M1 Staging, M2 Episodic, and M3 Semantic layers. M2 may contain failed experience. Promotion into M3 is explicit and passes quality/privacy/secret gates.

## Alternatives

- one global memory store
- automatically promote every terminal task
- keep memory only inside chat history

## Consequences

- failures remain recallable without becoming semantic truth
- artifacts retain provenance
- long-term knowledge changes are auditable
- memory retention and compaction can evolve independently by layer
