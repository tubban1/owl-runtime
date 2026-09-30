# Observation ABI

Status: **v1 candidate**.

OWL Runtime normalizes environment state into a provider-neutral Observation envelope before planner or verifier logic consumes it. The provider may still attach source-specific detail under `data` and `evidence`; the envelope itself remains stable.

```text
Provider / Driver
      ↓
Observation ABI
      ├─ channel
      ├─ state
      ├─ data
      └─ evidence
      ↓
Planner / Verifier / Trace
```

## Channels

- `ui` — desktop Accessibility/window/visual state
- `web` — DOM/accessibility/text/screenshot state
- `process` — managed process output and lifecycle state
- `file` — content/metadata/structured-file state
- `environment` — permissions, connectivity, active application, provider state

## Common states

`ready`, `running`, `waiting_input`, `waiting_network`, `terminating`, `finished`, `failed`, `timed_out`, `lost`, `unknown`.

This vocabulary is intentionally broader than the current managed-process store. The process state-machine work can adopt it incrementally without changing the Observation ABI.

## Evidence

Evidence is typed separately from normalized `data`. Current evidence kinds include DOM, Accessibility, text, screenshot, stdout/stderr, exit code, file metadata/content, system evidence, and generic structured evidence.

An Observation is evidence about state, not proof that an intended side effect succeeded. Verification is a separate contract built on top of one or more Observations.

## Compatibility rule

Provider-specific selectors, OCR details, Playwright objects, AX node formats, and parser internals must not become required fields of the ABI. Consumers may inspect provider-specific `data`, but portable Runtime logic should depend on the stable envelope first.
