# Final report

## Remote
https://github.com/rambosoft/orchestration-code (public). `main` holds only the baseline commit 99c5f00. All work is on `mission/hardening`. CI workflow is on the remote but no GitHub Actions run has appeared (0 runs via API); unverified. No PR, merge, tag or release was created.

## Before / after
Before: an untracked folder inside an unrelated parent repo; 70 tests; no CI, no CLAUDE.md, no knowledge base. After: its own repo, `docs/engineering/` knowledge base, CLAUDE.md, 102 tests (+32), P0/P1 hardening items implemented.

## Backlog status (see BACKLOG.md)
- P0 done: B-001 child env scrub, B-002 publish guard, B-003 bridge hardening.
- P1 done: B-004 heartbeat + cancel kill, B-005 non-retryable errors, B-006 run/approval timeouts, B-007 stage reuse, B-008 duplicate-start runId, B-009 untrusted-content notice, B-011 replay test. B-012 CI written, first run unobserved.
- P2 done: B-013 simplicity policy, B-019 docs/runbook. Partial: B-015 (no LICENSE: owner choice).
- Todo: B-010, B-014, B-018. Deferred with triggers: B-016 budgets, B-017 doctor, B-020 evals/reference projects, B-021 toolchain profiles, B-022 sandbox, B-023 workflow split.

## Decisions
Keep Temporal/Paperclip/OpenSpec. Ponytail: adapt selected principles as a provider-neutral prompt constant, no plugin install (MIT, commit 09c434a; its benchmark is author-run, so effect here is unverified). Details in research/decisions.md.

## Evidence
Typecheck and 102 tests pass (baseline 70). An independent reviewer found 2 high and 5 medium issues in B-001..B-009; the substantiated ones were fixed (-z path listing, agent-made commits scanned, env gaps, OpenRouter cancel, auth regex, import cycle). Replay mutation check: removing a stage is detected; reordering same-type activities is not.

## Not done / unverified
- Phase F: no reference projects were built and no failure injection ran against a live stack. No authenticated real provider exists here; fake-provider runs would be fabricated evidence. Cost/token/latency not measured.
- Real provider runs, real GitHub PR creation, worker-kill recovery on a live stack remain unverified.
- Residual risks: model-written code still runs unsandboxed on the host (B-022); publish guard is regex-based and skips binary content; POSIX process-group kill (FM-015); no token/cost budget.
- Simplicity audit: additions are small (11 new src files incl. guards); no needless layers found; `src/command.ts` exists only to break an import cycle.

## Owner actions on GitHub
Check the Actions tab (CI not observed), choose a LICENSE, protect `main`, enable secret scanning/push protection and Dependabot alerts.

## Review / resume
Compare: https://github.com/rambosoft/orchestration-code/compare/main...mission/hardening . Suggested PR title: "Harden orchestration: security, reliability, CI, knowledge base". Resume via STATUS.md and BACKLOG.md.
