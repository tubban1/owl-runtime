# Memory Model

AgentOS uses four memory layers with different durability and governance.

```text
M0 Working Memory
        ↓
M1 Staging / Artifact Memory
        ↓
M2 Episodic Memory
        ↓ explicit quality/privacy gate
M3 Semantic Memory
```

## M0 — Working

Current task outputs, references, intermediate values, and execution state.

## M1 — Staging

Task-local file artifacts copied into Runtime-owned staging with provenance, hashes, and stable references.

## M2 — Episodic

Execution experience. Terminal tasks can be indexed globally, including failures, so the Runtime can recall what happened without treating every event as truth.

## M3 — Semantic

Long-term facts, procedures, preferences, patterns, and decisions. Promotion is explicit and gated. Failure traces do not automatically become semantic truth.

Retrieval can combine lexical and vector signals through the Embedding Provider Contract.

See:

- [Tasks and staging](../tasks-and-staging.md)
- [Episodic recall](episodic-recall.md)
- [Semantic memory](semantic-memory.md)
- [Embedding Provider Contract](../../specifications/embedding-provider.md)
