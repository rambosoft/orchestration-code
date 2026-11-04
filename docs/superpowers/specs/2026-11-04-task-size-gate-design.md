# Task-size gate and adaptive stage profiles: design

Status: draft for approval. Brief: `docs/engineering/research/orchestration-reliability-playbook.md`. Items marked **(my call)** are the writer's choices, not the operator's.

## Intent and why
The Luxus M1 run showed one task (R3, shell and auth bootstrap) too large for a single implementation pass: implement timed out at 45 minutes twice, each retry paid the full context cost again, and the retry inherited a half-written worktree that never converged. The orchestrator must be reliable and not break on each task. It decides task size early, gives every task only the stages it needs, runs tests where they matter, and records when size caused trouble so thresholds can be tuned.

## The pipeline stays
Plan (reads instructions, agent directions and task context, analyses, picks skills and plugins) -> brief -> implement -> verify (tests) -> review by another agent. Each stage feeds the next. This design changes how much of the pipeline a task gets and how big a task is, not the shape.

## Goals
1. Size is decided when tasks are created: project creation / task generation decides the size of each task and how many tasks there are. The plan stage keeps a lighter safety check for hand-written tasks (**my call**).
2. Right-sized tasks: not trivial (a text colour change) and not huge (a whole feature over tens of files and areas).
3. Each task carries its own stage list, chosen at generation, configurable, overridable per task.
4. Test scope per task is `affected`; the whole app runs at milestone gates; the manifest can force `full` per task.
5. Retries never pay twice for the same size problem and never start from a half edit.
6. Runs that make no progress stop early.
7. Size-related failures are recorded so thresholds can be revisited and lowered from evidence.

## Non-goals and anti-goals
- No automatic splitting of failed tasks yet (manual first, auto later).
- No automatic change of thresholds; a person changes the configuration.
- Not a new workflow engine or a new store: use existing manifest, run metrics, profiles and generators.
- Anti-goal: a task silently given fewer stages than its risk needs; skipping must be a recorded decision with a reason. Anti-goal: size rules that fail runs only because text is long (input size must never fail a run, see `src/handoffs.ts`).

## Decisions by the operator
**Size depends on the project tier.**
- Prototype / from scratch: the codebase is small, tasks may be big (a whole screen or module in one pass).
- Established project: narrow tasks with clear boundaries. Limit starts at about 3 to 10 files in one area, two at most. The operator confirmed this range and wants it easy to configure.
- Affected areas and files are found with the skills, plugins and code-intelligence tools, so the boundary is measured from real code.
- Too-small tasks are merged with a neighbour in the same area (**my call** on the mechanism).

**Stages are chosen per task, configurable.** When all is clear a task may skip analysis, tests or review; some tasks need every stage. A milestone may hold several small light tasks; at its end the milestone check runs the full suite (and review of the whole result).

**What earns every stage:** heavy logic, or touching a core part of the project.
- Core: declared core areas in the manifest (existing `critical` and area fields) and files many others import (fan-in from the intelligence tools).
- Heavy logic: flagged by the plan stage from the task text and affected files, checked against size and fan-in numbers (**my call**, weakest signal).

**Failures from size:** a failure that looks like a size problem (timeout, many files edited without converging, no-progress stop) is recorded as "size suspected". A person later revisits the logic and lowers the thresholds. A test failure or bad model answer is not size suspected.

**Manual first:** after a size-suspected failure the run stops in a "needs split" state with evidence (files touched, time, commands, file changes, turns; the timeout error from commit c9a2591 already carries counts). The orchestrator may propose a split (sub-tasks, acceptance criteria, blockers); a person approves or edits it. A manifest setting `onSizeFailure: manual | propose | auto`, default `manual`, lets this become automatic later without code change (**my call** on name and values).

**No-progress guard** (operator said "use recommended"): first file change within 15 minutes; after that, 10 minutes with no file change and no new command or turn stops the pass as size suspected. Both values configurable next to the size limits (**my call**).

