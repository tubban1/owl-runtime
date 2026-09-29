# Public Runtime Event Journal + AgentRequest Producer v1

Status: **OWL Runtime 1.x candidate**

This contract implements the Runtime side of Desktop CR-DESKTOP-002 and
CR-DESKTOP-010 without changing Runtime 1.0 / rc.4 frozen semantics.

## Architecture gap

Runtime already has Task-local `PersistentTaskEvent` records and M2 episodic
evidence. Those records are task-scoped, bounded inside each Task, and have no
global monotonic sequence or reconnect cursor. They are therefore not a public
cross-consumer event stream.

Desktop must not read Task JSON, Runtime state files or diagnostics to infer
transitions.

The new boundary is:

~~~text
Runtime canonical state
        |
        v
canonical transition + transactional outbox
        |
        v
durable global public event journal
        |
        v
events.list(afterCursor)
        |
        v
OWL Desktop RuntimeAgentRequestEventConsumer
        |
        v
canonical local Agent Inbox
~~~

Runtime still owns Candidate/Task/validation/execution truth. Desktop still owns
Agent Inbox claim, lease, completion and local coordination truth.

## Public API version

This is an additive optional 1.x extension. The existing HTTP endpoint remains:

~~~text
POST /runtime/v0.1/rpc
~~~

and `RUNTIME_PUBLIC_API_VERSION` remains `0.1`.

Feature detection is exposed through capabilities:

~~~text
extensions.publicEventJournal.version = 1
extensions.agentRequestProducer.version = 1
~~~

The optional TypeScript interface is:

~~~ts
interface RuntimeEventRuntimeClient {
  listEvents(request?: RuntimeEventListRequest):
    Promise<RuntimeEventListResponse>
}
~~~

Existing `RuntimeClient`, User Skill and Workflow Discovery consumers are not
required to implement the extension.

## events.list

RPC method:

~~~text
events.list
~~~

Request:

~~~json
{
  "afterCursor": "runtime-events:41",
  "limit": 100,
  "types": [
    "agent_request.proposed",
    "agent_request.withdrawn"
  ]
}
~~~

Response:

~~~json
{
  "events": [],
  "nextCursor": "runtime-events:41",
  "hasMore": false,
  "retention": {
    "strategy": "count",
    "maxEvents": 10000,
    "oldestSequence": 1,
    "newestSequence": 41,
    "oldestCursor": "runtime-events:1",
    "newestCursor": "runtime-events:41"
  }
}
~~~

`sequence` is allocated only by the canonical journal and is strictly
monotonic. `cursor` is the durable encoding
`runtime-events:<sequence>`; it survives Runtime process restarts because the
journal state is durable.

Default page size is 100; maximum is 500.

## Exact AgentRequest event schema

### proposed

~~~json
{
  "eventType": "agent_request.proposed",
  "eventId": "evt_agent_...",
  "proposalId": "proposal_skill_...",
  "sequence": 42,
  "cursor": "runtime-events:42",
  "requestType": "skill.repair",
  "priority": "normal",
  "subject": {
    "kind": "skill_candidate",
    "id": "candidate_...",
    "revision": "2"
  },
  "reasonCode": "VALIDATION_FAILED",
  "errorCodes": [
    "USER_SKILL_INPUT_REFERENCE_UNKNOWN"
  ],
  "contextRefs": [
    {
      "kind": "validation_report",
      "id": "validation_candidate_..._r2_..."
    }
  ],
  "allowedActions": [
    "candidate.inspect",
    "candidate.revise",
    "candidate.validate"
  ],
  "requiresUserConfirmation": true,
  "dedupeKey": "runtime:agent_request_v1:skill_candidate:...:r2:...:validation_failed",
  "occurredAt": "2026-09-29T19:00:00.000Z"
}
~~~

### withdrawn

~~~json
{
  "eventType": "agent_request.withdrawn",
  "eventId": "evt_agent_...",
  "proposalId": "proposal_skill_...",
  "sequence": 43,
  "cursor": "runtime-events:43",
  "subject": {
    "kind": "skill_candidate",
    "id": "candidate_...",
    "revision": "2"
  },
  "reasonCode": "ISSUE_RESOLVED",
  "dedupeKey": "runtime:agent_request_v1:skill_candidate:...:r2:...:validation_failed",
  "occurredAt": "2026-09-29T19:01:00.000Z"
}
~~~

