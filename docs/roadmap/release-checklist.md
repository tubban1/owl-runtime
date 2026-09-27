# Release Checklist

Use this checklist for release candidates and stable releases.

## One-command RC gate

Run:

```bash
npm run verify:rc
```

`verify:rc` performs:

1. `verify:rc-fast` — focused build/static/ABI/runtime/recovery/production gates with machine-readable evidence;
2. `soak:smoke` — the short concurrency/recovery soak.

`verify:rc-fast` writes:

```text
.release-evidence/rc-fast-latest.json
```

The evidence records Git SHA, branch, platform, Node version, each check's exit code and duration, and whether the tracked worktree stayed clean.

## Build and static checks

- [ ] clean tracked working tree
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `git diff --check`
- [ ] shell installer syntax checks
- [ ] public `.d.ts` build succeeds

## Runtime conformance

- [ ] Primitive ISA
- [ ] Skill ABI
- [ ] Observation ABI
- [ ] Verifier ABI
- [ ] File/action Observation + Verification
- [ ] Browser postconditions
- [ ] Browser request cancellation
- [ ] Desktop postcondition policy
- [ ] Managed Process state machine/control
- [ ] Approval receipts
- [ ] Execution Health
- [ ] ExecutionTarget / Provider Affinity
- [ ] redacted support package
- [ ] in-process RuntimeClient
- [ ] HTTP RuntimeClient / reconnect
- [ ] Task/staging
- [ ] Scheduler
- [ ] Loop
- [ ] Semantic memory / recall / embedding provider
- [ ] Runtime identity
- [ ] Drain/handoff
- [ ] Recovery matrix
- [ ] Production Runtime
- [ ] Production upgrade/rollback
- [ ] macOS Helper syntax

## Soak evidence

- [ ] `soak:smoke` passed for the RC
- [ ] real 2-hour soak passed
- [ ] real 6-hour soak passed
- [ ] real 24-hour soak passed
- [ ] final reports show no leaked Tasks/processes/leases
- [ ] final reports show no duplicate Scheduler/Loop side effects

Smoke is required for `1.0.0-rc.1`. The real 2h/6h/24h sequence is required before final `1.0.0`.

## Production

- [ ] immutable release created
- [ ] launchd service healthy
- [ ] expected version reported
- [ ] production state root correct
- [ ] current release symlink correct
- [ ] rollback path available
- [ ] no `tsx watch` process serving production

## Data safety

- [ ] verifier scratch removed
- [ ] real M2/M3/session stores not polluted by tests
- [ ] no secrets staged in Git
- [ ] production environment permissions remain restricted
- [ ] support package contains no raw commands/content/tokens/workspace paths

## Git

- [ ] intended files staged
- [ ] unrelated artifacts excluded
- [ ] commit created
- [ ] pushed branch matches local HEAD

## Version promotion

### `0.10.0-dev.0` → `1.0.0-rc.1`

Requires all 1.0 code work packages DONE + `npm run verify:rc` green.

### `1.0.0-rc.1` → `1.0.0`

Requires RC dogfood + real 2h/6h/24h soak evidence + fresh-machine setup verification. No new feature work is permitted during this phase unless it fixes a release-blocking correctness/security/recovery defect.
