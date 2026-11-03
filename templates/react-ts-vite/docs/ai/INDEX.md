# AI map: {{name}}

An index into the real documents, not a copy. Keep it short; update it when a module or page is added.

- Rules: `AGENTS.md` (canonical) · `docs/ai/enforcement.json` (which rule is a gate) · `ENGINEERING_STANDARDS.md` (detail)
- Pages: `docs/pages/<page>.md` (one per `src/pages/<page>/`)
- Modules: list each feature module here with a one-line purpose and its contract (Interface, Invariants, Side Effects).
- Decisions: `docs/decisions/`
- Technical debt: `docs/technical-debt/LEDGER.md`
- Migration notes: `docs/migration/findings.md` (changes that would alter architecture or behaviour, for a decision), `docs/migration/todo.md` (work not done), `docs/migration/map.md` (old file -> new file -> status -> tests)
- Commands: `npm run verify` (everything), `npm run test:related -- <files>` (while working), `npm run lint`, `npm run knip`, `npm run depcruise`, `npm run jscpd`, `npm run check:ai`, `npm run check:debt`, `npm run check:pages`, `npm run check:styles`, `npm run check:journeys`, `npm run check:contracts`, `npm run check:parity`, `npm run check:index` (regenerate with `npm run ai:index`)
