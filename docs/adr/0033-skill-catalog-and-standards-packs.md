# ADR 0033: Skill catalog and standards packs

Status: Accepted; catalog, resolver and prompt delivery built 2026-11-03 (B-116, B-117 partly: `src/skills.ts`, `src/skills-text.ts`, `skills/`). Standards files, pack-owned skills, the sync script and the learning loop are still design. Generalizes ADR 0010 (UI/UX skill selector), extends ADR 0017 (stack packs) and ADR 0032 (existing projects, migration packs).

## Context
- The agents that write code get better results when they carry stack-specific standards (React hooks rules, Vite configuration, Spring layering, Compose architecture). Today only UI work gets that: `src/uiux.ts` selects UI/UX skills by wording and frameworks and injects a guidance block (ADR 0010).
- The operator's Claude has many relevant skills and agents installed (ECC: `react-patterns`, `react-performance`, `react-testing`, `vite-patterns`, `vue-patterns`, `e2e-testing`, `springboot-*`, `kotlin-*`, `android-clean-architecture`, reviewer agents, and more). The orchestrator deliberately switches the operator's plugins off for every Claude run (`src/claude-settings.ts`): they cost about 15,000 tokens of a 51,000-token session start, re-read every turn. Codex does not use Claude plugins at all; it reads `AGENTS.md` and the prompt.
- So installing more plugins in the operator's own tools does not reach the runs, and a design that depends on Claude plugins would leave Codex without it.
- Requirement (operator, 2026-11-02): language- and area-specific skills for higher quality, extensible and future-proof, useful for every project the system serves, not only `luxus-app`.
- Decisions taken with the operator: **delivery is both, digests by default** (short digests in prompts plus vetted standards files in the target repository, with an opt-in list of real Claude plugins per project); **content is a curated, pinned import** (a sync script copies text from installed plugins with version and hash, a person approves each change, no plugin code runs); **first catalog covers React + TypeScript + Vite, Vue 2/Nuxt 2 (reading), Spring Boot and Android (Kotlin/Compose)**.

## Decision

1. **One catalog, as data.** `skills/catalog.json` lists entries; each entry has `id`, `title`, `areas` (stack profile ids such as `react-ts`, `spring-boot`, `android-kotlin`, or `any`), `tasks` (task types and modes it applies to), `stages` (plan, implement, review, survey, characterize, verify), `digest` (path to `skills/<id>.md`, a bounded text of a few hundred tokens), `deep` (optional references: a Claude plugin skill name, a doc path), `gates` (the deterministic checks that enforce its rules, as stack-pack gate ids), `source` (origin, version, content hash) and `status` (approved, candidate, retired). The catalog has a `version`.
2. **One resolver.** `selectSkills({ profile, taskType, mode, stage, project })` returns an ordered, token-budgeted list. Precedence: project `include` first, then entries that match profile, task and stage, trimmed to the stage budget (a new `HANDOFF_BUDGETS.skills`); project `exclude` always wins. `src/uiux.ts` becomes the first consumer (its selector is generalized, its behaviour and tests kept).
3. **Delivery, two layers.**
   - *Digests* go into the stage prompts for every provider (Claude, Codex, OpenRouter) as one labelled block, marked as guidance and below the task's own constraints.
   - *Standards files*: the scaffold and `onboard` write the selected digests into the target repository as `docs/ai/standards/<area>.md`, referenced from the generated `AGENTS.md` and `CLAUDE.md`, so both CLIs read them on demand and they are versioned with the project.
   - *Opt-in plugins*: a project may list real Claude plugins in its own `.claude/settings.json`; the orchestrator keeps those enabled (it already does). Used sparingly, because of the token cost.
4. **Stack packs own their skills.** A stack pack (`src/stack-packs.ts`) gains `skills` (catalog ids) and `rules` next to its detection and gates. Adding a stack is adding a pack and catalog entries; the orchestrator core does not change. Every rule a skill states should map to a gate where a tool can check it (ESLint hooks and accessibility rules, strict TypeScript, Vitest, Playwright parity specs, `jscpd`, `knip`, bundle budget; `detekt`/`ktlint`/Lint for Android; the Maven or Gradle tests and static analysis for Spring); prose-only rules are the exception and are listed as such.
5. **Curated, pinned import.** `scripts/skills-sync.mjs` reads the installed plugins' skill folders (read-only), takes text files only (never scripts or executables), condenses nothing itself, records the source path, plugin version and SHA-256, and writes a **candidate** entry. A person edits the digest down to its budget and sets it `approved`. A later change of the source hash marks the entry `stale` in `npm run doctor`, never silently updates it. Third-party text is untrusted data: digests are reviewed like code, and the prompt block states that they are guidance, not instructions that override the task.
6. **First catalog.**
   - React + TypeScript + Vite: component and hook patterns, render performance, Vite configuration and the legacy bundle for the TV tiers, Testing Library and Vitest, Playwright parity specs, accessibility, error handling, coding standards; reviewer roles for React and TypeScript.
   - Vue 2 / Nuxt 2 (reading): how to read Vuex modules, `asyncData`/`fetch`, mixins, middleware and plugins, to support the survey and `characterize` stages. The installed `vue-patterns` and `nuxt4-patterns` target newer versions, so the Nuxt 2 digest is written, not imported.
   - Spring Boot: layering, JPA, security, testing (the existing `spring-boot` pack).
   - Android (Kotlin/Compose): the architecture, coroutines and testing rules from `docs/engineering/research/android-support.md`, which also lists Google's own Android skills as a pinned source.
7. **Learning loop.** Findings that recur in reviews and failure classes (`failure-modes.yaml`) are collected as **candidate lessons** (a file per project, then promoted per stack), reviewed by a person, and added to the matching digest or gate. Nothing is learned automatically into prompts.
8. **Replay safety and traceability.** The catalog is data on the prompts, so no new workflow step, no `patched()` and an unchanged replay fixture. The run result records `skillsCatalogVersion` and the ids used, so a quality change can be traced to a catalog change.
9. **Measure.** The existing timing and run metrics gain "first review rejected" per skill set, so a skill that does not reduce rejections or repair rounds is retired.

## Consequences
- Quality guidance becomes a first-class, reviewable artifact instead of operator-local plugin state; it reaches Codex and Claude alike and survives machine changes.
- Token cost rises by the digests (target under 1,500 tokens per stage), well below the 15,000 of whole plugins.
- A bad or stale digest is a bug in versioned data, found by review and by the `stale` check, not a hidden plugin update.
- The UI/UX selector keeps working; later it is just the `ui` area of the catalog.
- Not covered: automatic skill generation, skills that run code, marketplace auto-update, per-model tuning of digests.

## Open points
- The digest budget per stage is set in the first slice from measured prompt sizes.
- Whether `deep` references can be loaded on demand by Codex (it has no skill tool) or only by Claude; for Codex the standards files are the deep layer.
- Which Android skills from Google's repository are worth pinning is decided when the Android pack is built.
