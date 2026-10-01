# Provider Postconditions v1

Status: **normative 1.0 behavior**.

OWL Runtime separates **action completion** from **business-success verification**.

A provider returning successfully means only that the provider operation returned. It does not automatically mean the user's intended outcome occurred.

## Rule

For every action whose contract has `requiresVerification=true`, Runtime must produce one of:

- a deterministic `verified` / `failed` Verification receipt; or
- an explicit `uncertain` Verification receipt that requires review or an explicit semantic verification spec.

A verification-required action must never silently fall back to `verification=null`.

The release gate enumerates the live Action Router catalog and fails if any `requiresVerification=true` action lacks a default VerificationReceipt path.

## Filesystem

Filesystem mutation verification must re-observe persisted state. The mutation return value is not sufficient evidence.

### `fs.mkdir`

Runtime re-stats the path and verifies:

- the path exists;
- the observed type is `directory`.

### `fs.write`, `fs.append`, `fs.edit`

The mutation layer computes the deterministic expected final content SHA-256.

After the mutation, Runtime independently re-reads the persisted file and computes the observed SHA-256.

Verification compares expected and observed content identity. `fs.write` additionally checks persisted byte size.

Raw file content does not need to be duplicated inside the Verification receipt.

### `fs.batch_edit`

The batch edit implementation computes the deterministic final SHA-256 for every changed file.

After all writes, Runtime independently re-reads each unique file and verifies every observed digest equals its expected final digest.

A batch is not verified merely because a `files` array exists.

### `fs.copy`

Runtime re-observes source and destination.

For files, Runtime computes both SHA-256 digests and verifies they match. For non-file paths, existence/type evidence remains available, but callers that require stronger directory-tree equivalence should attach an explicit semantic postcondition.

### `fs.move`

Runtime verifies:

- the destination exists; and
- the source path no longer exists.

### `fs.delete`

Runtime verifies the target path is absent.

## Git

Git mutation verification re-queries repository state after the command instead of trusting Git process stdout alone.

### `git.add`

Runtime verifies:

- the mutation process exited successfully;
- repository status can be re-read;
- staged diff can be re-read.

An empty staged diff can be valid when the requested paths already match the index, so non-emptiness is not a universal postcondition.

### `git.commit`

Runtime re-reads local `HEAD` and verifies:

- commit process success;
- repository status remains readable;
- `HEAD` log is readable;
- the observed commit subject contains the requested first-line message.

### `git.patch`

Runtime verifies the patch process exited successfully and that the repository exposes a post-mutation working/staged/status change.

### `git.pull`

Runtime verifies the pull process exited successfully and local `HEAD` can be re-observed afterward.

This proves the local repository state after pull. It does not independently certify every remote server property.

### `git.push`

A successful local `git push` process is **not** independent proof of the intended remote-ref state.

Default verification is therefore `uncertain` even when exit code is zero.

Autonomous consequential workflows that require verified remote publication must provide an explicit remote postcondition or a future remote-ref verifier.

## Shell and managed processes

### `shell.start`

The action-level postcondition is deterministic: the newly created durable managed process must be re-observable as `running` with the same `processId`.

This verifies process launch, not the later business outcome of the long-running process.

### `shell.exec`

Runtime records a process Observation containing:

- terminal state;
- exit code;
- timeout state;
- signal;
- stdout/stderr;
- stdout/stderr SHA-256 and character counts.

A non-zero exit or timeout can deterministically fail the default verifier.

A zero exit code proves **execution completion only**. Because an arbitrary shell command may affect files, services, deployments, messages, network systems, or other external state, default business verification remains `uncertain`.

Therefore a durable Task containing generic `shell.exec` without a semantic postcondition enters `needs_review`.

To make such a Task autonomous, the Task must state an explicit postcondition—for example expected stdout, file digest, service health, remote object identity, or another independently observable outcome.

## Browser

### `browser.type`

When `submit=false`, Runtime re-observes the target control and verifies the exact value using value length + SHA-256. Raw typed content is not copied into the postcondition Observation.

When `submit=true`, default verification is `uncertain`: pressing Enter may submit, navigate, or replace the target control. The caller should provide a semantic postcondition for the intended result.

### `browser.upload`

Runtime re-observes the file input and verifies the selected file count equals the requested file count. The postcondition Observation does not need to expose local file paths.

### `browser.click`

A generic click has no universal business-success postcondition. Default verification is therefore `uncertain`.

Callers should attach an explicit verification spec such as visible confirmation text, URL change, DOM state, or another deterministic business postcondition.

### Cancellation

Pending Browser navigation/click/type/upload operations observe Runtime request cancellation. Runtime closes the active page to interrupt the pending Playwright operation and can subsequently create/reuse a healthy page.

Cancellation does **not** assert that a side effect was rolled back. A cancelled side-effecting browser action must be re-observed before any retry decision.

## Desktop

### `desktop.clipboard_write`

Runtime can deterministically verify the clipboard using character count + SHA-256 without persisting raw clipboard content in the Verification Observation.

### `desktop.click`, `desktop.type`, `desktop.key`, `desktop.click_element`

Generic desktop input has no universal application-level success condition. Default verification is `uncertain` and requires either:

- an explicit semantic verification spec; or
- human/planner review of subsequent Observation evidence.

Frontmost-app observation is evidence, not proof that the intended application state changed.

## Fail-closed principle

Observation failure after a side-effecting action must not be converted into success merely because the underlying tool call returned.

For actions whose business outcome cannot be inferred generically, Runtime records evidence and returns `uncertain`.

Runtime must not silently auto-replay a non-idempotent side effect whose outcome is uncertain.

## Coverage invariant

Current release-gated verification-required Action Router surface:

```text
browser.click
browser.type
browser.upload
desktop.click
desktop.click_element
desktop.clipboard_write
desktop.key
desktop.type
fs.append
fs.batch_edit
fs.copy
fs.delete
fs.edit
fs.mkdir
fs.move
fs.write
git.add
git.commit
git.patch
git.pull
git.push
shell.exec
shell.start
```

The list is derived from the live Router catalog by the verifier rather than maintained as a second source of truth.

`verify:verification-coverage` fails if any current or future `requiresVerification=true` action produces no default receipt.

## Conformance evidence

Release-gated evidence includes:

- filesystem write/append/edit content-digest verification;
- batch-edit per-file final digest verification;
- file-copy digest equivalence and move source absence;
- delete absence verification;
- Git add/commit/patch re-observation;
- Git pull local-HEAD re-observation;
- Git push success → `uncertain` without independent remote-ref proof;
- managed process start re-observation;
- generic shell success → `uncertain`;
- non-zero shell exit → failed verification;
- durable shell Task without semantic postcondition → `needs_review`;
- durable shell Task with explicit postcondition → verified/completed;
- Browser type deterministic verification;
- Browser upload deterministic verification;
- Browser explicit click postcondition verification;
- Browser generic click → `uncertain` / Task `needs_review`;
- Browser submit-type → `uncertain` / Task `needs_review`;
- Browser request cancellation and provider recovery;
- Desktop clipboard-write deterministic verifier;
- Desktop generic input → `uncertain`;
- Desktop observation failure remains `uncertain`;
- real desktop permissions are not required by the verifier-only conformance test.
