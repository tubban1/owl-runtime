# Task Orchestration Metadata V1

Status: Runtime 1.x additive public metadata contract.

## Purpose

A durable Task remains the Runtime execution/state authority.

Orchestration metadata provides only a stable correlation boundary so product
surfaces can answer a separate question:

> Which durable Tasks belong to the same user goal or workset?

It does not introduce a second scheduler, workflow engine, planner, or Task
state machine.

## Internal shape

```ts
type PersistentTaskOrchestration = {
  orchestrationId: string;
  label?: string;
  parentTaskId?: string;
};
```

## Public Task projection

Task list and detail expose:

```json
{
  "orchestration": {
    "schemaVersion": 1,
    "orchestrationId": "orch_release_20261001",
    "label": "OWL LAB release validation",
    "parentTaskId": null
  }
}
```

Legacy Tasks or callers that do not opt in expose:

```json
{ "orchestration": null }
```

Products MUST NOT infer orchestration membership from ownerSessionId when the
explicit field is absent. One logical session may perform many unrelated goals.

## Public creation contract

RuntimeClient uses camelCase:

```ts
orchestration?: {
  orchestrationId: string;
  label?: string;
  parentTaskId?: string;
}
```

Built-in Skill inputs accept the existing MCP/Skill snake_case style:

```json
{
  "orchestration": {
    "orchestration_id": "orch_release_20261001",
    "label": "OWL LAB release validation",
    "parent_task_id": "task_parent"
  }
}
```

Supported built-in producers:

- runtime.compile_task
- runtime.schedule
- runtime.loop

Schedule occurrence Tasks and Primitive-backed Loop phase Tasks inherit the
persisted orchestration metadata automatically.

## Validation

Runtime normalizes metadata before creating Task identity or staging state.

Rules:

- orchestrationId is required when the orchestration object is supplied;
- leading/trailing whitespace is removed;
- orchestrationId max 160 characters;
- label max 240 characters;
- parentTaskId max 200 characters;
- control characters are rejected.

Invalid metadata fails before durable Task/staging side effects.

## Parent semantics

parentTaskId is descriptive hierarchy metadata only.

It does not:

- add a Task dependency;
- grant ownership;
- authorize execution;
- change retry/recovery;
- imply cancellation propagation.

Step dependencies remain inside the canonical Task DAG.

## Product use

Desktop Monitor may aggregate Tasks with the same explicit orchestrationId into
one Goal/workset summary.

The selected Task still owns its own:

- Step DAG;
- VerificationReceipts;
- approvals;
- evidence;
- Process state;
- recovery lifecycle.

## Acceptance

Permanent gate:

```text
npm run verify:task-orchestration
```

The gate proves:

- RuntimeClient roundtrip;
- legacy null projection;
- parent metadata;
- Skill snake_case input;
- Schedule Task inheritance;
- Loop Task inheritance;
- fail-closed validation;
- list/get workset grouping.
