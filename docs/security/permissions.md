# Permissions

OWL Runtime uses explicit capability gates and operating-system permissions.

Cloud account roles and DeviceGrants are upstream control-plane authorization, not Runtime capabilities. See [Cloud Authorization Boundary](cloud-authorization-boundary.md).

## Filesystem scope

Filesystem operations are limited by configured allowed directories. Runtime-owned staging/state paths are handled separately.

## High-impact capabilities

Shell execution, deletion, Git push, rollback, browser automation, and GUI automation are independently governed.

## macOS Runtime Host — Full Disk Access identity

Production OWL Runtime uses a fixed native host:

```text
~/Applications/OWL Runtime.app
bundle id: fan.fde.owl.runtime
```

This app is the stable permission-bearing identity for protected file access. Ordinary Runtime releases live under versioned `~/.owl/releases/...` directories and **must not replace the Runtime Host**.

Install it once with:

```bash
npm run install:runtime-host
```

Then grant **Full Disk Access** to **OWL Runtime** in:

```text
System Settings → Privacy & Security → Full Disk Access
```

The host has an independent version and source fingerprint. If its native code changes, replacement requires an explicit host-upgrade action (`ALLOW_OWL_RUNTIME_HOST_UPDATE=true`); a normal `1.x` server promotion is not allowed to change it silently.

## macOS Helper — Accessibility / Screen Recording

Desktop and WeChat capabilities may require:

- Accessibility
- Screen & System Audio Recording

The 1.0 compatibility helper keeps its existing stable application identity. Ordinary Runtime releases must not treat a release-specific Node/JavaScript path as the Accessibility or Screen Recording identity.

The Runtime reports missing permissions rather than pretending background automation succeeded.

## Production self-protection

Production mode blocks writes to the active Runtime release by default. Upgrades go through immutable release installation, candidate health verification, graceful drain, cutover, and rollback.
