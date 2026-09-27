# Privacy and Secrets

## Remote embeddings

Memory text must not leave the machine merely because a provider base URL was changed.

Any non-loopback embedding endpoint requires explicit `EMBEDDING_ALLOW_REMOTE=true`.

## Durable memory

M2/M3 stores and durable session stores use Runtime-owned encrypted persistence where implemented. Secret-bearing candidates are rejected by semantic promotion gates.

## External messaging

Browser-agent and WeChat sends persist side-effect receipts and uncertain-send state. This reduces duplicate sends after crashes.

## Logs

Process stdout/stderr and audit logs can contain sensitive operational data. Keep the Runtime state root private and do not publish it with source code.

## Production environment

`~/.agentos/runtime.env` may contain credentials. It should remain mode 0600 and outside the repository.
