# Orchestration readiness plan: what must be done before each milestone (2026-11-02)

Purpose: keep the orchestration work aligned with the migration milestones. Nothing in a gate's list may be unfinished when the next phase starts; a new backlog item is assigned to a gate when it is added. Sizes are the backlog's (S, M, L); there are no dates. This file is the alignment and is updated at every gate. Roadmap: `existing-projects-roadmap.md`. Milestones M1 to M6 are defined in the roadmap (section on the real refactoring).

## Rules
1. **Finish before you start.** Everything in progress, plus everything planned before a milestone, is done and tested together before that milestone's first task runs.
2. **Prepare at the start.** The items a milestone itself needs are built in the first stretch of that milestone, before its first product task, and verified by a rehearsal.
3. **Test the combination, not only the parts.** Each item ships with its own tests; each gate adds an integration rehearsal (B-168) and runs the full suite, the replay fixture and the doctor.
4. **Optional by design.** Every code-intelligence or context tool is a registered capability with a mode (off, advisory, gate) and a kill switch (B-167, ADR 0038 addendum), so a faulty tool can be switched off without a deploy.
5. **Workflow changes** that alter the command sequence need `patched()` and a regenerated replay fixture (`docs/engineering/EXTENDING.md`).

## Gate G0: pilot go/no-go (Phase 3)
Pilot tasks PILOT-1B to 5B finish and their gates are green. **Go** when a simple run in a browser works: the app opens, both pages and the shared components render in place, nothing is broken, and the layout stays proper when the screen size changes (phone, laptop, TV widths), with focus visible. Page documents with cases cited by tests, repair rounds and the second batch's speed are recorded as evidence, not as blockers. Findings from the pilot (for example whether Codex can read the reference repository) adjust the G1 list below.

### G0 result (2026-11-02): GO, with two scale-system defects to fix first
- **Run:** PILOT-1B..5B all completed on the first attempt, every gate green, draft PRs #2 to #6 on `luxus-app-react` (stacked on #1). Wall time per task 12 to 29 minutes (components 12 to 15, router and translations 18, pages 22 and 29). All implementation by Codex: 3.28M input and 33k output tokens, no Claude implementation tokens. The pages are larger than the components, so the second batch is not comparable for speed; recorded as evidence only.
- **Reference access:** Codex read the legacy sources from the absolute reference path outside its worktree (PILOT-1B aligned the primitives to the real legacy styles). Formalised as the manifest `reference` field (B-110).
- **Browser check** (production build of the stacked branch, served by Vite): both pages render with correct text, images load, no console errors, no horizontal overflow at 375, 768, 800x480, 1366, 1920 and 3840 widths; the root scale token works (17.28px at 1080p, 34.56px at 4K); content is centred and light-on-dark.
- **Defects found (both in the scale system, B-169):** (1) the root font is 9px on a phone (375 wide) and on short landscape (800x480): no floor, so body text is unreadable; (2) vertical overflow at tablet portrait and at 800x480 because the port converted a viewport-height container to a fixed rem `min-height` (56.25rem), which only equals the viewport when the root follows the height (landscape). Rule to add: full-height containers use `min-height: 100vh`, never rem.
- **Findings for the owner:** the legacy `pages/blocked` template renders `block.message1` twice (lines 13 and 17), the port reproduced it faithfully; the "Error" label is purple on near-black (about 3:1 contrast).
- **Verdict:** GO. The defects are fixed first, as the first orchestrated task on the real project, and the responsive check becomes an automated viewport test (B-143/GM1).

## Gate GM1: Milestone 1 go/no-go (after its first real page)
After Milestone 1 starts and one real page with a few components is refactored in `luxus-app-react`, validate everything together in the real project, not the pilot: the orchestration changes, the tools and libraries (toggle modes), the standards pack, the new project's gates, the page and its components in a browser. Only then does Milestone 1 continue at full speed.

## Working loop and recovery
Each item is built, tested and committed on its own (Codex drafts code or analysis; the diff is reviewed and the tests run before the commit). `STATUS.md` always names the next step, so work can resume from any commit. Work is never left half-done at a stop: if the Claude usage limit is near, finish the current item to a committed, green state and write the next step down.

## Gate G1: orchestration ready for Milestone 1 (build and test, before any M1 task)

