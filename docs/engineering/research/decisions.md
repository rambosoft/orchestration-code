# Decision matrix

| ID | Topic | Decision | Evidence | Validation |
|---|---|---|---|---|
| D-01 | Keep Temporal + Paperclip + OpenSpec stack | adopt (keep) | ADRs 0001-0004; no demonstrated benefit of replacing | n/a |
| D-02 | Heartbeats + cancel child process | adopt | source #1; FM-003 | B-004 test |
| D-03 | Non-retryable error classes | adopt | source #2; FM-004 | B-005 test |
| D-04 | Replay test in CI | adopt | source #4; FM-013 | B-011 |
| D-05 | Ponytail | adapt principles only | ponytail.md | prompt unit test; effect unverified |
| D-06 | Scoped env for child processes | adopt | FM-001, industry practice (opinion) | B-001 test |
| D-07 | Container/VM sandbox for untrusted code | defer | large (L); host worker needs provider auth locally (ADR 0003). Upgrade trigger: first multi-tenant or untrusted-repo use | |
| D-08 | Replace OpenSpec / add new spec tool | reject | no evidence of problem | |
| D-09 | Migrate to OpenHands / SWE-agent runtime | reject | not researched; migration risk high; no demonstrated benefit | |
| D-10 | Model routing, prompt caching, cost accounting | defer | needs real provider usage data (none available) | trigger: first authenticated real run |
| D-11 | Per-profile toolchains (python/go/...) | defer | L effort; one verified stack today. Trigger: second real project type needed | B-021 |
| D-12 | Eval harness with golden tasks | defer | needs real providers to be meaningful; fake provider gives only pipeline tests | B-020 |
| D-13 | Reference projects built through orchestrator | defer | cannot run real providers; fake-provider "projects" would be fabricated evidence | B-020 |
| D-14 | Refactor projectWorkflow monolith | defer | risk without replay tests; do after B-011 | |

D-15: workflow edits that change command sequence use patched(); see B-006 (approval-timeout). Pattern for future workflow changes.
| D-16 | LLM artifact failures | adopt: validate, one bounded repair with the validator's diagnostics, validate again (OpenSpec proposal, archive spec errors, checklist) | e2e FM-017/018/021 | test/openspec-repair.test.ts |
| D-17 | Early cross-artifact checks | adopt: validate deltas against main specs before implement | FM-018 | test/openspec-delta.test.ts |
| D-18 | Stage budgets | adopt derived caps, invariant tests, brief hard ceiling 1.5x; reject unlimited budgets | FM-019 | test/handoffs.test.ts |
| D-19 | Node path | adopt realpath at startup; reject per-spawn re-resolution | FM-022 | test/node-path.test.ts |
| D-20 | e2e harness | adopt `npm run e2e` chain driver over the bridge API (stacking, attempts, usage summary); the Paperclip hop is tested separately (B-024) | e2e run | test/e2e-driver.test.ts |
| D-21 | Model selection for CLI providers | adopt precedence: manifest route model, then CODEX_MODEL, then pinned default | hard-coded gpt-6-luna | test/untrusted-notice.test.ts |
| D-22 | Claude CLI flags | adopt --max-budget-usd and an --allowedTools allow-list; reject --max-turns (absent from this CLI's help) | claude --help | test/untrusted-notice.test.ts |
| D-23 | Preflight | adopt `doctor` (providers, worker, bridge, build staleness, environment) | FM-023/024 | test/doctor.test.ts |
| D-24 | Admission dirtiness | adopt own rule (ignore CR-at-EOL-only differences) over git config tweaks; reject core.autocrlf overrides (git status stays stale-dirty) | FM-028 | test/workspaces.test.ts |
| D-25 | Secret scanning | adopt repo-wide scan reusing publish-guard patterns in CI; reject a third-party scanner (no new dependency, one pattern source) | FM-029 | scripts/scan-secrets.ts |
| D-26 | Structured stage failure policy | adopt one policy (validate, repair with diagnostics, deterministic fallback, fail only without fallback) via structuredStage; reject per-stage ad-hoc handling | FM-033; ADR 0006 | test/chaos.test.ts |
| D-27 | Review gate | adopt enforcement for every provider, tolerant parsing, fail closed when unreadable after one restatement, up to 4 rounds | FM-030 | test/chaos.test.ts |
| D-28 | Size policy | adopt soft limit 10000 characters for specifications with a warning, generous input budgets, clamped descriptive text; reject hard failure on size | FM-034 | test/handoffs.test.ts |
| D-29 | Deterministic fallbacks | adopt, built only from validated inputs; they carry every protected constraint and acceptance check | FM-033 | test/robustness.test.ts (fuzz) |
| D-30 | Release gate | adopt the chaos suite in CI; a new structured stage must be added to its table | ADR 0006 | .github/workflows/ci.yml |