Schemas are strict allow-lists. Unknown fields are rejected. The public
AgentRequest journal does not accept prompt, instructions, payload, raw user
content, source code, secret/password/token, RemoteCommand payload or permission
grant fields.

It is a coordination channel, not a hidden prompt channel.

## Durable storage

The v1 journal is an encrypted AES-256-GCM Runtime-owned state snapshot:

~~~text
<runtime-state-root>/
  public-events/
    journal.state
  public-events.key
~~~

Each mutation uses a Runtime-owned cross-process lock plus write-to-temp and
atomic rename. This prevents two HTTP/MCP Runtime processes sharing a state root
from allocating the same next sequence.

A dead lock owner is reclaimable by PID liveness; an unparseable lock is only
reclaimed after a conservative stale timeout. Lock acquisition otherwise fails
closed with `PUBLIC_EVENT_JOURNAL_BUSY`.

The snapshot contains:

~~~text
journalVersion
lastSequence
retained events
updatedAt
~~~

The journal is not Task-local M2 and does not replace M2. It is a separate
public projection plane with a separate schema version.

The initial payload-retention policy is count-based and defaults to 10,000
events. Retention is bounded before persistence.

The journal also keeps a payload-free event receipt:

~~~text
eventId -> original sequence + canonical event digest
~~~

after an event payload ages out. This is required for cross-file outbox crash
recovery: a delayed replay of the same stable eventId returns its original
sequence and is never reintroduced under a new sequence. Without this receipt,
Desktop's frozen duplicate-event rule could correctly no-op the repeated
eventId but then observe an artificial sequence gap on the following event.

Receipts contain no prompt/content payload. v1 retains them as replay-safety
metadata; future receipt compaction requires an explicit producer/outbox
watermark and must not be inferred from payload retention alone.

A damaged journal fails closed with:

~~~text
PUBLIC_EVENT_JOURNAL_CORRUPT
~~~

It is never interpreted as an empty journal.

## Cursor retention semantics

If a consumer cursor is older than the retained floor, Runtime returns an
explicit failure containing:

~~~text
CURSOR_EXPIRED: RETENTION_GAP
~~~

Runtime never silently starts at the latest event.

A cursor ahead of canonical state fails with `CURSOR_AHEAD`.

Consumers therefore know whether replay is complete.

## Atomicity model: canonical state + transactional outbox

The User Skill Candidate Store already commits one encrypted Candidate record
with atomic rename. The global state-schema migration journal is a migration
mechanism, not a general multi-record transaction database.

For that reason v1 does not attempt an unsafe naked double-write of:

~~~text
candidate file
+
event journal
~~~

Instead each Candidate record has an optional durable public-event outbox.

Validation does:

~~~text
1. compute deterministic validation result
2. write validation state + pending event intent into one Candidate commit
3. append pending event to global public journal
4. mark outbox entry published
~~~

Crash after step 2:

~~~text
canonical state exists
pending outbox survives
next events.list reconciliation publishes the event
~~~

Crash after step 3 before step 4:

~~~text
journal already has stable eventId
outbox still says pending
reconciliation append is idempotent by eventId
outbox becomes published
~~~

Thus a committed canonical issue cannot permanently lose its proposal event and
a published event cannot be duplicated by recovery.

Event publication does not precede the Candidate commit, so a rolled-back
canonical transition cannot leak a public proposal.

## Stable identity

`proposalId` is a deterministic hash of:

~~~text
producer contract version
subject kind
subject id
candidate revision
candidate digest
reason class
~~~

The same canonical issue therefore receives the same proposal identity after
retry/restart. A later Candidate revision is a distinct issue even if its
manifest intentionally returns to an earlier digest.

`dedupeKey` includes:

~~~text
producer contract version
subject kind
subject id
candidate revision
full candidate digest
reason class
~~~

It deliberately excludes random event identity.

`eventId` is also deterministic for the proposal + event type, making outbox
replay idempotent.

## First producer decision rules

The first producer is intentionally conservative and exists only on
`skill-candidates.validate`.

A proposal is created only when deterministic validation finds one of these
semantic-repair classes:

~~~text
USER_SKILL_PRIMITIVE_ABI_UNSUPPORTED
USER_SKILL_EMBEDDED_SECRET_BLOCKED
~~~

