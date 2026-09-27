# AgentOS Runtime Semantic Memory

Status: **v0.9.10 foundation**

v0.9.8 closes the first executable M2 Episodic → M3 Semantic promotion path.

```text
M2 Task Episode
    |
    v
Promotion Candidate
    |
    +--> Quality Gate
    |
    +--> Privacy / Secret Gate
    |
    v
Explicit Promotion
    |
    v
M3 Semantic Store
```

This remains a Runtime concern above the L1 Primitive ISA. No memory Primitive is added to the frozen core ISA candidate.

## Runtime-owned storage

Semantic records are stored by default under:

```text
~/.computer-mcp/semantic/
~/.computer-mcp/semantic.key
```

Records are AES-256-GCM encrypted at rest. The semantic directory is not added to the general filesystem allowlist.
## Promotion candidate

A candidate contains:

- source task id and label
- semantic kind: fact, preference, procedure, pattern, or decision
- title and distilled content
- tags and sensitivity label
- succeeded evidence step ids
- task event types from M2
- hashes for source evidence, content, and the complete candidate

The content is deliberately distilled by the planner/user. The Runtime does not blindly copy a whole execution trace into long-term memory.

## Quality Gate

Promotion requires:

- source task status = completed
- a task_completed episodic event
- no unresolved/failed/needs-review steps
- at least one valid succeeded evidence step
- bounded title and content size

A failed or partially completed task cannot be promoted through this path.

## Privacy / Secret Gate

The current deterministic gate requires an explicit sensitivity class and blocks obvious credential/token patterns such as private keys, API keys, bearer tokens, GitHub/Slack tokens, AWS access keys, and credential assignments.

Absolute user filesystem paths generate a warning.

This is a conservative secret gate, not a claim of comprehensive PII classification. Sensitive long-term knowledge should still be reviewed before promotion.
## Explicit promotion

Promotion is never implicit.

```text
runtime.memory(op="inspect", ...)
    |
    v
candidate + gate receipts
    |
    v
runtime.memory(op="promote", confirm=true, ...)
```

A successful promotion writes an encrypted M3 record and appends a semantic_promoted event back to the source Task's M2 history.

This creates bidirectional provenance:

```text
M3 record -> sourceTaskId + evidence digest
M2 task   -> semantic_promoted event
```

Equivalent content is deduplicated by normalized SHA-256 digest.

## Retrieval and deletion

The same L2 Skill supports status, search, list, get, and delete. v0.9.9 adds `lexical`, local `vector`, and `hybrid` retrieval modes over title, content, kind, and tags.

v0.9.10 stores provider-described embeddings with each promoted semantic record. `feature-hash-v1` remains the local default/fallback; Ollama, OpenAI-compatible endpoints, and explicitly enabled OpenAI embeddings can be used without changing the L1 ISA or promotion provenance contract.

## Verification

`npm run verify:semantic-memory` verifies a real completed Primitive task, successful candidate inspection, explicit promotion, encrypted storage, search, provenance backlink, duplicate blocking, and rejection of an obvious credential-bearing candidate.
