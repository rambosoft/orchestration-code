# ADR 0024: A failed task rests in review, never blocked; a run storm is stopped; the CLI's real error is kept

Status: Accepted (2026-10-30). Found in the first live run of the v2 plan (Minesweeper, task LOC-132). Corrects ADR 0022 decision 1.

## Context
- ADR 0022 made the adapter set a failed task to `blocked` with an `unblockDescriptor`. Paperclip wakes a blocked task whose blockers are all done (`issue_blockers_resolved`) at once. The failed LOC-132 was therefore started again immediately, failed again, was set blocked again, and so on: 225 workflows in three hours, one every 20 to 80 seconds. Every attempt prepared a full Unity worktree and left it behind, 225 of them in `C:\w`; the disk filled, and the later attempts failed the 15 GB preflight. Before ADR 0022 the HTTP 422 on `blocked` had accidentally prevented the loop.
- The failures were `provider_error` with the message "Warning: no stdin data received in 3s...". That is a harmless warning the Claude CLI prints; the real error (the full disk) is in the JSON answer on stdout, which the error text ignored. The failure classifier, which already knows ENOSPC as an environment failure, never saw it.

## Decision
1. A run that ends failed, or needs information, sets the task to `in_review` with the report as the comment (adapter, reconcile step and worker report alike). `in_review` does not wake: LOC-116 stayed there for 40 minutes without a rerun. Dependents keep waiting because the task is not done. `statusPatch` and the descriptor of ADR 0022 are removed.
2. A circuit breaker in the adapter: before dispatching, it counts the runs the task started in the last 30 minutes; at six or more it posts a comment, sets the task to `in_review` and starts nothing. Any other future cause of a self-waking failure ends there instead of filling the disk.
3. `cliFailureText` builds the message of a failed CLI run: known noise lines are dropped and, when stderr has nothing else, the result text of the JSON answer (or the tail of stdout) is used. A full disk now reads as `ENOSPC ...` and is classified as an environment failure.

## Consequences
- A failed task needs a person (or the reconcile step's auto-resume for environment failures); it no longer restarts itself.
- The breaker counts runs of any status, so a legitimate task with many resumes in half an hour stops too; the comment says how to continue.
- Not done here: removing the worktrees a failed attempt leaves behind (a separate clean-up), and a bridge-side limit.
- Tests: `test/adapter-resilience.test.ts` (in review, breaker), `test/reconcile.test.ts`, `test/result-report.test.ts`, `test/provider-pause.test.ts` (CLI failure text).
