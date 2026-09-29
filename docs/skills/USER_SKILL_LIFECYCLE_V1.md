# User Skill Lifecycle v1

Status: **1.x design baseline**  
Current Runtime 1.0 behavior remains unchanged.

## Current state

OWL Runtime already has a Skill ABI and built-in Skill catalog.

Today:

- Skills are defined statically in `src/skills/skillRuntime.ts`;
- Skill metadata is compiled into the Runtime;
- built-in Skills declare Primitive ABI dependencies, risk, side effects, resources, retry policy, execution mode, and memory policy;
- Skills execute through Runtime governance, Approval, Resource Arbiter, Primitive ABI, and Verifier;
- durable Skills may compile Primitive graphs into Persistent Tasks;
- semantic memory promotion is explicit and auditable.

Current limitation:

> A normal user cannot install a new production Skill without changing Runtime code and rebuilding/releasing Runtime.

That is acceptable for 1.0, but should change in 1.x.

## Design goal

A user should be able to add reusable capabilities without turning Runtime into an arbitrary-code plugin host.

Preferred v1 model:

```text
User Skill
=
Declarative Skill Manifest
+
Primitive Graph / Task Template
+
Input Schema
+
Risk / Side-effect Contract
+
Verification Contract
+
Version / Provenance
```

The first user-installable Skill format should be declarative, not arbitrary JavaScript.

## Skill classes

### 1. Built-in Runtime Skill

Examples:

- runtime.schedule
- runtime.workspace
- runtime.process

Properties:

- shipped with Runtime;
- trusted Runtime code;
- generic execution semantics;
- Runtime release lifecycle.

### 2. User / Workspace Skill

Examples:

- "download yesterday's sales report";
- "prepare weekly project report";
- "publish approved content to a specific CMS".

Properties:

- declarative Primitive graph;
- installed in Runtime Skill Registry;
- user/workspace/device scope;
- cannot call L0.5 Actions or providers directly;
- executes under normal Runtime approval/resource/verification policy.

This should be the main 1.x extensibility path.

### 3. Native / Code Plugin

A plugin containing arbitrary executable code or a new provider/driver.

This is a different trust class.

It should NOT be silently treated like a user Skill.

Code plugins require stronger packaging/signing/isolation and are a later capability.

## Proposed Skill Package v1

Illustrative structure:

```json
{
  "schemaVersion": 1,
  "id": "user.sales.daily_report",
  "version": "1.0.0",
  "scope": "user",
  "title": "每日销售报告",
  "description": "下载昨日销售数据并生成报告",
  "inputs": {
    "date": { "type": "string" }
  },
  "requiredPrimitiveAbi": 1,
  "requiredPrimitives": [
    "web.open",
    "web.query",
    "fs.write"
  ],
  "executionMode": "durable",
  "contract": {
    "riskLevel": "medium",
    "idempotent": true,
    "sideEffects": ["file_creation"],
    "requiresVerification": true,
    "retryPolicy": "automatic",
    "resources": []
  },
  "steps": [],
  "verification": {},
  "provenance": {
    "origin": "user",
    "digest": "..."
  }
}
```

Exact schema should be frozen only after implementation evidence.

## Installing a new Skill

Recommended user flow:

```text
User / ChatGPT / Desktop
      ↓
Select or provide Skill package
      ↓
Runtime inspect
      ↓
Schema + ABI + Primitive dependency validation
      ↓
Risk / permission / verification review
      ↓
Dry-run / contract plan
      ↓
User confirms install
      ↓
Immutable Skill version stored in Runtime registry
      ↓
Skill becomes visible in capability catalog
```

### Validation gates

Before installation:

1. unique namespaced Skill ID;
2. valid semantic version;
3. compatible Primitive ABI;
4. every required Primitive exists;
5. no direct provider/L0.5 Action calls;
6. declared side effects and risk contract;
7. verification requirement is compatible with side effects;
8. input schema is bounded;
9. package digest/provenance is recorded;
10. no secret material embedded in the manifest.

### Update

A Skill update creates a new immutable version.

Do not mutate an installed version in place.

```text
1.0.0
→ inspect 1.1.0
→ test
→ activate 1.1.0
→ retain rollback to 1.0.0
```

## Where Skills live

Execution truth belongs to Runtime.

Suggested separation:

```text
Runtime Skill Registry
= what is installed and executable on this device

Cloud Skill Library
= optional package distribution/sync/catalog

Desktop
= install/review/manage UX
```

Cloud may distribute an immutable Skill package by digest, but Runtime performs local validation before installation.

Cloud cannot directly edit Runtime Skill Registry files.

## How a user's own Skill can be learned

Yes — OWL should be able to **distill** repeated successful work into reusable Skill candidates.

But "automatic learning" must not mean:

> one successful task → silently create and activate a trusted Skill.

The safe pipeline is:

```text
Real Tasks
   ↓
M2 Episodic evidence / Task events
   ↓
Repeated successful procedure detection
   ↓
Procedure candidate
   ↓
Parameterize variable inputs
   ↓
Compile Primitive graph
   ↓
Infer draft risk / side effects / verification
   ↓
Quality + privacy + compatibility gates
   ↓
Replay / dry-run / fixture tests
   ↓
User Skill Candidate
   ↓
User review / confirm
   ↓
Installed Skill version
```

