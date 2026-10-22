# Backlog (single prioritized source of truth)

Score = (Impact x Severity + RiskReduction) / Effort(S=1,M=2,L=4). Tier first, score within tier. Status: todo / in-progress / done / deferred / rejected.

| ID | Title | Cat | Tier | Score | Problem + evidence | Smallest solution | Acceptance test | Eff | Deps | Status | Commit | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B-001 | Scope child-process env | security | P0 | 25 | FM-001: quality cmds, npm ci inherit service tokens | `childEnv()` allow-list helper used by runCheck/CLI/openspec spawns | test: spawned process cannot see ORCHESTRATOR_API_TOKEN/PAPERCLIP_API_TOKEN/OPENROUTER_API_KEY | S | - | done | 4694e32 | test/env.test.ts |
| B-002 | Pre-publish guard | security | P0 | 10 | FM-002: `git add --all` + push without checks | `assertPublishable()` before commit: reject .env/key files, secret patterns, files >5MB, node_modules | test with temp repo containing each case | M | - | done | see log | test/publish-guard.test.ts |
| B-003 | Harden bridge | security | P0 | 16 | FM-009: test flags, unbounded body, `!==` token compare | gate flags behind `ORCHESTRATOR_ALLOW_TEST_FLAGS`; 1MB body cap; timingSafeEqual | unit tests on extracted pure helpers | S | - | done | see log | test/http-guard.test.ts |
| B-012 | CI workflow | ci | P1 | 24 | FM-012 no CI | `.github/workflows/ci.yml`: npm ci, typecheck, test; pinned actions; `permissions: contents: read` | workflow green on pushed branch | S | - | todo | | |
| B-009 | Untrusted-content preamble | security | P1 | 16 | FM-010 | constant prepended in `CliProvider` instruction and OpenRouter prompt | unit test asserts preamble in built args | S | - | done | see git log | tests |
| B-006 | Execution timeouts | reliability | P1 | 16 | FM-005 | `workflowExecutionTimeout` in startRun (env-configurable, default 6h); approval wait timeout 24h via `condition(fn, ms)` | workflow test: approval timeout -> failed result | S | - | done | see git log | tests |
| B-005 | Non-retryable errors | reliability | P1 | 15 | FM-004 | throw `ApplicationFailure.nonRetryable` for auth/config/invalid-result in executeStage | test: invalid result -> 1 attempt only | S | - | done | see git log | tests |
| B-004 | Heartbeat + cancel kill | reliability | P1 | 10 | FM-003 | heartbeat timer in executeStage, heartbeatTimeout on proxy, kill provider child on Context cancel | test: cancellation kills a long fake child | M | - | todo | | |
| B-007 | Reuse stage artifact on retry | reliability | P1 | 8 | FM-006 | skip provider if `<stage>-<attempt>.json` exists with same input hash | test: second run reuses | M | B-005 | todo | | |
| B-008 | Correct runId on duplicate start | reliability | P1 | 8 | FM-008 | on AlreadyStarted, describe workflow and return its runId | test with temporal test env | S | - | todo | | |
| B-011 | Replay determinism test | testing | P1 | 6.5 | FM-013 | export history from a test run, replay with `Worker.runReplayHistory` | test passes; fails when workflow edited incompatibly (manual check noted) | M | - | todo | | |
| B-013 | Simplicity policy (Ponytail adapt) | quality | P2 | 8 | research/ponytail.md | `SIMPLICITY_POLICY` constant in implement + review prompts | prompt unit tests | S | - | todo | | |
| B-014 | Startup env validation | ops | P2 | 7 | config-schema gap | zod env schema checked in worker/server start | unit test | S | - | todo | | |
| B-010 | Worktree cleanup command | ops | P2 | 7 | FM-007 | `dev cleanup <runId>` runs `git worktree remove` for terminal runs | temp-repo test | S | - | todo | | |
| B-015 | LICENSE, SECURITY.md, PR template, Dependabot | hygiene | P2 | 5 | no license | add SECURITY.md/PR template/Dependabot (npm); LICENSE needs owner choice | files exist | S | owner | todo | | LICENSE blocked on owner |
| B-016 | Run budgets (tokens/cost/time) | cost | P2 | 8 | FM-005 | per-run budget tracked from provider usage metadata | - | M | real usage data | deferred | | trigger: first authenticated real provider run |
| B-017 | Doctor/diagnose command | recovery | P2 | 6 | stuck-run repair | `dev doctor`: list worktrees, running workflows, stale branches | - | M | B-010 | deferred | | trigger: first manual state repair needed |
| B-018 | Secret scan in CI | security | P2 | 6 | no scanner | reuse B-002 scanner as `npm run scan` in CI | CI step green | S | B-002,B-012 | todo | | |
| B-019 | EXTENDING.md + runbooks + README accuracy | docs | P2 | 5 | handover | write at end | files exist | S | all | todo | | |
| B-020 | Eval harness + reference projects | eval | P3 | - | D-12, D-13 | needs authenticated real providers | - | L | real provider | deferred | | trigger: authenticated codex/openrouter available; fake-provider runs would be fabricated evidence |
| B-021 | Per-stack toolchain profiles | generality | P3 | - | FM-011, D-11 | profile files for python/go/etc. | - | L | B-020 | deferred | | trigger: second real project type |
| B-022 | Container sandbox for untrusted code | security | P3 | - | D-07 | run quality cmds in container | - | L | | deferred | | trigger: untrusted repos or multi-tenant |
| B-023 | Split projectWorkflow | refactor | P3 | - | D-14 | extract stage helpers | replay test unchanged | M | B-011 | deferred | | trigger: next workflow feature |
