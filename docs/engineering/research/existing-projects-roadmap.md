# Existing-project migration: roadmap, readiness and open questions (2026-11-02)

Purpose: one place for the plan that ADRs 0032 to 0036 describe, in the order it should be built, with the questions that must be answered before each step. Nothing here is implemented except B-107 (first slice) and B-108 (survey stage, fake provider only). The operator approves each phase before it starts.

## 1. Goal
Use the orchestration to migrate `luxus-app` (Vue 2 + Nuxt 2, JavaScript, Node 14, 86 pages, 264 components, 35 store modules, 51 plugins) to a client-side React 19 + TypeScript + Vite app for TVs and phones, with production-ready, refactored code, proof of equal behaviour, living documentation and an AI map. Prove it first on one or two pages and three to five cheap components, then scale. Keep it reusable: nothing in the packs may be specific to `luxus-app` except the `media-tv-app` and Xtream layers.

## 2. Decisions taken (with the operator)
| Topic | Decision | ADR |
|---|---|---|
| Target repo | New sibling repository, local only until the pilot is judged good; old app is a read-only reference | 0032 |
| Modes | Maintain, refactor, migrate, audit; folder picked from allow-listed roots | 0032 |
| Devices | Tiered: modern bundle plus a legacy bundle for Chrome 53 and up; older devices keep the Vue 2 build (or a light build) until usage data says otherwise | 0032 |
| Sizing | One root scale token; sizes in rem/em from it | 0032, 0034 |
| Skills | Catalog as reviewed data; digests in prompts plus standards files in the repo; opt-in Claude plugins; curated, pinned import | 0033 |
| First stacks | React/TS/Vite, Vue 2/Nuxt 2 (reading), Spring Boot, Android | 0033 |
| Rules | Constitution with gates over prose; generic pack, `media-tv-app` pack, Xtream skill | 0034 |
| Million items | Conditional on a provider discovery task; not promised before it | 0034 |
| Tests | Four layers; few wide e2e journeys per milestone; devices after a milestone or several pages | 0035 |
| Parity | Page behaviour specs plus recorded or mock API fixtures, not the old app | 0035 |
| Review | Gates per task; model review per milestone; focused review for critical areas and risky changes; findings cite rule ids | 0035 |
| Models | Opus for critical-area implementation only; Codex or Sonnet for the rest; analysis and mapping on cheaper models | 0035 |
| Parallelism | Parallel across areas with disjoint files; sequential inside an area | 0035 |
| http providers | Native-mediated through the shells on TVs and Android; site moves to https; dual deployment is a temporary documented exception | 0036 |

## 3. Readiness (validated 2026-11-02): not ready for a full project, ready for a pilot after preparation
Strong and verified: core pipeline, lanes and tiers, recovery ladder, publish guard, structured-stage fallbacks, replay safety, 77 test files and 955 tests green, long unattended chains (on Unity games). Weak or missing for this project: the web/React path was last run live on Oct 22 and 23, before lanes; no characterize or parity gate; no refactor-quality gates; no skill catalog or standards pack; no project-level cost ceiling or cost accounting (a per-run Claude cap exists); no evaluation harness; `dist/` was built before the lane and survey changes, so the running worker's build is unknown; the survey stage has not run on a real repository.

## 4. Phases
Each phase has an exit test; the operator approves before the next starts.

**Phase 0: make the base trustworthy (no migration features).** Build, restart the worker, confirm the running build, run the doctor and the full suite; minimum cost visibility (per-run cost in the run result, a project-level ceiling: slice of B-035 and B-016); commit or stash the pending `luxus-app` changes; confirm emulator and SDK paths. Exit: doctor green, build stamp matches HEAD, cost per run visible, `luxus-app` clean.

