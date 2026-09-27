# AgentOS Runtime Embedding Provider Contract

Status: **v0.9.10 foundation**

The Embedding Provider Contract separates memory retrieval semantics from any one vector model or service.

```text
M2 / M3 text
    |
    v
Embedding Provider Contract v1
    |
    +-- feature-hash       local, deterministic, zero dependency
    +-- ollama             local neural embedding
    +-- openai-compatible  local/private OpenAI-compatible endpoint
    +-- openai             remote OpenAI embeddings
    |
    v
StoredEmbedding
  descriptor + normalized vector
```

## Contract

Every stored embedding carries a descriptor:

```text
providerId
model
dimensions
normalized
configFingerprint
```

The descriptor is persisted with the vector. Query embeddings are generated against the descriptor of the stored vector rather than blindly using the currently configured provider.

This means old `feature-hash-v1` M2/M3 records remain searchable after the Runtime is switched to Ollama or OpenAI.

## Providers

### feature-hash

Default provider. Local, deterministic, 256 dimensions, zero external dependency. It remains the safe fallback and compatibility provider.

### Ollama

Set:

```env
EMBEDDING_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_EMBEDDING_MODEL=nomic-embed-text
```

The Runtime calls `POST /api/embed`.

### OpenAI-compatible

For a local or private OpenAI-compatible embedding server:

```env
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_BASE_URL=http://127.0.0.1:8080/v1
EMBEDDING_MODEL=local-embedding-model
```

The Runtime calls `POST /v1/embeddings`.

### OpenAI

Remote memory-text egress is deliberately opt-in:

```env
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_ALLOW_REMOTE=true
```

Having an API key alone is not enough. Without `EMBEDDING_ALLOW_REMOTE=true`, strict mode rejects the request and normal mode falls back to the configured local fallback. The same egress rule applies to any non-loopback OpenAI-compatible or Ollama endpoint, so changing a base URL cannot silently turn a local memory pipeline into remote data egress.

## Fallback policy

Default:

```env
EMBEDDING_FALLBACK_PROVIDER=feature-hash
```

Set `none` for strict provider behavior.

A fallback vector is stored with the fallback provider descriptor, so provenance remains truthful.

## Normalization

Provider vectors are normalized before persistence and cosine scoring. Stored vector dimensions are part of the descriptor.

## Runtime surface

`runtime.embedding` exposes:

```text
status
embed
```

`status` is safe for inspecting provider/model/configuration without embedding data.

## Verification

`npm run verify:embedding-provider` uses local mock HTTP servers to verify:

- feature-hash default behavior
- OpenAI remote-data opt-in gate
- local fallback
- OpenAI `/v1/embeddings` request/response contract
- OpenAI-compatible endpoints
- Ollama `/api/embed`
- descriptor-aware query compatibility

No real OpenAI network request is made by the verifier.
