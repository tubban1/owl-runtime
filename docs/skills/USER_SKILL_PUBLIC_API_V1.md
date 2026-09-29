# User Skill Public API v1

Status: **1.x candidate extension**

This document defines the optional public User Skill lifecycle extension for OWL Runtime.

The base `RuntimeClient` v0.1 remains valid for existing consumers and mocks.

## Feature detection

Consumers should call `getCapabilities()` and require:

```text
extensions.userSkillRegistry.version = 1
extensions.userSkillRegistry.status = candidate
```

If this extension is absent, Desktop may show read-only built-in Skill catalog UX but must not claim install/update/candidate lifecycle support.

## Client interface

Supporting Runtime clients implement:

```text
UserSkillRuntimeClient
```

The concrete in-process and HTTP Runtime clients implement both:

```text
RuntimeClient
+
UserSkillRuntimeClient
```

This avoids turning an additive 1.x feature into a source-breaking requirement for every existing RuntimeClient mock.

## Candidate governance

Public methods:

```text
submitSkillCandidate
listSkillCandidates
getSkillCandidate
reviseSkillCandidate
validateSkillCandidate
dismissSkillCandidate
compileSkillCandidateTest
inspectSkillCandidate
promoteSkillCandidate
```

HTTP RPC namespaces:

```text
skill-candidates.submit
skill-candidates.list
skill-candidates.get
skill-candidates.revise
skill-candidates.validate
skill-candidates.dismiss
skill-candidates.compile-test
skill-candidates.inspect
skill-candidates.promote
```

## Registry management

Public methods:

```text
listUserSkills
getUserSkill
enableUserSkill
disableUserSkill
activateUserSkillVersion
rollbackUserSkill
uninstallUserSkill
```

HTTP RPC namespaces:

```text
user-skills.list
user-skills.get
user-skills.enable
user-skills.disable
user-skills.activate-version
user-skills.rollback
user-skills.uninstall
```

## Test execution

There is intentionally no second Candidate test executor.

```text
candidate.compile-test
        ↓
returns Persistent Task id
        ↓
tasks.run
tasks.get
tasks.resolve
```

This preserves the existing Runtime execution/recovery/evidence model.

## Validation

Validation is deterministic and machine-readable.

A report includes:

- candidate digest;
- target Skill ABI;
- Runtime/required Primitive ABI;
- field/path;
- stable error code;
- required value;
- allowed values;
- allowed/required Primitives;
- derived execution contract;
- warnings.

ChatGPT or Worker may use the report to revise a Candidate.

They may not mark validation PASS.

## Promotion

Promotion requires:

- exact current Candidate digest;
- bound Persistent Test Task;
- completed execution;
- M2 evidence digest;
- quality gate PASS;
- privacy gate PASS;
- resolved verification for required steps;
- no unresolved side effect;
- explicit confirmation.

The installed Registry version stores the exact manifest associated with the tested Candidate digest.

## Versioning

Installed Skill versions are immutable.

```text
update
= install new version

rollback
= activate previous immutable version
```

A different digest cannot overwrite an existing `skillId@version`.

## Execution

A promoted User Skill remains governed by existing Runtime execution boundaries:

```text
User Skill
→ Primitive graph
→ Persistent Task
→ Approval
→ Workspace ownership
→ ResourceArbiter
→ Provider
→ Observation
→ Verifier
→ M2
```

User Skills cannot call provider internals directly.

## Relationship to memory

```text
M2 Episodic Memory
!=
M3 Semantic Memory
!=
User Skill Registry
```

M2/M3 may provide evidence or reusable knowledge.

Neither may silently activate an executable User Skill.

## Compatibility

This extension is additive to the base RuntimeClient contract.

Consumers must feature-detect it rather than assume every Runtime 1.0-compatible client implements it.
