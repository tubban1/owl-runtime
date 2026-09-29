# Workflow Skill Discovery v1

Status: **1.x candidate / Phase 2A**

## Purpose

OWL Runtime may identify repeated successful procedures and draft a User Skill proposal.

It does **not** install, submit, test, promote, enable, or activate that proposal automatically.

The governance boundary remains:

```text
M2 terminal Task evidence
        ↓
read-only repeated-work discovery
        ↓
draft manifest + validation preview
        ↓
explicit skill-candidates.submit
        ↓
existing validation / revision
        ↓
compile-test → Persistent Task
        ↓
M2 / Verifier / privacy / quality gates
        ↓
explicit promote(confirm=true)
        ↓
immutable User Skill Registry
```

## Public extension

Feature detection:

```text
extensions.workflowSkillDiscovery.version = 1
extensions.workflowSkillDiscovery.status = candidate
```

Optional client interface:

```text
WorkflowDiscoveryRuntimeClient
```

Method:

```text
discoverWorkflowSkillCandidates(request?)
```

HTTP RPC:

```text
skill-candidates.discover-workflows
```

This is deliberately separate from the Phase 1 `UserSkillRuntimeClient` interface so an additive 1.x discovery feature does not make older Phase 1 clients source-incompatible.

## Default detection policy

Phase 2A defaults:

- minimum 3 independently completed runs;
- minimum 2 Primitive steps;
- only terminal `completed` Tasks;
- all selected steps succeeded;
- all required verification resolved;
- no unresolved side-effect step;
- M2 episode must exist with a historical evidence digest;
- `sys.exec` is excluded;
- Candidate test Tasks and promoted User Skill Tasks are excluded;
- grouping binds normalized Task label, Primitive/op dependency graph, and verification spec;
- no Candidate Store write occurs during discovery;
- no automatic promotion occurs.

The threshold is bounded and configurable for inspection, but one run is never enough.

## Parameterization

For Tasks inside one repeated group, discovery compares normalized Primitive arguments.

Stable values remain literals.

Differing scalar values become bounded User Skill inputs:

```text
3 executions:
max_count = 3
max_count = 4
max_count = 5

draft:
max_count = { "$input": "step2_max_count" }
```

Nested arrays/objects are generalized recursively only when their shape is stable.

Shape changes or unsupported heterogeneous values are not guessed. The group is returned as blocked when `includeBlocked=true`.

Phase 2A intentionally does not use an LLM inside Runtime.

## Proposal output

A proposal includes:

- stable proposal id;
- structural digest;
- source = `m2_episodic_evidence`;
- successful-run count;
- number of source runs actually used;
- distinct argument-set count;
- recovery-free run count;
- Task ids;
- episode ids;
- historical M2 evidence digests;
- inferred inputs / variable paths;
- draft User Skill manifest;
- manifest digest;
- existing deterministic User Skill validation report;
- `readyForSubmit`;
- `requiresExplicitSubmit=true`;
- `requiresTestBeforePromotion=true`;
- `autoPromoted=false`.

Provenance in the draft manifest records the source Task and M2 episode ids.

## Proposal identity and governance refresh

The structural `proposalId` remains stable for the same normalized intent/Primitive graph even when later executions add more supporting evidence.

Discovery also performs read-only Candidate/Registry lookup and annotates each proposal:

```text
governance.state = new | candidate_exists | installed
governance.exactDigestCandidateIds
governance.evidenceRefreshAvailable
governance.candidates[]
governance.installed
```

This lets Desktop/Worker treat later evidence as a refresh of the same workflow opportunity instead of repeatedly prompting for a brand-new Skill.

Important distinction:

- `proposalId` identifies the repeated workflow opportunity;
- `manifestDigest` identifies the exact current draft and its current provenance;
- `evidenceRefreshAvailable=true` means a Candidate already exists for the workflow, but newer evidence produced a different draft digest;
- `governance.state=installed` means that Skill id already exists in the immutable Registry.

`readyForSubmit` is true only when validation passes and governance state is `new`.

Discovery never revises an existing Candidate automatically when evidence refreshes.

## Historical M2 evidence identity

Important Runtime invariant:

```text
episode.evidenceDigest
= identity of evidence at M2 episode creation time

current buildTaskEvidenceReceipt(task).evidenceDigest
= identity of the Task as it exists now
```

These values are not guaranteed to remain equal.

After `indexTaskEpisode(task)` captures the M2 record, Runtime may append bookkeeping events such as `global_episode_indexed` to the Task. The Task evidence digest includes event identity, so recomputing it later can legitimately produce another digest.

Therefore discovery:

1. requires the encrypted M2 episode and its historical evidence digest;
2. independently re-checks current Task completion, step success, verification, and side-effect resolution;
3. does **not** require a later Task receipt digest to equal the historical M2 digest.

Future features should follow the same rule unless the evidence-digest algorithm is explicitly versioned to exclude post-index bookkeeping.

## Secret handling

User Skill validation now blocks obvious embedded credentials and tokens before a manifest can become an installed Skill.

This matters especially for distillation:

- a varying secret may be generalized into an input;
- a constant embedded secret remains visible in the draft;
- deterministic validation rejects the draft with `USER_SKILL_EMBEDDED_SECRET_BLOCKED`.

Secrets must be supplied through governed inputs/providers/secret facilities rather than stored in immutable Skill content.

## Non-goals for Phase 2A

Not implemented:

- semantic/LLM clustering of loosely similar trajectories;
- automatic naming beyond deterministic Task-label derivation;
- automatic Candidate submission;
- automatic repair;
- automatic replay/test execution;
- automatic promotion or activation;
- permission expansion;
- arbitrary code/plugin generation;
- Cloud marketplace/distribution.

## Next phases

### Phase 2B — Desktop review

Desktop can show:

- “Repeated workflow detected”;
- supporting runs and evidence;
- inferred inputs;
- validation warnings/errors;
- Diff/edit manifest;
- “Create Candidate” action.

The action calls normal `skill-candidates.submit`.

### Phase 2C — stronger generalization

Only after Phase 2A evidence is stable:

- similarity clustering across slightly different labels;
- richer input inference;
- duplicate detection against installed Skills;
- fixture/replay suggestions;
- confidence calibration from real accept/reject data.

These features still produce proposals, not execution authority.
