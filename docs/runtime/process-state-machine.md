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
