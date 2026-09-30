# Diagnostic Support Package v1

Status: **candidate contract for OWL Runtime 1.0**.

The support package is a machine-readable, shareable Runtime diagnostic snapshot intended for bug reports, support, and automated health triage.

## Public API

`RuntimeClient.getDiagnostics({ auditLimit? })` returns the package.

The same contract is available across `HttpRuntimeClient` through `diagnostics.get`.

## Included

- Runtime version/mode and redacted code/state roots;
- platform, architecture, OS release, Node version;
- ExecutionTarget manifest;
- state schema compatibility/migration state;
- provider availability and Health / permission signals;
- Task counts and hashed identifiers;
- Process status and hashed identifiers;
- workspace lease counts and hashed workspace/owner identifiers;
- recent audit status/error summaries.

## Excluded by design

The default package does **not** include:

- raw tool/action arguments;
- command text;
- stdout/stderr;
- file contents;
- clipboard contents;
- raw Task ids;
- raw Process ids;
- raw workspace paths;
- raw control capabilities/tokens.

Home-directory prefixes are replaced with `<home>` in retained path/error text. Bearer/token/secret/password/API-key-like values in retained error strings are redacted.

## Correlation without disclosure

Task, Process, workspace, lease, and owner identifiers use short SHA-256 hashes. This lets multiple support snapshots correlate the same resource without exporting the raw identifier/path.

## 1.0 conformance

The verifier proves:

- package is JSON/machine-readable;
- provider Health is included;
- Task labels are not exported;
- Process commands are not exported;
- workspace paths are not exported;
- audit args are excluded;
- error secrets and bearer values are redacted;
- home directory is redacted;
- raw Task ids are absent;
- the package is retrievable through HttpRuntimeClient.