The event includes only the selected machine-readable error codes. Its
`contextRefs` points back to the canonical `skill_candidate` with the exact
revision, which Desktop can dereference through the existing
`skill-candidates.get` public API. Runtime does not emit a synthetic
`validation_report` identifier that clients would have to parse or guess.

The event does not copy manifest/source content.

No AgentRequest is produced for normal schema errors, invalid Primitive-op
typos, unknown input/step references, deterministic contract normalization,
ordinary metadata mistakes, deterministic retries, Approval, permission
escalation, or forbidden capability attempts such as `sys.exec`.

This is intentionally narrower than the set of all validation failures.
Additional error classes may be promoted to the semantic producer only after
they have a deterministic classifier showing Runtime cannot safely normalize
or resolve them itself.

Runtime has no LLM in this producer.

## Withdrawal rules

When a proposed Candidate revision no longer represents the current canonical
issue, Runtime emits `agent_request.withdrawn` for the exact proposal.

Examples:

~~~text
candidate r2 invalid -> proposed(r2)

r2 revised to r3
-> withdrawn(r2)

validate r3 and still semantic-invalid
-> proposed(r3)
~~~

Dismissal also withdraws an outstanding current-revision proposal.

Repeated validate/revise/dismiss and restart reconciliation are idempotent.

Desktop remains responsible for its frozen rule that a withdrawal cancels only
a matching still-pending request. Runtime does not know or mutate Desktop claim
state.

## Security boundary

The producer never grants permission. `allowedActions` describes coordination
operations only. Each later Runtime mutation is independently re-authorized by
the normal Runtime APIs, policy, Approval, ResourceArbiter, Verifier and Skill
promotion gates.

AgentRequest completion does not imply Runtime success.

## Desktop exact integration

Desktop should construct an HTTP Runtime client with its stable logical
`x-owl-session-id`, then poll:

~~~ts
const page = await runtime.listEvents({
  afterCursor: durableCursor,
  limit: 100,
  types: [
    "agent_request.proposed",
    "agent_request.withdrawn"
  ]
})
~~~

Feed `page.events` in returned sequence order into the existing
`RuntimeAgentRequestEventConsumer`.

Desktop must advance its durable Runtime cursor to `page.nextCursor` only
after every returned event was accepted by the consumer. If one event is
rejected, do not acknowledge past it.

On `CURSOR_EXPIRED / RETENTION_GAP`, fail closed and enter an explicit
reconciliation/operator path. Do not jump to the newest cursor.

Desktop must not read Runtime state files, Task JSON or diagnostics.

Polling is the v1 transport. SSE/WebSocket can be added later without changing
the event consumer contract.

### v1 filter constraint

The v1 public journal currently contains only the two AgentRequest event types.
Desktop should request both types together. Runtime v1 rejects a partial filter
with `EVENT_LIST_TYPE_FILTER_INCOMPLETE_CHANNEL`; silently filtering one of
the two types could manufacture a sequence gap for Desktop's strict consumer.

If unrelated public event families are added later, the contract must define
channel/partition ordering before a filtered stream can be fed to a consumer
that requires globally contiguous sequence numbers.

## State schema compatibility

This 1.x extension adds its own sidecar state with journal version 1 and an
optional field on 1.x Candidate records. It does not transform Runtime 1.0/rc.4
state and therefore does not require changing the existing global
`CURRENT_STATE_SCHEMA_VERSION`.

A future change that transforms pre-existing canonical state must use the
governed Runtime state migration registry.

## Conformance gate

`npm run verify:public-events` covers:

- durable monotonic sequence;
- cursor replay;
- Runtime process restart recovery;
- duplicate proposal suppression;
- withdrawal replay suppression;
- stale Candidate digest rejection;
- changed Candidate revision/digest identity;
- explicit cursor expiration/retention gap;
- corrupt journal fail-closed;
- strict prompt/instructions/payload/secret/permission-field rejection;
- invalid Primitive-op typo remains a normal validation error;
- permission escalation not converted into semantic work;
- embedded-secret repair proposal contains no secret value;
- state-commit / event-append crash boundary;
- journal-append / outbox-ack crash boundary;
- four concurrent Runtime writer processes with one gap-free global sequence;
- public Runtime RPC `events.list`.

Task-local M2 remains unchanged.
