# Managed Process State Machine

Status: **v1 candidate**.

OWL Runtime keeps the existing encrypted process record format compatible while deriving richer realtime state from the durable record, current PID, live stdin attachment, and recent stdout/stderr.

```text
durable record + PID + logs + live attachment
                  ↓
            process.observe
                  ↓
 running / waiting_input / terminating
 finished / failed / lost
```

## Why derived state

Existing `computer-mcp` process records persist `running`, `exited`, `lost`, or `terminating`. Rewriting every durable record just to add richer UX state would create an unnecessary migration risk. OWL Runtime therefore treats those values as durable facts and derives Worker-facing runtime state at observation time.

## Runtime process operations

The existing `runtime.process` Skill now supports:

- `list` — durable process inventory
- `status` — compatibility status/output response
- `observe` — provider-neutral Observation ABI response
- `wait` — bounded wait for states such as `waiting_input`, `finished`, `failed`, or `lost`
- `interact` — write stdin and wait for the next meaningful state
- `claim` — explicitly claim a recovered/orphaned process

`wait` is deliberately bounded to 60 seconds. Long monitoring belongs to the persistent Scheduler/Loop layer, not to one long MCP request.

## Waiting for input

`waiting_input` is a heuristic state. It requires a live stdin attachment and a recognized recent prompt pattern. The Observation records `confidence=heuristic`. Exit/failure/lost states are deterministic.

`waiting_network` remains reserved in Observation ABI for providers that can supply reliable network-wait evidence; the shell runtime does not guess it from silence.

## Interaction freshness and exit reconciliation

`runtime.process interact` must not treat the same pre-existing prompt as proof that a newly submitted input completed. Runtime snapshots stdout/stderr before writing stdin and accepts `waiting_input` only after output has changed and a new prompt is observed. Terminal states (`finished`, `failed`, `lost`) may complete the interaction immediately.

For children started by the current Runtime instance, the live `ChildProcess` lifecycle is authoritative during the narrow OS-exit / durable-record-update window. Runtime must not classify such a child as `lost` merely because a PID probe turns false before the asynchronous exit handler persists `exited`. Before declaring a process lost, Runtime also re-reads the durable record to avoid overwriting a concurrent exit update.

The conformance verifier exercises a two-turn interaction (`READY>` → `NEXT>` → exit) repeatedly so stale-prompt and false-`lost` races remain regression-tested.

## Process control capability

A managed process now receives a random process-scoped control capability when it is started. The raw token is returned only to the caller; Runtime persists only its SHA-256 hash and redacts `control_token` from audit payloads.

Normal control still follows logical session/task ownership. The capability exists for a narrower recovery case: a trusted consumer reconnects with a different transport/session identity but still holds the process-scoped capability.

With the valid capability, the consumer may:
- send process input;
- terminate the process;
- explicitly claim/rebind ownership.

Without ownership or the capability, Runtime returns `PROCESS_OWNED`.

This avoids the unsafe alternative of globally weakening process ownership after transport reconnects. Legacy process records without a capability hash remain readable and continue to use the prior ownership/recovery rules.
