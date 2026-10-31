# STATUS (rewritten each update)

## Current checkout audit and provider update (2026-10-26)
- Branch `mission/hardening` is aligned with `origin/main` through PR #11. Recent development includes multi-project live runs and broad hardening through B-086; see `knowledge/git-history.md` for the audited change map and evidence.
- 2026-10-31 Ninth finding fixed (ADR 0028, B-101): LOC-138 stopped on a device-only criterion (mid-range Android profile) after two reviews; a prototype now finishes with the finding on the PR. To be deployed at the next gap, LOC-138 then resumed.
- 2026-10-31 Root cause of the repeated manual recoveries fixed (ADR 0027, B-100): recovery ladder. LOC-135 done; LOC-137 running; ladder to be deployed at the next gap.
- 2026-10-31 Eighth finding fixed (ADR 0026, B-099): a check with nothing to change publishes a report. LOC-135 to be re-run.
- 2026-10-30 Seventh finding fixed (ADR 0025, B-098): the gate reports the acceptance trace with a failing command. ADR 0024 deployed (adapter and worker). LOC-132 to be recovered.
- 2026-10-30 Sixth finding fixed (ADR 0024, B-097): run storm from `blocked`; 225 stale worktrees on disk to clean; LOC-132 running.
- 2026-10-30 Fifth finding fixed (ADR 0023, B-096): auto-approved projects release all milestones. Milestone 1 done (LOC-115..118); milestones 2-5 released by hand, LOC-120 running.
- 2026-10-30 Third and fourth live findings fixed (ADR 0022, B-095): failed runs are recorded with an unblockDescriptor; the slice gate counts a boot in setup. LOC-117 to be resumed.
- 2026-10-30 Second live finding fixed: adapter keepalive (ADR 0021, B-094). Paperclip recreated to load it. LOC-116 re-running.
- 2026-10-31 Speed (ADR 0029, B-104): a prototype task is implement + verify whatever its Lane, the full PlayMode suite and the one review run only in the milestone check, generated files no longer trigger escalation. Needs `npm run build`, worker restart and `docker compose up -d --build orchestrator`; not measured on a live task yet.
- 2026-10-30 Live run of Cinderfield Minesweeper (LOC-113..): first finding fixed (ADR 0020, B-093). Run in progress.
- 2026-10-30 Provider fallback chains done (ADR 0019, opt-in `fallback` on a route). Session resume not built. Next: deploy and run Minesweeper (Unity prototype).
- 2026-10-30 P4 done: milestone check tasks for prototypes and the opt-in worker-side result report (ADR 0018). The report flag is untested against a live Paperclip: enable `ORCHESTRATOR_WORKER_REPORTS=1` for one task first. Reconcile is unchanged (still the backstop). Next: provider fallback chains and session resume (tokens), doctor checks, live Minesweeper run.
- 2026-10-30 P3 done: `.meta` heal in verify, similar-line folding, stack profiles + packs, `npm run onboard` (ADR 0017). Not run against a real Editor or a real Spring/Angular repo yet. Next: P4 (result outbox, reconcile reduction), milestone review, doctor checks for mvn/gradle.
- 2026-10-30 P2 done: lanes and tiers (ADR 0015, test/lanes.test.ts). New bootstrap projects get `tier`; existing manifests keep the full pipeline until given one. Needs build, worker restart and bridge rebuild. Next: milestone review task kind for prototypes, P3 gates and stack packs.
- 2026-10-30 P1 done: durable pause on provider quota and network loss (ADR 0016, test/provider-pause.test.ts); needs build + worker restart to take effect. Next: P2 pipeline lanes/tiers. Not built yet: session resume after a pause, provider fallback chains.
- 2026-10-30: B-087 (forced Codex) is withdrawn; manifests route again with Claude implementing. See docs/engineering/research/orchestration-v2-redesign.md for the analysis and the v2 plan (P0 stabilization done in this change).
- LOC-92's failed Codex-linked retry is being reconciled and retried under Codex routing; its prior worktree contains OpenSpec planning artifacts and no product code changes.

