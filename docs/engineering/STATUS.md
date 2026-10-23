# STATUS (rewritten each update)

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
