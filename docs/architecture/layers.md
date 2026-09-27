# AgentOS Runtime Layers

AgentOS separates planning, reusable workflows, stable execution primitives, side-effect contracts, providers, durable state, and orchestration.

```text
Planner / ChatGPT
        ↓
L2 Skill
        ↓
L1 Primitive ABI
        ↓
L0.5 Action + Contract
        ↓
L0 Provider / Driver
        ↓
Environment
```

Cross-cutting Runtime planes:

```text
Execution Context
├─ MCP transport session (audit/control)
├─ Task owner
├─ Process owner
└─ Transaction owner

Orchestration
├─ Persistent Task
├─ Scheduler
└─ Loop Controller

Memory
├─ M0 Working
├─ M1 Staging
├─ M2 Episodic
└─ M3 Semantic

Governance
├─ Resource Arbiter
├─ Workspace Leases
├─ Permissions
├─ Audit
└─ Side-effect receipts
```

The important rule is that transport identity is not durable workflow identity. Long-lived work is owned by Task, Process, or Transaction IDs.

See [Concurrency and ownership](concurrency-and-ownership.md) for details.