## What can be automatic

Recommended defaults:

### Automatic

- capture Task/episode evidence;
- detect repeated procedures;
- cluster similar successful trajectories;
- propose reusable parameters;
- generate a draft declarative Skill;
- run static ABI/dependency validation;
- run safe dry-run/fixture tests;
- detect duplicates;
- suggest a Skill to the user.

### Not automatic by default

- semantic promotion from a single successful run;
- production activation of a newly generated Skill;
- permission expansion;
- arbitrary code generation into the trusted Runtime;
- new provider/driver installation;
- auto-activation of high-risk/non-idempotent Skills.

## Relationship to current memory system

Current Runtime already supports:

```text
M2 Task/Episodic evidence
       ↓
quality + privacy gates
       ↓
explicit M3 semantic promotion
```

A procedure can be promoted as semantic memory:

```text
kind = "procedure"
```

This is useful knowledge, but **Semantic Memory is not yet an executable Skill**.

Important separation:

```text
Procedure Memory
= "we learned how this tends to be done"

Skill
= "Runtime has a versioned, validated executable contract for doing it"
```

The future Skill Distiller may consume procedure memories plus raw Task evidence, but installation still requires Skill gates.

## Evidence threshold

Do not hard-code "one success is enough".

Candidate confidence should consider:

- number of successful executions;
- diversity of inputs/context;
- verification success rate;
- retries/recoveries required;
- whether side effects were idempotent;
- whether the same Primitive structure recurs;
- whether results generalized beyond one exact file/page/session.

The exact threshold should be evidence-driven.

## Example

A user repeatedly asks:

> 打开某个后台，下载昨天的销售 Excel，整理成固定格式，然后保存到日报目录。

Initial executions may be planned individually by ChatGPT:

```text
web.open
→ web.act
→ web.transfer
→ fs.read
→ fs.write
→ verify
```

After repeated verified successes, OWL can detect the stable procedure and propose:

```text
Skill candidate:
user.sales.daily_report

Inputs:
- date
- account/profile
- output directory

Risk:
medium

Execution:
durable

Verification:
download exists
report exists
report schema valid
```

The user sees:

> "你已经成功执行过这个流程多次。要保存为『每日销售日报』Skill 吗？"

Confirming installs the versioned Skill.

The next time, ChatGPT does not need to reconstruct the entire procedure from scratch.

## Capability discovery

Installed Skills should appear through the same capability discovery path as built-ins, but future Governed Capability Manifest should filter them by:

- installed version;
- required Primitive availability;
- provider health;
- permissions;
- policy;
- ExecutionTarget;
- scope;
- integrity/digest status.

A Skill being installed does not guarantee it is currently runnable.

## Deletion / disable / rollback

User must be able to:

- disable a Skill;
- uninstall a Skill;
- inspect source/provenance;
- pin a version;
- roll back a version;
- see required capabilities and risk;
- see which Tasks/evidence produced an auto-distilled candidate.

Historical Task evidence remains governed by its own retention rules.

## 1.x sequencing

Recommended order:

### 1.1 / early 1.x

- define declarative Skill Package;
- Runtime Skill Registry;
- inspect/install/enable/disable/list;
- Skill compatibility/integrity checks;
- Desktop Skill management UI.

### Later 1.x

- Skill Candidate store;
- repeated-procedure detection;
- trajectory clustering;
- automatic draft generation;
- replay/generalization testing;
- optional Cloud Skill Library sync.

### Later / stronger isolation required

- arbitrary code plugins;
- self-modifying provider code;
- autonomous source repair.

## Core safety invariant

OWL may automatically **learn that a reusable procedure probably exists**.

OWL may automatically **draft and test a candidate**.

OWL should not silently turn that candidate into a new trusted production capability with broader side effects.

The promotion boundary remains explicit, auditable, versioned, and reversible.


## 1.x Phase 1 implementation refinement

The implementation evaluation tightened the original proposal in four places:

1. `candidate.test` is not a second execution API. `skill-candidates.compile-test` returns a normal Persistent Task and the caller uses existing `tasks.run/get/resolve`.
2. Candidate and Registry mutations reuse Runtime `ResourceArbiter` governance locks plus digest-bound revisions; no separate lock/CAS engine is introduced.
3. Phase 1 declarative User Skills reject the `sys.exec` arbitrary-shell escape hatch even though it is an L1 Primitive. Arbitrary executable code belongs to the later native/code-plugin trust class.
4. Promotion binds the exact candidate digest to a real Persistent Test Task and the existing M2 evidence digest. M3 Semantic Memory remains independent and is never auto-created by Skill promotion.

Public 1.x namespaces are:

- `skill-candidates.submit/list/get/revise/validate/dismiss/compile-test/inspect/promote`
- `user-skills.list/get/enable/disable/activate-version/rollback/uninstall`

Existing `skills.catalog` and `skill.run` remain the discovery/execution surface after promotion.