- Phase: hardening through the e2e passes and the Paperclip runs (LOC-38, LOC-39). Real project e2e (dino-runner) green; CI green on the branch.
- Done: B-001..B-014, B-017..B-019, B-028, B-033 (drain-aware deploy), B-038 (visual verification), B-039 (OpenSpec delta correction). B-015 is partly done (SECURITY.md, PR template, Dependabot); LICENSE waits on the owner.
- In progress: B-027 (restart supervision done; the build stamp, where the worker logs its git SHA and doctor compares it to HEAD, is open).
- Open (todo), by next-up order: B-024 Paperclip-hop e2e (needs user decision), B-030 allow-list (FM-026), B-035 then B-026 then B-016 (cost accounting and budgets), B-031 review completeness, B-029 eval harness, B-034, B-032, B-036. Deferred with triggers: B-020 (superseded by B-029), B-021, B-022, B-023.
- Remote: origin https://github.com/rambosoft/orchestration-code. main = baseline only. mission/hardening pushed regularly. No PR opened.
- Test project: rambosoft/dino-runner (private), draft PRs stacked.
- Deploy: use `npm run deploy:worker [-WaitMinutes N]` (refuses while a run is in flight); `npm run drain` checks only. The bridge container redeploy is not drain-aware yet.
- Known gaps: Paperclip adapter hop only partly tested live; no token/cost budgets; no worker build stamp; review is weak at completeness; Claude implement can run npm/node (FM-026).
- Resume: read BACKLOG.md, run doctor, take the first todo by tier and score. Lessons are in research/lessons.md, failure modes FM-017..FM-037.

## 2026-10-23 update
- LOC-38 (difficulty curve, run 4) completed through Paperclip: all stages, analysis doc, draft PR rambosoft/dino-runner#5, one size warning shown (spec 10298 chars). It survived the worker being down ~38 min (Temporal held the workflow).
- FM-037 mitigated (adapter detaches on lease loss; deployed via Paperclip restart). Open: reconcile command not built.
- B-033 added `dev drain` and `scripts/deploy-worker.ps1`.

## 2026-10-23 update (task types, B-040)
- Done: task-type registry and label routing, bug flow (parallel diagnose and reproduce with cross-fed hints, verified reproduction, regression gate, `needs_info`), research and architecture flow (bounded context pack, report as draft doc PR and issue comment). ADR 0008. Replay fixture unchanged.
- Verified: unit and workflow tests with the fake provider (typed-flows, task-types suites) and the existing suites. Not verified: a real Codex or Claude run of the new flows, a live Paperclip label reaching the bridge, a real GitHub document PR.
- Next: deploy (build, restart worker, `docker compose up -d --build orchestrator`, Paperclip adapter restart), create a `type:bug` and a `type:research` issue on a test project and read the comments; then decide on the refactor type.

## 2026-10-23 update (bootstrap design)
- ADR 0009 (Proposed): Paperclip plugin for the wizard UI plus a `bootstrap` task type. Backlog B-041..B-044 added, no code yet. Next: verify the plugin launcher slot and install persistence, then B-041.

## 2026-10-23 update (project bootstrap, ADR 0009)
- Done: B-041, B-042, B-043; B-044 partly (contract and agent guides are written into every generated repository and every task points at the contract; a workflow-level channel for the contract is open). Plugin installed and ready in Paperclip (`orchestrator.project-bootstrap`), bridge image rebuilt, worker redeployed, Paperclip container recreated (compose carry-over bug on Windows, FM-042).
- Verified: unit, workflow, chaos, adapter, doctor and plugin tests; live runs through Paperclip with real Codex (planning), Claude (implementation) and Codex (review) for the Aurora Store prototype. The plugin worker's bridge call is covered by unit tests only: Paperclip has no environment-backed secret provider, so someone must create a secret holding `ORCHESTRATOR_API_TOKEN` and choose it in the plugin settings (runbook section 6).
- Not verified: the wizard inside a signed-in browser (the browser pane was not signed in; the page is tested with a stubbed host and the real catalog).
- Next: sign in once, set the plugin secret, create a project from the wizard; add `integratedBaseBranch` support if parallel plans are wanted; consider moving the contract into the task prompt through a `patched()` workflow channel.

