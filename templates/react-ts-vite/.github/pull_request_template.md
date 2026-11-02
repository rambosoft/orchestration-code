## What changed
<!-- One concern per pull request. Link the backlog item or migration-map row. -->

## Evidence
- [ ] `npm run verify` is green
- [ ] Page document (docs/pages/) updated if behaviour, actions or inputs changed; every case id has a test
- [ ] No rule in AGENTS.md is broken; any exception is a ledger row (docs/technical-debt/LEDGER.md)
- [ ] Anything not done is in docs/migration/todo.md; anything that would change architecture or behaviour is in docs/migration/findings.md
- [ ] Performance and compatibility: memory, CPU, bundle effect stated; Chrome 53 legacy bundle considered (R-019)
- [ ] Critical area touched (storage, input, carousel, player, bridge, Xtream)? Link its design note and the specialist review
