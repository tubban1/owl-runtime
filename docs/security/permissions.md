# Permissions

AgentOS uses explicit capability gates and OS permissions.

## Filesystem scope

Filesystem operations are limited by configured allowed directories. Runtime-owned staging/state paths are handled separately.

## High-impact capabilities

Shell execution, deletion, Git push, rollback, browser automation, and GUI automation are independently governed.

## macOS Helper

Desktop and WeChat capabilities may require:

- Accessibility
- Screen & System Audio Recording

The Runtime should report missing permissions rather than pretending background automation succeeded.

## Production self-protection

Production mode blocks writes to the active Runtime release by default. Upgrades go through immutable release installation and health verification.