**Phase 1: the minimum for a pilot.** In order: run the survey live on `luxus-app` (B-108 on a real repository); characterize stage and parity check from behaviour specs and fixtures (B-110, minimal); affected-test gate and parallel gates (B-130, B-131; B-059); generic pack content and gates (B-121, B-122, minimal) with the canonical `AGENTS.md`, rule ids and enforcement manifest (B-133); Vue 2/Nuxt 2 to React pack with the idiom map and the device tiers (B-114, minimal); host simulator and mock Xtream wiring (B-143, minimal); bridge protocol spec drafted (B-139). Tasks for the pilot are written by hand from the survey and run through the command line, so the Paperclip wizard is not on the critical path. Exit: a dry run of one trivial page through the pipeline with all gates, on the fake provider, then one real run.

**Phase 2: the pilot.** Scaffold the React repository from the template; migrate `pages/no-internet` and one more simple page, plus three to five cheap shared components (chosen from the survey). Record per task: wall time, cost, repair rounds, parity result, review findings by rule id, human edits needed. Pages use a stub bridge; the real bridge is not part of the pilot.

**Phase 3: go or no-go.** Go when parity passes, gates are green, and cost and time per task meet the thresholds agreed in Q3. Fix the orchestration and repeat the pilot if not; live runs have always surfaced a few defects.

**Phase 4: scale.** Finish report-to-plan and intake wiring (B-109, B-107); skill catalog (B-116 to B-120); living documentation, debt ledger and the remaining gates (B-123, B-124, B-132, B-134); per-area routing and area-parallel scheduling (B-135, B-136); learning loop, recipes and reuse index (B-137); deterministic Vue extraction (B-138); then the `media-tv-app` subsystems in milestones (B-125 to B-129). Per milestone: survey once, tasks by area, e2e journeys, device validation.

