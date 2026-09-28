# Platform Integration Boundary

Status: **Normative**.

OWL Runtime is **not** the platform-wide integration coordinator.

It is the execution authority inside the OWL data plane.

## Authorities

```text
OWL Cloud
identity / device / grant / command authority
        │
        ▼
OWL Desktop
local product integration host
        │
        ▼
OWL Runtime
execution authority
```

OWL Worker is an optional Cloud/product consumer.

## Runtime integration responsibilities

Runtime must:

- expose stable public contracts
- provide provider conformance tests
- provide machine-readable Health/Diagnostics
- preserve durable execution identity
- reject invalid/unsupported execution requests clearly
- emit enough structured truth for consumers to project results safely

Runtime must not:

- coordinate Cloud account/device state
- own the Worker UX
- decide MCP transport schemas
- package every platform component into one process
- become the compatibility shim for every consumer

## E2E ownership

### Local E2E

Canonical owner: **owl-desktop**.

```text
ChatGPT → OWL MCP → RuntimeClient → OWL Runtime → Provider
```

Runtime provides conformance; Desktop proves compatibility.

### Cloud E2E

Joint owners:

- **owl-cloud** for control-plane command/identity semantics
- **owl-desktop** for Cloud Bridge and local acceptance
- **owl-runtime** for execution semantics

```text
Cloud test client / Worker
→ OWL Cloud
→ OWL Desktop Cloud Bridge
→ RuntimeClient
→ OWL Runtime
→ result projection
```

No single repo is allowed to redefine another authority's state machine.

## Final production integration

The shipped local product is OWL Desktop.

It integrates compatible versions of:

- OWL MCP
- Control
- Tunnel
- Cloud Bridge
- Helper / Runtime Host
- OWL Runtime

Runtime remains independently versioned and testable.
