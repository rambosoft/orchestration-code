# Milestone 1 plan for luxus-app-react (2026-11-03)

Source: the full survey of the legacy app (draft PR rambosoft/luxus-app#333, `docs/survey/LUX-SURVEY-3.md`, 12 backlog items R1 to R12), cut to Milestone 1 with `dev plan-from-survey ... --only R12,R3,R5 --area R5=cache-storage:critical --design cache-storage=docs/design/storage.md`, plus one hand-written task for the input layer. The chain is `examples/luxus-m1.tasks.json`; tasks run one after another, each stacked on the one before.

| Order | Task | Area | Design | Why in M1 |
|---|---|---|---|---|
| 1 | LUX-R12 Vite and legacy bundle, browser targets | build | none | settles the build and the Chrome 53 tier before code piles up (the pack already holds the legacy plugin; this task validates the targets and ports the polyfill and compatibility scripts) |
| 2 | LUX-R3 client shell and authentication bootstrap | shell-auth | none | every page needs the shell, the session bootstrap and the API setup; it owns InputManager start and stop |
| 3 | LUX-R5 content cache and local persistence | cache-storage (critical) | docs/design/storage.md | the storage contract, migration of the legacy databases, quota recovery |
| 4 | LUX-INPUT input layer | input (critical) | docs/design/input.md | intents, focus zones, modal traps, platform key tables |

Left out on purpose
- **R1, R2** were the pilot (merged).
- **R4 Xtream fetching** (critical, area xtream-fetch) waits for the discovery of `luxus-service` (B-128: can it index and page the catalogue) and for its own approved design (`docs/design/xtream-fetch.md`); the bridge refuses a critical task without one.
- **R6 to R11** are Milestones 2 to 5.

Gates: the critical tasks need their `Design:` line (the bridge reads the approved file at the task's base commit, so luxus-app-react PR 11 must be merged first). The per-task gates, the preparation block (ts-imports, affected-tests, pkg-deps, reuse-index, lib-docs), the specialist review for storage and input paths, and the milestone-scoped full test and heap run apply as configured in `projects/luxus-app-react.json`.