## Constraints from the repository
- Workflow code stays deterministic; a change to the command sequence needs `patched()` and a regenerated replay fixture (`UPDATE_REPLAY_FIXTURE=1 npx vitest run test/replay.test.ts`). Prefer data on existing steps so the replay fixture stays valid.
- Reuse `src/plan-from-survey.ts` (sizes S/M/L, orders by blockers), the plan schema in `src/handoffs.ts`, the `--only/--area` options, `materializeIssues` for bootstrap, `QualityCommandSchema.scope: "milestone"` and `{changed}`, the `affected-tests`, `ts-imports`, `pkg-deps`, `depcruise` intelligence tools (default off; sizing turns them on for generation), `src/profiles.ts`, the milestone check task (ADR 0026, 0029, 0031).
- New config goes in a zod schema in `src/contracts.ts` and is documented in `knowledge/config-schema.md`. Any new structured model stage goes through `structuredStage` with a fallback and a row in `test/chaos.test.ts`.
- Repo rules: failing test first, affected tests per task and the full suite once at the end, stage by explicit path, `type(scope): summary [B-NNN]`, push only `mission/hardening`, update BACKLOG, STATUS, CHANGELOG-MISSION and failure-modes after each item, an ADR for the design.

## Retry and worktree policy
- Cap implement attempts; a size-suspected task is never retried unchanged, in any mode.
- A retry after a non-size failure starts from a clean worktree or the last verified commit, not from the half edit.
- Stop paying for the same task more than twice (**my call**: counted per task across attempts).
- Failed-run hygiene (requirement 5 of the playbook): a failed dispatch must not leave Paperclip escalated; FM-068 chain recovery becomes a command. Model routing (requirement 6) is a separate item after this one.

## Tracking
Each run records its size estimate (files, areas, public surface) beside the outcome (files changed, timeouts, retries, failure label, stages used), in the existing run metrics (`docs/engineering/knowledge/metrics/runs/`). A report compares estimate and outcome per size band and says which threshold to lower when size-suspected failures cluster.

## Left to the builder
Exact size formula and weights, the data shape of the per-task stage list, where the sizing block lives in the manifest, how merge-of-tiny-tasks is implemented, how the plan stage's safety check reports, thresholds per tier beyond the established range, field names in run metrics, ADR number, and phase ordering (the project plan in `task_plan.md` lists phases 1 to 6).

## Operator answers after the builder check
- **Plan-stage check on a hand-written oversized task: warn and continue.** It records the size finding on the run and warns on the issue, and the run goes on. Only real failures (timeout, no-progress stop, non-converging edits) stop a run and set the needs-split state.

## Calls made after the builder check (my calls, for the operator to check)
- **Tier** is the existing optional manifest field `tier` (throwaway, prototype, mvp, production, `src/lanes.ts`). A missing tier is treated as `production` (the strictest sizing). Defaults are given for all four tiers; "established" in this document means mvp and production.
- **Needs-split state** is data on the existing run result and the existing report to Paperclip (`reportResult`), not a new workflow step or outcome, so the command sequence and replay fixture stay unchanged. An approved split comes back as new issues created through the same path as generated tasks; there is no resume signal.
- **Progress measurement** is taken from the worktree itself (changed files seen by git, polled in the stage activity's existing heartbeat loop), so it works for every provider (Codex, Claude CLI, OpenRouter, fake). Command and turn counts are used only where a provider reports them. The guard ends the pass with a labelled error classified as size suspected; it sits below the stage timeout and does not change heartbeats.
- **Stage list default** is today's full pipeline, so existing projects, tests and the replay fixture behave identically. Verify and its quality commands are never skipped for code tasks. Review and analysis may be skipped only on tasks sized small or in milestone mode, as ADR 0031 already allows. Every skip records a reason, and a skipped stage counts as satisfied for status and for the milestone check, which runs the full suite.
- **Unknown size:** when a tool is off, fails, or the target is not TypeScript, size falls back to the file list in the task text and is recorded as "unknown, treated as medium". Public surface is optional in the first version.
- **Retry:** there is no verified intermediate commit (the worktree is committed once, at publish, `src/workspaces.ts:109`). A retry after a non-size failure starts from a fresh worktree at the base commit. Checkpoint commits for resuming partial work are a later option, not part of this design. "Twice per task" counts Temporal activity attempts and Paperclip re-dispatches together.
- **Merging small tasks** happens only at generation time, before issues exist. It never rewrites a board that already has issues.

## Open
- Calibration of tier thresholds other than "established" comes from the R12 and R3 run metrics.
- No live-run evidence yet for the first-edit and no-progress numbers.
