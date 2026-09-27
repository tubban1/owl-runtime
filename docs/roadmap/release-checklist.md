# Release Checklist

Use this checklist for release candidates and stable releases.

## Build and static checks

- [ ] clean tracked working tree
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `git diff --check`
- [ ] shell installer syntax checks

## Runtime conformance

- [ ] Primitive ISA verifier
- [ ] Skill ABI verifier
- [ ] Task/staging verifier
- [ ] Scheduler verifier
- [ ] Loop verifier
- [ ] Semantic-memory verifier
- [ ] Recall verifier
- [ ] Session-adapter verifier
- [ ] Embedding-provider verifier
- [ ] WeChat-session verifier
- [ ] macOS Helper verifier
- [ ] Concurrency verifier
- [ ] Drain/handoff verifier
- [ ] Upgrade Runtime verifier
- [ ] State schema verifier
- [ ] Fault recovery verifier
- [ ] Recovery matrix verifier
- [ ] Soak smoke profile
- [ ] Production Runtime verifier

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

## Git

- [ ] intended files staged
- [ ] unrelated artifacts excluded
- [ ] commit created
- [ ] pushed branch matches local HEAD

## 1.0 additional gates

- [ ] state migrations verified
- [ ] drain/handoff verified
- [ ] upgrade/rollback integration verified
- [ ] fault-injection suite green
- [ ] long soak green
- [ ] ABI/contract freeze documented
