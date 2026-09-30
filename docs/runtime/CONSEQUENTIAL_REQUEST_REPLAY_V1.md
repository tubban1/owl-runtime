# Consequential Request Replay v1

Status: **OWL Runtime 1.x Integration Closure candidate**

This contract implements Runtime R1 / Desktop CR-DESKTOP-005 without changing Runtime 1.0 / rc.4 frozen semantics.

## Problem

A transport response can be lost after Runtime has already crossed a consequential side-effect boundary.

Without a Runtime-owned replay contract:

```text
request
-> Runtime executes
-> response lost
-> client retries
-> duplicate side effect
```

Desktop-local dedupe is not execution truth.

## Identity model

Two identities have different jobs.

`x-owl-request-id`:

- identifies one transport attempt;
- owns cancellation for that attempt;
- should be new for a retry.

`x-owl-idempotency-key`:

- identifies one logical consequential request;
- is stable across transport retries;
- is scoped to the stable `x-owl-session-id`.

The durable identity is:

```text
logical session
+ idempotency key
+ canonical request digest
```

The canonical request digest is SHA-256 over:

```text
contract version
+ RPC method
+ canonicalized params
```

The raw params are not stored as replay identity metadata.

## HTTP contract

A replay-protected call supplies:

```http
x-owl-session-id: desktop:<stable-id>
x-owl-request-id: transport-attempt:<unique-id>
x-owl-idempotency-key: command:<stable-logical-id>
```

A retry uses a new request ID and the same idempotency key.

Runtime response metadata:

```text
x-owl-idempotency-status:
  executed | replayed | unprotected

x-owl-original-request-id:
  <request id that created the canonical receipt>
```

The existing Runtime HTTP API remains `/runtime/v0.1/rpc`. This is an additive 1.x transport contract.

Capability discovery exposes:

```text
extensions.consequentialRequestReplay.version = 1
```

## Durable state

Replay receipts are Runtime-owned encrypted state:

```text
<runtime-state-root>/
  request-replay/
    <stable-record-id>.state
  request-replay.key
```

Records are AES-256-GCM encrypted at rest.

The record stores bounded coordination/receipt data, not a copy of canonical request params.

## State machine

```text
new
 -> in_progress
    -> completed
    -> failed
    -> uncertain

completed / failed
 -> expired
```

### completed

The original result is replayed without invoking the Runtime operation again.

### failed

The stored terminal error is replayed without invoking the Runtime operation again.

A caller that intentionally wants a new attempt after changing external state must use a new idempotency key.

### uncertain

If the previous Runtime owner disappeared after durable acceptance but before a terminal receipt was committed:

```text
IDEMPOTENCY_OUTCOME_UNCERTAIN
```

Runtime must not automatically execute the request again.

This is the core crash-safety invariant.

### expired

Response payload replay is retained for a bounded window. After it ages out, Runtime preserves the key/digest tombstone but does not keep the payload.

A retry returns:

```text
IDEMPOTENCY_REPLAY_EXPIRED
```

It never re-executes the original request.

## Retention

Defaults:

```text
response replay window: 7 days
maximum replay records: 10,000
maximum stored response payload: 1 MiB
```

Configuration:

```text
RUNTIME_REQUEST_REPLAY_TTL_MS
RUNTIME_REQUEST_REPLAY_MAX_RECORDS
RUNTIME_REQUEST_REPLAY_MAX_PAYLOAD_BYTES
```

Runtime does not evict old identities in a way that could permit duplicate execution.

If the configured record capacity is reached, new protected requests fail closed:

```text
IDEMPOTENCY_STORE_CAPACITY_EXCEEDED
```

This is safer than forgetting old keys and silently allowing replay.

## Conflict rules

Same session + same key + same digest:

```text
completed -> replay same result
failed    -> replay same error
active    -> join same in-process execution or report canonical in-progress owner
uncertain -> fail closed
expired   -> fail closed
```

Same session + same key + different digest:

```text
IDEMPOTENCY_KEY_CONFLICT
```

The operation is not executed.

The same key in a different logical session is a different replay scope.

## Concurrent delivery

Inside one Runtime process, duplicate concurrent requests with the same key/digest join the same Promise and execute once.

If another live Runtime process owns the replay record, Runtime returns:

```text
IDEMPOTENCY_REQUEST_IN_PROGRESS
```

It does not start a second execution.

If that owner PID is no longer alive, the state becomes `uncertain`.

## Consequential RPC classification

Read-only RPCs do not require replay storage.

Replay protection applies when an idempotency key is supplied to mutations, including:

- `primitive.call`;
- `skill.run`;
- User Skill Candidate mutations;
- User Skill registry mutations;
- Task create/run/pause/cancel/resolve/delete;
- Schedule create/cancel/delete;
- Approval approve/deny;
- mutating Process operations such as interact/claim.

Read-only Process operations list/status/observe/wait are excluded.

## Backwards compatibility

v1 is opt-in at the transport boundary.

A legacy consequential request without `x-owl-idempotency-key` continues to execute with existing semantics and receives:

```text
x-owl-idempotency-status: unprotected
```

The OWL LAB integration path must use the replay contract for consequential mutations.

A later product gate may enforce protected mutations after all consumers have migrated.

## Receipt persistence boundary

Runtime writes `in_progress` **before** invoking the consequential operation.

After success, Runtime must persist the completion receipt before reporting the protected operation as replay-safe.

If the operation returned successfully but the terminal receipt cannot be persisted:

```text
IDEMPOTENCY_RECEIPT_PERSIST_FAILED
```

Runtime attempts to mark the request `uncertain`.

It does not report a normal successful protected receipt while replay durability is unknown.

## Security

The ledger:

- is encrypted at rest;
- stores request digest rather than raw params as identity metadata;
- has a bounded response-payload size;
- is not a prompt channel;
- is not a permission grant;
- does not bypass Runtime policy, Approval, Verifier or execution ownership.

## Desktop / Cloud integration rule

For one logical Cloud RemoteCommand or Desktop mutation:

```text
idempotencyKey = stable command/logical mutation identity
requestId      = unique transport-attempt identity
```

On network loss:

1. reconnect;
2. send the exact same method/params;
3. reuse the same idempotency key;
4. use a new request ID;
5. accept canonical replay.

On `IDEMPOTENCY_OUTCOME_UNCERTAIN`:

- do not send through another backend;
- do not generate a new key to force execution;
- enter Needs Attention / reconciliation.

## Conformance

`npm run verify:request-replay` covers:

- concurrent same-process duplicate join;
- one execution for one logical key;
- digest conflict fail-closed;
- logical-session key scoping;
- terminal failure replay;
- encrypted ledger does not expose plaintext payload;
- completed response replay across process restart;
- dead Runtime owner -> uncertain without execution;
- corrupt replay record fail-closed.

The HTTP Runtime client gate additionally proves:

- repeated `tasks.create` with the same logical key returns one Task;
- changed params under the same key are rejected;
- the same key in another logical session is independent.

## Out of scope for R1

- natural-language planning;
- Execution Revision activation;
- same-execution Approval resume;
- Cloud command persistence;
- Desktop Agent Inbox state;
- automatic reconciliation of uncertain external side effects.

Those remain later Integration Closure stages.