## 2026-10-23 update (UI/UX direction and plugin setup)
- Done: B-048 (maturity-scaled design bar, page directions, DESIGN_DIRECTION.md, skills always applied to generated projects; ADR 0010) and B-049 (`npm run plugin:setup`, guided setup panel). Typecheck, 503 tests and the plugin tests pass.
- Not verified: `plugin:setup` against the live Paperclip (needs an instance-admin `PAPERCLIP_API_TOKEN`); a new project built with the design direction.
- Next: `npm run build`, `npm run plugin:build`, `docker compose up -d --build orchestrator` and the Windows-safe Paperclip recreate (runbook section 8, not `docker compose up -d paperclip`), restart the worker, then `npm run plugin:setup`, reload New AI project, and build a project to judge the result.

## 2026-10-24 update (parallel plans and contract channel, ADR 0011)
- Done: B-044 (global drift rules in `bootstrap.global.json`, precedence global > project contract > task), B-046 (option `plan_mode=parallel`, worker-built integration branch per task for several blockers), B-047 (contract block in the plan, implement and review prompts). FM-042 mitigated (runbook section 8: stop, `rm -f`, `up -d --no-build`), FM-045 added. The earlier `aurora-store-prototype` local folder and its worktrees are deleted.
- Verified: typecheck, `check:chars`, build, the full existing suite (40 files, 503 tests, replay fixture unchanged) and `test/stacking.test.ts` (17 tests: plan blockers, real-Git integration base incl. conflict, retry and moved parent, stack base, contract reading, workflow with an assembled base and a contract). No `patched()` needed (ADR 0011).
- Not verified: a live parallel project through Paperclip and GitHub; a live task showing the contract block in a real Claude or Codex prompt. The GitHub repo `rambosoft/aurora-store-prototype` still exists: the `gh` login lacks the `delete_repo` scope (`gh auth refresh -h github.com -s delete_repo`, then `gh repo delete rambosoft/aurora-store-prototype --yes`).
- Next: `npm run build`, restart the worker, `docker compose up -d --build orchestrator`; create a small project with `plan_mode=parallel` and watch the first task that has two blockers.

## 2026-10-24 update (Unity support, phase 1)
- Done: B-050. Stack profiles (`node-web` default, `unity-mobile`), manifest `stack` field with superRefine that only allows `unity test|build|recompile` for the unity profile (no `--`, no editor path, no installs, declared `--execute-method` only), reproduction commands reject `unity`, `prepareProjectDependencies` imports a detected Unity worktree through `unity run` before npm. No workflow change, replay fixture unchanged.
- Verified: typecheck, check:chars, 42 files and 545 tests pass; Unity CLI spike (EditMode, PlayMode capture, Android AAB) recorded in research/unity-game-support.md section 5c.
- Next: B-051 (Unity gates), then B-052..B-055 in order.

## 2026-10-24 update (Unity support, phase 2)
- Done: B-051. Unity gates inside the verify activity: default timeouts, stale report removal, NUnit report must exist with tests and no failures, declared build output must exist, exit-code hints; `visual.engine: "unity"` runs the project's PlayMode capture test and copies `Logs/screenshots/*.png` to the review; hygiene script in `templates/unity-mobile-2d/scripts/`. Verified: typecheck, check:chars, 44 files and 565 tests. No workflow change.