Order correction (2026-11-03, Codex audit, verified against BACKLOG dependencies): build B-117 before B-121 (B-121 depends on it), and keep B-168 last: it depends on B-167, which sits in G2, so the G1 rehearsal covers B-109, B-110, B-130, B-135 and B-116/B-117 only, and the full toggle matrix runs when B-167 lands (G2). B-169 and B-148 are done. Design notes for M1 storage and input are now B-172 and B-173 (G2, critical area, approved before B-127 and B-126 run). B-130 is enabled in projects/luxus-app-react.json (`test:related -- {changed}` per task, full `npm test` at milestone scope).
| Item | Why Milestone 1 needs it | Done when |
|---|---|---|
| B-110 reference mount + minimal characterize/parity | tasks must read the old code, and parity needs a check | a task worktree can read the reference read-only; a seeded behaviour change fails the parity check |
| B-109 survey to milestones, tasks and issues | hundreds of tasks cannot be hand-written | an approved survey produces an ordered task chain; test with a fixture survey |
| B-114 (in progress) idiom map done; add tier matrix and the Chrome 53 legacy bundle | M1 includes the Vite build (R12) | a legacy build is produced and smoke-tested on an old engine |
| B-121 (in progress) pack generated by scaffold and onboard | new repositories get the pack automatically | onboard `--pack react-ts-vite` produces a repo that passes `verify` |
| B-122 + B-162 (in progress) finish gates: dependency-cruiser, style-token lint | boundaries and R-015 must be gates | seeded violations fail; clean project passes |
| B-123 (in progress) generated AI map and the scheduled drift workflow template | docs must stay true from day one | map regenerates; drift reports an out-of-date page document |
| B-132 (in progress) case matrix and the milestone e2e journey format | few wide e2e tests per milestone | format documented; check wired |
| B-130 enforced affected-test gate | per-task verify must stay fast | a change runs only its domain's tests |
| B-112 + B-161 AI map gate and the component contract format | later agents need contracts | gate fails a module without a contract |
| B-116 + B-117 skill catalog, resolver and delivery | standards reach Codex and Claude alike | skills appear in prompts within budget; UI/UX selector unchanged |
| B-135 per-area model routing and cost caps | storage and input are critical areas | a critical item routes implement to the strong model; others to the default |
| B-168 integration rehearsal | prove the parts work together | see "Test plan" |
| B-148 luxus-app `.gitattributes` (fix committed locally) | clean clones | operator pushes, or the clone override stays documented |

## Gate G2: prepare Milestone 1 (first stretch of M1, before its first product task)
B-138 Vue and TypeScript extraction (ts-morph, `@vue/compiler-sfc`) for the milestone survey; B-137 recipes and reuse index; B-163 preparation package with provenance together with B-167 (the intelligence registry with modes and kill switch, built with its first consumer so it is not speculative; moved here from G1 on 2026-11-02); B-165 Context7 pre-fetch and cache; B-118 + B-119 skill content (React/TS/Vite, Vue 2/Nuxt 2 reading, Xtream, TV performance, input, storage, compatibility); B-125 `media-tv-app` pack (compatibility matrix, budgets, heap test, component registry); B-134 + B-129 rule-aware, risk-based and specialist review; B-159 design gate for critical areas; B-113 dependency allow-list; B-164 Graphify spike (Codex, decide adopt or reject). Then the **M1 survey** and the **design notes** for storage and input. Done when a real M1 task gets a preparation package, its prompt carries the skills within budget, and the design notes are approved.

## Milestone 1 product work (executed by the orchestration)
B-128 discovery on `luxus-service` first (can it index and page the catalog); R12 Vite and legacy bundle; R3 shell and auth bootstrap; R4/R5 storage interface, query layer and cache (B-127); input layer (B-126).

## Gate G3: before Milestone 2
B-136 area-parallel scheduling (M2 has independent areas); B-120 learning loop and metrics trend (is the second milestone cheaper than the first); B-107 wizard wiring and the intake endpoints (decision: only if the command-line path is no longer enough); B-143 host simulator (needed for M3 e2e); B-166 decision on Serena and CodeQL from measured numbers; rehearsal re-run with the new items.

## Later gates
- **Before M3:** host simulator and mock-Xtream large mode working; carousel design note (B-159).
- **Before M5:** bridge protocol, client, shells and native network channel (B-139 to B-142); player orchestration design note and device spike (B-170, B-171; docs/engineering/research/player-orchestration-plan.md) before any player refactor task.
- **Before M6:** https deployment and secrets cleanup (B-144, B-145, operator's part), device validation on emulators and real TVs, the legacy device-usage data (roadmap Q9) and the https device check (Q4).
- **Anytime:** B-160 (EGM skills evaluation).

## Test plan (B-168): proving the items work together
1. **Per item:** unit tests, seeded violations for every gate, `patched()` plus replay fixture for workflow changes.
2. **Toggle matrix:** each intelligence tool in off, advisory and gate; a failing, a slow and a stale-provenance tool each leave the task unharmed unless it is a gate.
3. **Fixture rehearsal (automated):** a small fixture Nuxt-style project and the fake provider drive the whole chain in the Temporal test environment: survey, plan from survey, area routing, parallel gates, affected tests, milestone check, rule-aware review; the result is asserted end to end.
4. **Live canary:** two real tasks on `luxus-app-react` (one critical-area design note, one ordinary component) through the real bridge and worker, with the consumption highlight and `usage` compared with the pilot baseline.
5. **Regression guard:** full test suite, replay test, `check:chars`, doctor, and a reconcile of in-flight runs before any worker restart (drain-aware deploy).
6. **Stop rule:** if the rehearsal or canary fails, fix the orchestration before the milestone starts; record the finding in `failure-modes.yaml` and the backlog.
