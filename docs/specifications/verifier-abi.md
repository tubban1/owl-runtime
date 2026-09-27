# Verifier ABI

Status: **v1 candidate**.

A successful action call is not the same as a completed task. OWL Runtime verification evaluates observed postconditions and produces an explicit receipt.

```text
Action
  ↓
Observation
  ↓
Verifier
  ↓
VERIFIED / FAILED / UNCERTAIN
  ↓
accept / retry / reobserve / review
```

## Status semantics

- `verified` — available evidence satisfies the declared postconditions.
- `failed` — evidence is available and contradicts a required postcondition.
- `uncertain` — the Runtime lacks enough evidence to decide safely.

`uncertain` is deliberately different from `failed`. A network disconnect after clicking **Pay** or **Send** may leave the external side effect in an unknown state. Treating that as a normal failure and replaying the action can duplicate payments/messages.

## Safety invariant

**UNCERTAIN never authorizes automatic replay of a non-idempotent or side-effecting action.**

The default follow-up policy is:

- verified → accept
- uncertain + read-only/idempotent → reobserve
- uncertain + side effect → review
- definite failure + idempotent + automatic retry contract → retry
- other definite failures → review

## Expectations

The v1 candidate supports path-based expectations: `exists`, `equals`, `contains`, `matches`, `truthy`, `falsy`, and numeric comparisons (`gt/gte/lt/lte`). The path is evaluated against the stable Observation envelope, normally under `data.*`.

This first contract does not claim that every existing action is already wired into verification. Integration is incremental so existing computer-mcp behavior remains compatible while high-risk actions gain postcondition enforcement.
