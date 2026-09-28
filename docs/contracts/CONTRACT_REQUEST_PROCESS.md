# Cross-Repo Contract Request Process

Status: **Normative**.

A consumer must not copy Runtime logic when a required generic capability is missing.

Instead create a Contract Request in the owning repository.

## Required fields

Every Contract Request must state:

- request ID, e.g. `CR-RUNTIME-001`
- requesting repo
- owning repo
- blocking use case
- missing semantics
- why the behavior is generic
- requested public contract shape
- acceptance/conformance test
- compatibility impact
- desired version window
- fallback behavior while unavailable

## Decision rules

Runtime accepts a request only when the missing behavior is a generic execution invariant or is required by multiple consumers.

Product-specific behavior remains in Desktop/Worker/Cloud.

## No emergency duplication

A release deadline is not permission to copy:

- Scheduler
- Task state
- Process ownership
- Approval enforcement
- Verifier
- Workspace lease management

into a consumer repo.

Temporary mocks are allowed only when they are explicitly non-production and contract-shaped.
