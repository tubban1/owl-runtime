# Provider Postconditions v1

Status: **normative 1.0 behavior**.

OWL Runtime separates **action completion** from **business-success verification**.

A provider returning successfully means only that the provider operation returned. It does not automatically mean the user's intended outcome occurred.

## Rule

For every 1.0 action whose contract has `requiresVerification=true`, Runtime must produce one of:

- a deterministic `verified` / `failed` Verification receipt; or
- an explicit `uncertain` Verification receipt that requires review or an explicit semantic verification spec.

The old compatibility behavior where a verification-required Browser/Desktop action could produce no receipt is not allowed for the 1.0 Browser/Desktop mutation set.

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

Observation failure after a side-effecting Browser/Desktop action produces `state=unknown` evidence and an `uncertain` verification result. Runtime must not silently auto-replay a non-idempotent side effect.

## 1.0 conformance evidence

- Browser `type` deterministic verification;
- Browser `upload` deterministic verification;
- Browser explicit click postcondition verification;
- Browser generic click → `uncertain` / Task `needs_review`;
- Browser submit-type → `uncertain` / Task `needs_review`;
- Browser request cancellation and provider recovery;
- Desktop clipboard-write deterministic verifier;
- Desktop generic input → `uncertain`;
- Desktop observation failure remains `uncertain`;
- real desktop permissions are not required by the verifier-only conformance test.
