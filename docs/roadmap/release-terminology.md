# Release Terminology

Status: **normative vocabulary for OWL Runtime releases**.

This glossary keeps release names, gates, and execution-policy terms separate.

## Stable release

`1.0.0` is the stable 1.0 release.

A stable release has no `-rc.N` suffix and has passed every required release gate for its exact Git SHA.

## RC — Release Candidate

`RC` means **Release Candidate**.

Example:

```text
1.0.0-rc.3
```

means:

> the third candidate build being evaluated for promotion to stable `1.0.0`.

An RC is not yet the final stable release.

## rc.1 / rc.2 / rc.3

The number after `rc.` is the candidate sequence.

```text
1.0.0-rc.1
1.0.0-rc.2
1.0.0-rc.3
```

A new RC is created only when the previous candidate changes in a way that invalidates exact-SHA release evidence.

For OWL Runtime 1.0:

- `rc.1` — first frozen 1.0 candidate line;
- `rc.2` — cancellation correctness stabilization;
- `rc.3` — stable macOS Runtime Host / Full Disk Access identity stabilization.

RC numbers are **not** stable patch releases. After stable `1.0.0`, maintenance releases are `1.0.1`, `1.0.2`, and so on.

## Exact SHA

Every candidate is tied to one exact Git commit SHA.

Example:

```text
f03bed4b1c3d1444769a26a7f2f9f07ce78d921b
```

If tracked release code changes, the previous long-run evidence no longer proves the new candidate. The new candidate must be committed and verified on its own exact SHA.

## verify:rc-fast

```bash
npm run verify:rc-fast
```

This is the **fast Release Candidate gate**.

It runs focused checks such as:

- TypeScript/build correctness;
- Git diff hygiene;
- ABI/contracts;
- Observation/Verifier;
- Browser/Desktop postconditions;
- Process/cancellation;
- approval/health;
- RuntimeClient / HTTP API;
- Task/Scheduler/Loop/Memory;
- recovery/concurrency;
- production/upgrade;
- macOS Helper;
- stable Runtime Host.

It writes machine-readable evidence under:

```text
.release-evidence/rc-fast-latest.json
```

It is called "fast" only relative to multi-hour soak testing. It is still a serious release gate.

## verify:rc

```bash
npm run verify:rc
```

This currently means:

```text
verify:rc-fast
      +
smoke soak
```

So:

```text
rc-fast ⊂ rc
```

Passing `verify:rc` does **not** by itself authorize stable `1.0.0`. Real 2h/6h/24h soak and the other final gates are still required.

## Smoke soak

A smoke soak is a short-running concurrency/lifecycle stress check.

It is meant to catch obvious:

- Task leaks;
- Process leaks;
- workspace lease leaks;
- duplicate Scheduler/Loop effects;
- adapter breakage;
- resource contention regressions.

It is deliberately short and cannot replace long-duration soak evidence.

## 2h / 6h / 24h soak

These are real long-duration reliability gates:

```bash
npm run soak:2h
npm run soak:6h
npm run soak:24h
```

Each run must be attributed to an exact SHA and must finish with no release-blocking leak, duplication, lifecycle, recovery, or resource failure.

A shorter run cannot be renamed and accepted as a longer gate.

## failFast

`failFast` is **not a release stage**.

It is an execution policy used by Tasks/tests:

```text
failFast = true
```

means:

> after a step fails, stop starting unnecessary later work rather than continuing the graph.

It is unrelated to `rc-fast`.

There is currently **no formal OWL Runtime release gate named "rc-fastfail"**.

If someone says "RC fast-fail", they are probably mixing up:

```text
verify:rc-fast   ← release verification gate
failFast         ← task/test execution behavior
```

## Fast failure in a release gate

Although `rc-fastfail` is not a formal name, the RC verifier itself behaves conservatively: when a required check fails, it stops the remaining fast-gate sequence and records the failure.

That behavior is simply **fail fast**, not a separate version or release tier.

## Dogfood

Dogfood means using the candidate through realistic product paths instead of only isolated unit tests.

For OWL Runtime this includes flows such as:

```text
RuntimeClient
→ Task
→ Process
→ Observation / Verification
→ Schedule
→ Health / Diagnostics
```

Computer MCP and OWL Worker are important real-world consumers for dogfood evidence.

## Fresh consumer / tarball test

This verifies that a newly packed Runtime can be installed by another project without depending on the source checkout.

Typical flow:

```text
npm pack
→ new empty consumer
→ npm install <tarball>
→ import RuntimeClient
→ start packaged daemon
→ call HTTP Runtime API
```

## Fresh-machine gate

This is stronger than a fresh npm consumer.

It validates the operating-system installation path on a machine/environment without hidden development state:

- native Runtime Host;
- permissions;
- environment file;
- immutable release;
- LaunchAgent;
- state root;
- health;
- RuntimeClient connectivity.

## Promotion

Promotion means moving a tested artifact to the next release state.

Example:

```text
1.0.0-rc.3
   ↓ all final gates
1.0.0
```

Promotion does not mean adding features.

## 1.0.x

After `1.0.0`, versions such as:

```text
1.0.1
1.0.2
```

are patch releases.

They are limited to security/correctness/recovery/compatibility/reliability fixes under the frozen 1.0 architecture boundary.

## 1.x / 1.1

`1.x` means the compatible minor-version family after 1.0.

`1.1` may add explicitly approved additive protocol surfaces while preserving 1.x compatibility.

OWL Runtime's current 1.1 public protocol budget is capped at:

1. GroundedState v1;
2. RemediationReceipt v1;
3. Governed Capability Manifest v1.