## 2026-10-24 update (Unity support, phases 3 and 4)
- Done: B-052 (game design stage `design` between charter and blueprint: GameDesign schema with numbered rules R-001.., edge cases, screens, feel, test cases; validated, repaired once, fallback to the requester's own sentences; shown in the approval summary; written to docs/GAME_DESIGN.md and docs/RULES_SPEC.md; in the chaos table) and B-053 (options product_kind/engine/game_*, Unity stack decided without a model, game blueprint rules and visual bar, `unity-mobile-2d` template in templates/, scaffold that creates the project with the real Editor, copies the template, imports, proves EditMode tests and hygiene, Unity manifest with the unity-mobile stack, Claude may run the Unity CLI and loads the official plugin through UNITY_AGENT_PLUGIN_DIR).
- Verified: typecheck, check:chars, build, 45 files and 601 tests; a REAL scaffold on this host (127 s, EditMode proof, hygiene, commit), then PlayMode (20 s, screenshot written) and an Android AAB (13.9 MB, 5 min 52 s) on the generated project.
- Workflow impact: new `design` command only for game bootstrap runs (no existing sequence changed, replay fixture unchanged).
- Next: B-054 (ADRs 0012/0013, doctor checks, plugin checkout), then B-055 (live 2048 project through Paperclip).

## 2026-10-24 update (Unity support, phase 5)
- Done: B-054. ADR 0012 (stack profiles, Unity gates) and 0013 (game projects), doctor `unity:*` checks, `npm run unity:plugin` (pins Unity's official agent plugin at 3831ddb), `ORCHESTRATOR_WORKTREES_DIR`, failure modes FM-046..FM-049, config-schema and project-types updated. 46 files, 607 tests pass.
- Next: B-055, the live 2048-like project: rebuild, restart worker and bridge, create it in Paperclip, approve the game design and plan, let the tasks run.

## 2026-10-24 update (first live game run: gates tightened)
- Live run: project Tile Merge 2048 (LOC-68), repo rambosoft/tile-merge-2048, 5 milestones, 16 tasks. T1, T2 and T3 published draft PRs. T3's first run was interrupted by a machine and Docker restart (Paperclip adapter lost; recovery needed a board-level reconciliation resolve) and hit the old 30 minute limit; its second run passed every gate but the review found 3 blocking gaps the tests had not caught.
- Fixes (FM-050, FM-051): numbered acceptance criteria with a verify gate (`Covers:` / `Deferred:`), blank-frame guard in the capture helper, planning rule against criteria that depend on later tasks, stray Unity Editor stop, 60 minute implement limit, reconcile every 3 minutes by the worker supervisor, `ORCHESTRATOR_WORKTREES_DIR`.
- Verified: 48 files, 619 tests; real Unity: the guard fails a blank frame and passes a real one on a fresh scaffold.

## 2026-10-24 PAUSED (Tile Merge 2048, B-055)
- Paused on purpose after T6: the operator's model budget is used up. Nothing is running (drain: none). Worker restarted with the newest build; doctor passes, including the five `unity:*` checks.
- Done: LOC-68 bootstrap, T1 (PR 1), T2 (PR 2), T3 (PR 3, accepted by the operator, findings carried to LOC-79 and LOC-81), T4 (PR 4), T5 (PR 5, under the new acceptance gate), T6 (PR 6). Repo: rambosoft/tile-merge-2048 (private), all PRs are drafts.
- Held: LOC-77 (T7, save and resume) is in `backlog` so it does not start; T8 to T16 wait behind it through their blockers.
- Resume: set LOC-77 back to `todo` (Paperclip UI, or `PATCH /api/issues/aa0879a2-eade-4ef0-8c88-c608bbfe82da {"status":"todo"}` with the board token). The chain then continues by itself; the worker supervisor reconciles finished results every 3 minutes. If a task ends in `needs_review`, decide as operator (accept: set done; or comment and re-run). If Paperclip refuses to wake a task after a lost run ("execution reconciliation required"), resolve the recovery action through `POST /api/issues/<id>/recovery-actions/resolve` with the recovery action id from the issue's `executionBlocker`.
- Remaining after resume: T7 to T16, then the end-to-end check of the finished game (Android build, screenshots of every screen, rule coverage with `node scripts/check-unity-hygiene.mjs --strict-rules`).

## 2026-10-24 update (affected tests only, every project)
- Every implementation prompt now carries a TEST STRATEGY paragraph (`src/test-strategy.ts`): while working run only the tests the change can affect, the full suite once at the end; the hint names the stack's way (Unity `--filter`, `--affected --since HEAD`, `--rerun-failed`; Vitest `--changed` and `related`; Jest `--onlyChanged`; `node --test <file>`). Generated agent guides carry the same line. The orchestration's own gate still runs the full suite once per verify, so nothing reaches review unverified (not changed: an affected-only gate for repair rounds is not built).
- Takes effect after the worker restart (the prompt is built in the workflow bundle). No workflow command changed; replay fixture unchanged.

## 2026-10-24 update (recovery tooling and runbook)
- Added `npm run resume-run -- <failed workflow id>` (`src/client.ts` `resumeRun`, `nextResumeId`, tested): resumes a failed run with the original input and run id so only the failed stage and what follows execute (measured on T12: plan, brief and implement reused). Runbook `docs/engineering/runbooks/recover-tasks.md` covers every case met in the live Unity run; FM-053 to FM-055 added.

## 2026-10-25 update (speed analysis, B-056)
- Measured from `data/logs/worker-activity-events.jsonl` (39 real runs): implement is 343 of 534 minutes (median 3.7, p90 22); first review rejected 17 of 39; on Node projects the OpenSpec/analysis chain costs about as much as implementing; Unity tasks are 30-57 minutes (implement 3-35, verify 3-20, a repair round doubles it). Worktree, install, import and publish time was not logged until now.
- Finding: a failed deterministic gate has no repair path (the run fails), which is why the agent runs the slow build itself and the gate repeats it. B-057 adds that path; until then the agent keeps self-verifying. Plan and order: B-056, B-057, B-058, B-059, B-060, B-061.
- Done: B-056. Not verified: the new events on a live worker (needs build, worker restart).

## 2026-10-26 update (Tier 1, B-062)
- Done: Unity preflight + doctor checks, per-stack publish exclusion of generated output, reuse of a passing quality run. Analysis and plan: research/unity-run-learnings.md. Full suite 686 passed; replay fixture unchanged.
- Not verified live: needs `npm run deploy:worker` and a Unity task; the tile-merge-2048 `.utmp/` cleanup is draft PR rambosoft/tile-merge-2048#21 (not merged).
- Next (from the analysis): failure classifier with auto-resume and gate repair pass (B-057, needs patched() and replay fixture), reconcile as a service, vertical-slice gate, cheaper review, milestone PRs, token budgets, Unity feature library.

## 2026-10-26 update (feature library design, B-067)
- ADR 0014 written (Proposed, no code). Next for it: B-068 (schemas and CLI) once the speed items B-057/B-058/B-059 are done; the pilot (B-070) waits for B-057, B-059 and the Spring Boot/React profiles (B-060).

## 2026-10-26 update (feature library, game first)
- ADR 0014 now records the decisions for the first Unity plus Spring Boot game and the optional milestone library check. Start the game with only the feature-folder rules (B-072); detector prototype on the Tile Merge 2048 pull requests (B-077) and the hand harvest of its shell (B-073) run in parallel; Spring Boot template and linked projects (B-074, B-075) before the game gets server milestones.

## 2026-10-26 update (Tier 1b and Tier 2, B-063..B-066, B-079)
- Done: gate repair pass (B-057), failure classifier and automatic resume, reconcile service in the worker (first real cycle ran), vertical-slice gate, review prefilter and coverage table, stack-pr, token accounting and budgets. Status table: research/unity-run-learnings.md section 8.
- Verified: unit and workflow tests, the slice harness in a real Unity Editor on a copy of tile-merge-2048, the usage report on the real run data. Not verified: a live Unity task through the new gates; the bridge container still runs the old server.ts (budget not passed until it is rebuilt).
- Next: feature library (ADR 0014, other session), device stage, eval harness, a cheaper review model tier.

## 2026-10-26 update (input and output trimming, B-080..B-083)
- Done: review digest on a stack table for all families, log and trace compactor, agent commands per stack plus rtk err hint, NUnit and JUnit report reader, short implementer report. The review problem (reviewer saw build output, not code) is fixed at the source.
- Verified: unit and workflow tests, a real-git test that reproduces the first game's diff composition; the digest, compactor and report parsers on realistic Spring Boot, Unity, Node, Python, Go and Rust samples. Not verified: a live task; a Spring Boot manifest with a declared report (no spring-boot profile exists yet, B-060).
- Next: stack profiles for spring-boot, react-ts (B-060) can now reuse the table; Graphify pilot only on a large brownfield repo, measured with npm run usage.

## 2026-10-26 update (contract digest, answer shape, RTK hook, plugins off, B-084..B-086)
- Done: the three remaining items of the trimming plan, plus a finding from measuring: every orchestrated Claude session inherited the operator's plugins (about 15 000 tokens of a 51 000 token start, re-read every turn); they are now off for orchestrated runs. The RTK hook is verified with the real CLI.
- Verified: unit tests, the hook and plugin switch through the real Claude CLI (command counter, context size, task completed). Not verified: a full task; the stricter ORCHESTRATOR_CLAUDE_SETTING_SOURCES option on a real project.
- Next: run the next game and compare `npm run usage` with the first game (about 640 k cost units per task); Graphify only as a measured pilot on a large existing codebase.
