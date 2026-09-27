# Primitive ABI v1

Status: **1.0 candidate**

The Primitive ABI is the compact L1 execution vocabulary used by Skills and durable task graphs. New high-level product features should normally be expressed as Skills or Runtime orchestration rather than continuously expanding L1.

## Compatibility

- ABI version is explicit.
- Canonical Primitive IDs are stable candidates for 1.x.
- Deprecated aliases may remain accepted for compatibility while advertising replacements.
- Skills declare their required Primitive ABI and required Primitive IDs.
- Provider implementation details are not part of the Primitive ABI.

Current canonical families include perception, UI input, browser, filesystem, process, Git, transaction, provider diagnostics, and privileged/admin extensions.

Run:

```bash
npm run verify:isa
```

The verifier checks catalog invariants and the L2 Skill → L1 Primitive dependency boundary.

Historical design review: [../archive/l1-primitive-isa-review.md](../archive/l1-primitive-isa-review.md).