**Parallel track C (separate repositories, not on the pilot's critical path):** bridge client and shell implementations, native-mediated network, host hardening, https deployment and secrets hygiene (B-140 to B-145). It must be complete before the migrated app replaces the current one for http providers.

## 5. Backlog map
| Items | Subject | ADR | Phase |
|---|---|---|---|
| B-107, B-108 | Intake slice, survey stage (done, fake provider) | 0032 | 0, 1 |
| B-109 to B-115 | Plan from survey, migrate flow, gates, AI docs, references, React pack, pilot | 0032 | 1, 2, 4 |
| B-116 to B-120 | Skill catalog, delivery, import, content, learning | 0033 | 4 |
| B-121 to B-129 | Pack content and gates, docs, debt ledger, TV pack, input, storage, catalog and Xtream, review routing | 0034 | 1, 4 |
| B-130 to B-138 | Affected tests, parallel gates, case matrix, AI files, rule-aware review, area routing, area-parallel plans, recipes, Vue extraction | 0035 | 1, 4 |
| B-139 to B-145 | Bridge spec, client, shells, network channel, simulator, deployment, hygiene | 0036 | 1, track C |

## 6. Pilot success measures (thresholds to confirm in Q3)
Per task: all gates green, parity tests pass, repair rounds, review findings (each cites a rule id), human edits, cost and wall time. Over the pilot: the second batch of components must be measurably faster and cheaper than the first batch, otherwise the recipes and the pattern record are not working.

## 7. Open questions
| ID | Question | Recommended default | Blocks |
|---|---|---|---|
| Q1 | Hard per-project cost ceiling before the pilot, or visibility only? | A hard ceiling (value set by the operator) plus the existing per-run cap | Phase 0 |
| Q2 | Run the pilot from the command line with hand-written tasks, or wait for the Paperclip wiring? | Command line | Phase 1 |
| Q3 | Pass thresholds for the pilot (cost and time per page, repair rounds, share of tasks needing human edits)? | Set after the Phase 0 baseline; start with: gates green, parity pass, at most two repair rounds on average | Phase 3 |
| Q4 | Do all production TV models and firmware accept the https site (certificate chain, clock)? | Test on devices; keep the http exception until verified | B-144 |
| Q5 | Where are the webOS, Tizen and Android emulators and SDKs installed (paths, versions, device images)? | Operator confirms; found so far: `C:\tizen-studio`, Android AVDs `Television_1080p`, `TV`, `Medium_Phone` | B-143 |
| Q6 | Commit or stash the pending changes in `luxus-app`? | Operator commits or stashes; admission needs a clean tree | Phase 0 |
| Q7 | When is the GitHub repository for the React app created? | After the pilot is judged good | Phase 4 |
| Q8 | Confirm current Opus, Sonnet and Codex model ids and prices and the cost caps per run and per project? | Confirmed when the routing table is written | B-135 |
| Q9 | Who can read the device-version data the app already collects, to decide the legacy floor and when old tiers can be dropped? | Operator exports it before Phase 4 | Tier decision |
| Q10 | Source of truth for the shells: `tizen/Tizen-Luxus-App`, `webos-luxus`, `viseo-android`; archive `C:\workspace\Tizen-Luxus-App` (2022)? | Confirm and archive the old copy | Track C |
| Q11 | Do the oldest Android TV targets support the web message listener? | Check against the minimum Android version | B-141 |
| Q12 | Can `luxus-service` index and page the provider catalog (discovery for the million-item goal)? | Run the discovery task before promising the guarantee | B-128 |
| Q13 | Who removes the embedded credentials from `viseo-deployment` scripts and keeps `author.p12` outside the workspace; are any secrets to be rotated? | Operator owns this; not delegated to an agent | B-144, B-145 |
| Q14 | Which three to five cheap components and which second page for the pilot? | Chosen from the live survey, lowest complexity and most reuse | Phase 2 |
| Q15 | Is running the old app's existing Playwright specs (Node 14) wanted as an extra reference? | No for the pilot (spec and fixtures decide); revisit for critical areas | Optional |
| Q16 | Who approves each phase gate? | The operator, in chat | All phases |

## 8. Risks
Orchestration defects on a project type not run live for two weeks; model cost at hundreds of tasks (hence the ceiling and routing); parity tests only as good as the behaviour specs (the survey and page documents must be accurate); the https move can break old TVs; the million-item goal may need a backend; shells are separate repositories with their own release process; third-party library and standards statements in the ADRs are unverified until scaffold time.

## 9. Approval checklist
Answer Q1, Q2, Q6 and Q16 to start Phase 0; Q5 and Q14 to start Phase 1; Q3 before Phase 2 ends; the rest can be answered when their blocker is reached.

## 10. Answers recorded 2026-11-02 (all questions cleared)
| ID | Answer |
|---|---|
| Q1 | Cost visibility only (subscriptions). No hard ceiling. Highlight a task whose consumption is far above its kind so it can be optimised: B-146. Manual procedure meanwhile in the runbook |
| Q2 | Yes: pilot from the command line with hand-written tasks. How and when: `docs/engineering/runbooks/pilot-via-cli.md`. Found and fixed while writing it: the `Type:` line in a task prompt did not accept `survey`/`audit` |
| Q3 | Relative thresholds: gates green, parity pass, at most two repair rounds on average; the second batch at least 30% lower in busy time than the first |
| Q4 | Verify https on the devices in Phase 4 before removing the redirect to http; the http exception stays until then |
| Q5 | webOS device validation is skipped in the pilot (host simulator and pinned Chromium only). Present on this machine: Tizen Studio with emulator tools, the Android emulator and AVDs, the `ares` CLI (npm) for a real LG TV later; no webOS TV simulator found |
| Q6 | Done: `luxus-app` committed locally as `858b4c22` on `main` (not pushed; the operator pushes if the survey PR should include it) and the tree is clean |
| Q7 | Unchanged: the GitHub repository is created after the pilot is judged good. **Location corrected**: both repositories live under `C:\workspace\orchestration-projects` (the only folder the bridge mounts): a clone `luxus-app` for the survey and the new `luxus-app-react` |
| Q8 | Role aliases in the manifest (critical-implement, implement, analysis, review) mapped to the current Opus, Sonnet and Codex models; ids and subscription limits confirmed when B-135 is built |
| Q9 | The operator exports the device-version data before Phase 4; the legacy floor is decided from it (Chrome 53 and up until then) |
| Q10 | `tizen/Tizen-Luxus-App`, `webos-luxus`, `viseo-android` are the sources of truth; the 2022 copy `C:\workspace\Tizen-Luxus-App` is archived after its git status is checked for unpushed work |
| Q11 | Android `minSdk` is 23. The origin-restricted web message listener is feature-detected at run time (WebView feature, not OS version) with the restricted-interface fallback |
| Q12 | First task of Phase 4, read-only: can `luxus-service` index and page the provider catalog; no million-item promise before the report |
| Q13 | The operator handles credentials in `viseo-deployment` and `author.p12`; an agent only lists locations without opening values |
| Q14 | Pages `no-internet` and `blocked`; components `SettingsChevronRow`, `SettingsTextDisplay`, `SettingsSectionHeader`, `OverlayCloseButton`, `ProgressBarComponent` |
| Q15 | No old-app Playwright reference run for the pilot; revisit for cache, player and carousel in Phase 4 |
| Q16 | Each phase ends with an exit report (exit test result, metrics, issues, next scope); the operator replies go or what to change |

Phase 0 may start on the operator's go. New backlog items from these answers: B-146 (consumption highlight) and B-147 (pilot setup).

## 11. Progress while the operator was away (2026-11-02, Phase 0 done, Phase 1 started)
Done and verified:
- Phase 0 exit test met: the worker was restarted with the drain-aware script (nothing in flight) and the bridge container rebuilt; `doctor` passes every check (only a warning for 40 old task worktrees); `dist` is up to date; full suite 961 tests green; `luxus-app` committed locally (`858b4c22`).
- Fixed: the `Type:` line now accepts survey, audit and codebase-survey (test first). Built: B-146, the Heavy tasks section of `timing` (on the real log it flags two implementation runs at 3.1x and 3.2x). Found: B-148, `luxus-app/.gitattributes` corrupts media files in a fresh Windows clone.
- Pilot clone ready at `orchestration-projectsluxus-app` (clean with a local attributes override, one commit ahead of GitHub); manifest `projects/luxus-app.json` written (untracked) with a Codex route for the survey stage; the bridge loaded it.

Not done, and why:
- The live survey did not run: the bridge only accepts a GitHub `origin`, and a survey ends in a draft pull request on `rambosoft/luxus-app` (a pushed branch that would carry the unpushed local commit). That is an outward-facing action, so it waits for the operator (see OQ-A).
- B-131 (parallel gates): the verify loop in `src/activities.ts` is about 90 lines of sequential logic (Unity healing, early return on the first failure, warn-only severity, result order, a shared working tree); it needs a careful extraction, not an unattended edit (OQ-D).

Open questions raised for the operator (recommendations first):
| ID | Question | Recommendation |
|---|---|---|
| OQ-A | How to run the live survey, given it publishes a draft PR to GitHub? | Reset the pilot clone to GitHub `main` (survey without `858b4c22`) and allow the draft PR on `rambosoft/luxus-app`; alternatives: push `main` yourself first, or build a local-only survey mode (no PR) in the orchestrator |
| OQ-B | Fix `luxus-app/.gitattributes` (add binary rules for media) in the real repository (B-148)? | Yes, one small commit by you or by me with your go |
| OQ-C | Commit `projects/luxus-app.json` to this repository like the other manifests? | Yes |
| OQ-D | Parallel gates (B-131): opt-in per command group, or automatic for commands that declare no shared output? | Opt-in groups first; I extract the per-check runner with tests before parallelising |
| OQ-E | Run `dev cleanup --days 7` for the 40 old task worktrees? | Yes (branches are never deleted) |
| OQ-F | Push `luxus-app` `main` (the `858b4c22` commit)? | Your call; not needed if OQ-A uses the reset option |
| OQ-G | Renumber `docs/engineering/research/android-support.md` (it plans ADR 0031 and B-106..B-115, now taken) and commit it? | Yes, renumber to ADR 0037 and B-149 onward |

