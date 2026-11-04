# Task-size gate and adaptive stages: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tasks are sized when they are generated, each task runs only the stages and tests it needs, and a run that cannot finish because it is too big stops early, is not blindly retried, and ends in a "needs split" state for a person.

**Architecture:** Extend what exists instead of adding a parallel mechanism: lanes and tiers (`src/lanes.ts`, ADR 0015/0029/0030) already choose stages by size, `gateCommandsFor` already limits per-task gates, `failure-class.ts` already classifies failures, and `plan-from-survey.ts` already sizes backlog items. New work is a pure size estimator, manifest configuration, a failure kind `size`, a progress guard in the Codex provider, a clean retry, and one batched, additive workflow change.

**Tech Stack:** TypeScript 5.9 strict ESM (`.js` suffix on relative imports), zod 4, vitest 4, Temporal TS SDK 1.24.0.

**Spec:** `docs/superpowers/specs/2026-11-04-task-size-gate-design.md` (brief: `docs/engineering/research/orchestration-reliability-playbook.md`).

## Global Constraints
- Workflow code must stay deterministic (no fs, Date, random). Source files are LF.
- Every workflow-code change is marked **WORKFLOW** below. Rule: an edit that changes the command sequence needs `patched("<name>")` and `UPDATE_REPLAY_FIXTURE=1 npx vitest run test/replay.test.ts`. The WORKFLOW steps here only read new optional input fields and add data to results, so they are expected to need no `patched()`; Task 9 proves it with the unchanged replay test and adds `patched()` if the replay fails.
- Tests: affected tests per task (`npx vitest run test/<file>.test.ts`); the full suite once, in Task 11. `npm run typecheck` and `npm run check:chars` before each commit.
- Stage by explicit path; commit `type(scope): summary [B-NNN]`; push only `mission/hardening`; no PRs.
- No new dependency. After each task: BACKLOG.md row, STATUS.md line, `CHANGELOG-MISSION.md` entry, `failure-modes.yaml` where a failure mode changes.
- Defaults must leave every existing project, test and replay fixture unchanged: every new manifest field is optional and absent means today's behaviour.
- Verify and its quality commands are never skipped for code tasks. Every skipped stage records a reason.
- After code changes: `npm run build`, restart the host worker; bridge-side changes also `docker compose up -d --build orchestrator`.

## Review Focus
- A task with no file information (text names no paths): size is `normal`, basis `unknown`, never an error.
- A backlog item with an empty `old_paths` list: not treated as small.
- A manifest without `sizing`/`testScope`/`lanes`: byte-identical behaviour.
- A stage override that omits `implement` or `verify` on a code task: rejected at admission with a readable message.
- A Codex run that legitimately runs a 20-minute build with no file change: must not be killed while its event stream shows commands/turns.
- A non-implement stage timing out: must not be labelled size-suspected.
- A repair round after failed verify (attempt 1 of a new activity): must keep its edits; only a Temporal retry (attempt > 1) cleans the worktree.
- A mixed-case or Windows-path file list (`src\a\B.ts`): same area as `src/a/B.ts`.

---

### Task 1: Size estimator (pure)
**Workflow code: no.**

**Files:**
- Create: `src/task-size.ts`, `test/task-size.test.ts`
- Modify: `docs/engineering/BACKLOG.md` (add one row per task of this plan, next free B-numbers; use the Task's number in commits)

**Interfaces:**
- Produces:
  - `export type SizeLimits = { smallMaxFiles: number; largeMinFiles: number; maxAreas: number }`
  - `export const DEFAULT_SIZE_LIMITS: Record<Tier, SizeLimits>` with `throwaway` and `prototype` `{ smallMaxFiles: 3, largeMinFiles: 40, maxAreas: 6 }`, `mvp` `{ smallMaxFiles: 2, largeMinFiles: 12, maxAreas: 3 }`, `production` `{ smallMaxFiles: 2, largeMinFiles: 10, maxAreas: 2 }` (**my call** for mvp and prototype values; production is the operator's 3 to 10 files, 1 to 2 areas)
  - `export type SizeEstimate = { hint: SizeHint; files: number; areas: number; basis: "measured" | "text" | "unknown"; reasons: string[] }`
  - `export function estimateSize(input: { files: string[]; basis?: "measured" | "text" }, limits: SizeLimits): SizeEstimate`
  - `export function areaOf(file: string): string` (first path segment under `src/`, `app/`, `packages/<name>` style roots, else first segment; backslashes normalized)
  - `export function filesNamedIn(text: string): string[]` (relative paths with a known source extension found in task text, de-duplicated)
- `SizeHint` and `Tier` come from `src/lanes.ts`.

- [ ] **Step 1: Write failing tests** in `test/task-size.test.ts`: `estimateSize({files: []}, limits)` returns `hint: "normal"`, `basis: "unknown"`; 2 files in one area is `small`; 11 files in `production` is `large` with a reason naming the limit; 3 files in 3 areas on `production` is `large` (areas > 2); `src\a\B.ts` and `src/a/B.ts` count as one file in one area; `filesNamedIn("edit src/app/App.tsx and src/app/App.tsx")` returns one path.
- [ ] **Step 2:** Run `npx vitest run test/task-size.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the signatures above in `src/task-size.ts`. Small: `files <= smallMaxFiles` and one area. Large: `files >= largeMinFiles` or `areas > maxAreas`. Else normal. Empty list: `unknown`, `normal`.
- [ ] **Step 4:** Run the test. Expected: PASS. Run `npm run typecheck`.
- [ ] **Step 5: Commit** `git add src/task-size.ts test/task-size.test.ts docs/engineering/BACKLOG.md` then `git commit -m "feat(sizing): pure task size estimator with per-tier limits [B-NNN]"`.

### Task 2: Manifest configuration
**Workflow code: no.**

**Files:**
- Modify: `src/contracts.ts` (add to `ProjectManifestSchema` beside `tier`, line 126), `docs/engineering/knowledge/config-schema.md`
- Test: `test/manifest-index.test.ts` (extend) or a new `test/sizing-config.test.ts`

**Interfaces:**
- Produces, all optional on the manifest:
  - `sizing: z.object({ smallMaxFiles, largeMinFiles, maxAreas: z.number().int().min(1).max(500).optional(), onSizeFailure: z.enum(["manual","propose","auto"]).default("manual"), firstEditMinutes: z.number().int().min(1).max(240).default(15), idleMinutes: z.number().int().min(1).max(240).default(10) })`
  - `testScope: z.enum(["affected","full"]).optional()` (affected: commands marked `scope:"milestone"` gate only the milestone check task, on every tier; full: every command gates every task; absent: today's behaviour)
  - `lanes: z.partialRecord(z.enum(LANES), z.array(z.enum(["plan","brief","implement","review","verify"])).min(1)).optional()` (stage list per lane for this project)
  - `export function sizeLimitsFor(project: Pick<ProjectManifest,"tier"|"sizing">): SizeLimits` in `src/task-size.ts`: tier defaults (absent tier = `production`) overridden by the manifest's three numbers.
- `onSizeFailure` other than `manual` is accepted and stored but has no behaviour yet (**my call**: the design makes manual first).

- [ ] **Step 1: Failing tests:** a manifest without the new fields parses to the same value as before; `sizing: { largeMinFiles: 8 }` yields `sizeLimitsFor` `largeMinFiles` 8 and production defaults elsewhere; `lanes: { light: [] }` and `testScope: "x"` fail validation.
- [ ] **Step 2:** Run the test; expect FAIL.
- [ ] **Step 3: Implement** the schema fields and `sizeLimitsFor`; document each field in `config-schema.md`.
- [ ] **Step 4:** Run the test and `npx vitest run test/manifest-index.test.ts`; expect PASS; typecheck.
- [ ] **Step 5: Commit** `feat(config): sizing, testScope and lanes manifest options [B-NNN]`.

### Task 3: Test-scope policy
**Workflow code: no** (bridge side; `src/server.ts:106` runs outside the workflow).

**Files:** Modify `src/lanes.ts:36` and `src/server.ts:106`; test in `test/lanes.test.ts`.

**Interfaces:** Change to `export function gateCommandsFor<T extends { scope?: "milestone" }>(tier: Tier | undefined, commands: readonly T[], taskTitle?: string, testScope?: "affected" | "full"): T[]`. `full` returns all commands. `affected` applies the existing milestone filter for every tier (not only prototype) and still returns all commands for a milestone check title and when every command is milestone-scoped. Absent: unchanged behaviour. `server.ts` passes `project.testScope`.

- [ ] **Step 1: Failing tests** in `test/lanes.test.ts`: `affected` on tier `production` drops a `scope:"milestone"` command for a normal title and keeps it for `"Check milestone: x"`; `full` on `prototype` keeps it for a normal title; `testScope` undefined on `production` keeps all (today's behaviour).
- [ ] **Step 2:** Run `npx vitest run test/lanes.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** and pass `project.testScope` at `src/server.ts:106`.
- [ ] **Step 4:** Run `npx vitest run test/lanes.test.ts test/core.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat(gates): manifest testScope selects per-task or full gates [B-NNN]`.

### Task 4: Size gate at task generation
**Workflow code: no.**

**Files:** Modify `src/plan-from-survey.ts` (`planFromBacklog`, line 54 onward), `src/bootstrap.ts` (blueprint prompt near line 103), `src/cli.ts` if it prints the plan; test in `test/plan-from-survey.test.ts`, `test/bootstrap.test.ts`.

**Interfaces:**
- Consumes: `estimateSize`, `sizeLimitsFor` (Tasks 1, 2).
- Produces: `planFromBacklog` options gain `limits?: SizeLimits` and `mergeSmall?: boolean`; the return gains `needsSplit: Array<{ id: string; title: string; files: number; areas: number; reasons: string[]; proposal: Array<{ title: string; files: string[] }> }>`. Items estimated `large` are left out of `spec.tasks` and listed in `needsSplit` with `proposal` made by grouping `old_paths` by `areaOf` and chunking each group to `limits.largeMinFiles - 1` files. Each generated task prompt gains a `Lane: light|heavy` line from `laneFor(hint)` when the hint is not `normal`. With `mergeSmall`, consecutive items with the same `area`, both `small`, no dependency between them, and `critical: false` merge into one task whose id is `A+B` and whose acceptance criteria are both lists; merging runs only here, before any issue exists.
- The bootstrap blueprint prompt gets one sentence stating the tier's `largeMinFiles` and `maxAreas` so the model splits tasks to fit.

- [ ] **Step 1: Failing tests:** an item with 14 `old_paths` across 3 areas on `production` appears in `needsSplit` with a proposal whose every part is under the limit and is absent from `spec.tasks`; a small item's prompt contains `Lane: light`; `prototype` limits keep the 14-file item; two small same-area items merge with `mergeSmall`, not without it; a critical item never merges; `old_paths: []` is `normal`, not `small`.
- [ ] **Step 2:** Run `npx vitest run test/plan-from-survey.test.ts test/bootstrap.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** in `planFromBacklog`; keep the existing signature working when the new options are absent. Add the blueprint sentence in `src/bootstrap.ts`.
- [ ] **Step 4:** Run both test files; expect PASS. The existing survey tests must pass unchanged.
- [ ] **Step 5: Commit** `feat(plan): size gate at task generation with split proposals [B-NNN]`.

### Task 5: Size-suspected failure class, no automatic resume
**Workflow code: no** (`failure-class.ts` is pure and imported by the workflow only for the gate check at `src/workflows.ts:324`; the classification change is not read on that path).

**Files:** Modify `src/failure-class.ts`, `src/reconcile.ts`; test in `test/failure-class.test.ts`, `test/reconcile.test.ts`.

**Interfaces:** Add `"size"` to `FailureKind`. `classifyFailure` returns `{ kind: "size", action: "escalate", reason }` before the TRANSIENT check when the message matches `/\bno progress\b|SizeSuspected/i`, or matches `/timed out after|stalled: no output/i` and the message also names the implement stage. Without that context, timeouts stay `transient` (**review focus**). Today a timeout is `transient` and the reconcile service resumes it automatically, which is how a too-big task keeps being paid for; `reconcile.ts` must not auto-resume `size`.

- [ ] **Step 1: Failing tests:** `classifyFailure({ message: "implement: codex no progress: no file change for 10 minutes (activity before the kill: 3 command_execution; 2 turn(s))" })` is `size`/`escalate`; `"implement: codex timed out after 2700000ms"` is `size`; the same timeout text prefixed `review:` stays `transient`; `isResumable` is false for `size`.
- [ ] **Step 2:** Run both test files; expect FAIL.
- [ ] **Step 3: Implement.** The stage name reaches the classifier through the failure message prefix `implement:` produced by the activity (Task 6 guarantees the prefix; if a message has no stage, stay `transient`).
- [ ] **Step 4:** Run `npx vitest run test/failure-class.test.ts test/reconcile.test.ts test/reconcile-service.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat(failure): size-suspected class is escalated, never auto-resumed [B-NNN]`.

### Task 6: Clean retry and no blind retry
**Workflow code: no** (activity code).

**Files:** Modify `src/activities.ts` (`executeStageInner`, retry failure handling near lines 449-457); test `test/non-retryable.test.ts` or a new `test/clean-retry.test.ts`.

**Interfaces:** In `executeStageInner`, when `info.attempt > 1` and `input.stage === "implement"`, run `git reset --hard HEAD` then `git clean -fd` in `input.projectRoot` before the provider starts and record a warning `clean-retry: discarded the previous attempt's edits`. A thrown implement error whose message is size-suspected (Task 5 patterns) becomes `ApplicationFailure.nonRetryable(message, "SizeSuspected")`; every thrown implement error is prefixed `implement: `. The worktree is committed only at publish (`src/workspaces.ts:109`), so HEAD is the base commit and the reset discards exactly the previous attempt.

- [ ] **Step 1: Failing tests:** with an injected git runner, attempt 2 of implement issues reset and clean, attempt 1 does not, a review attempt 2 does not; a provider error "codex no progress ..." from the implement stage is non-retryable; "codex exited 1" from implement stays retryable.
- [ ] **Step 2:** Run the test; expect FAIL.
- [ ] **Step 3: Implement** with the same git helper style as `src/workspaces.ts`. Ignored files (node_modules) are untouched by `clean -fd`.
- [ ] **Step 4:** Run the test and `npx vitest run test/non-retryable.test.ts test/heartbeating.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat(retry): attempt 2 of implement starts clean; size failures are not retried [B-NNN]`.

### Task 7: No-progress guard (worker side)
**Workflow code: no** (provider code; reads an optional `StageInput.progress`).

**Files:**
- Create: `src/progress-guard.ts`, `test/progress-guard.test.ts`
- Modify: `src/providers.ts` (`CliProvider.run`, stall timer at lines 236-238), `src/contracts.ts` (add optional `progress` to `StageInput`)

**Interfaces:**
- Produces:
  - `export type ProgressLimits = { firstEditMs: number; idleMs: number }`
  - `export type ProgressState = { startedAt: number; now: number; firstChangeAt?: number; lastProgressAt: number }`
  - `export function progressVerdict(state: ProgressState, limits: ProgressLimits): "ok" | "no_first_edit" | "idle"`
  - `StageInput.progress?: { firstEditMinutes: number; idleMinutes: number }`
- Behaviour in `CliProvider`: only for `codex` and stage `implement` when `input.progress` is present. Every 30 seconds sample `git status --porcelain` in `input.projectRoot`; progress is a changed signature or a higher count of completed commands and turns in the Codex event stream (`parseCodexTelemetry`). On a verdict other than `ok`, kill the process tree and reject with `codex no progress: <reason> (activity before the kill: ...)`.
- **Correction to the design:** the design said the guard watches the worktree for every provider. The Claude CLI prints its answer at the end, so a quiet 10 minutes is normal there and a file-change-only guard would kill good runs. The guard applies to Codex, where the event stream shows work. The existing output-silence watchdog (`stallLimitMs`, 45 minutes) stays for Codex as a backstop.

- [ ] **Step 1: Failing tests** for `progressVerdict`: no change by 15 minutes is `no_first_edit`; change at minute 3 then silence to minute 14 is `idle` at 10 minutes after the last progress; command activity resets `lastProgressAt`; before limits it is `ok`. A provider-level test with fake timers and a fake child: no progress kills the child and rejects with the "no progress" message; a run with steady events and no file change is not killed.
- [ ] **Step 2:** Run `npx vitest run test/progress-guard.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the pure verdict and wire it into `CliProvider.run` beside the stall timer; clear the new interval wherever `stallTimer` is cleared.
- [ ] **Step 4:** Run `npx vitest run test/progress-guard.test.ts test/heartbeating.test.ts test/claude-stdin-prompt.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat(providers): Codex implement stops when it makes no progress [B-NNN]`.

### Task 8: Per-task and per-project stage lists (admission side)
**Workflow code: no** (bridge side), but it creates the input field Task 9 consumes.

**Files:** Modify `src/openspec-policy.ts` (`parseTaskDirectives`, line 24), `src/server.ts` (lines 95-96), `src/contracts.ts` (workflow input type, the declaration beside `lane` at line 176); tests in `test/lanes.test.ts`, a bridge test beside the existing lane admission tests.

**Interfaces:**
- Directive `Stages: implement, review, verify` parsed into `stages?: LaneStage[]`; unknown names are an admission error.
- Resolution order at `server.ts`: task `Stages:` line, then manifest `lanes[lane]`, then the table (`lanePlan`). The result is carried as new optional workflow input `stageList?: LaneStage[]` plus `stageListReason?: string`.
- Validation: a code task's list must contain `implement` and `verify`; otherwise HTTP 400 with "a code task cannot skip implement or verify".
- Admission also records `sizeEstimate` (Task 1 `estimateSize` over `filesNamedIn(prompt)`, basis `text` or `unknown`) as optional input `size?: SizeEstimate`, and when it is `large` and the run continues, `sizeWarning?: string`. Per the operator: warn and continue, never stop here. **Correction to the design:** a plan-stage check cannot see files (the plan has no file list, `src/handoffs.ts:52`), so the warning comes from the task text at admission and from the real changed-file count after implement (Task 9).

- [ ] **Step 1: Failing tests:** `Stages: implement, verify` yields `stageList`; `Stages: plan, review` is rejected; manifest `lanes.light = ["implement","review","verify"]` applies when the task names no stages; a task naming 14 files on `production` is admitted with `sizeWarning`.
- [ ] **Step 2:** Run the tests; expect FAIL.
- [ ] **Step 3: Implement** the directive, resolution, validation and input fields.
- [ ] **Step 4:** Run `npx vitest run test/lanes.test.ts test/core.test.ts` plus the bridge test; expect PASS.
- [ ] **Step 5: Commit** `feat(stages): per-task Stages line and per-project lane lists [B-NNN]`.

### Task 9: Workflow wiring (batched, additive)
**Workflow code: YES. Needs the replay check. `patched()` expected not to be needed.**

**Files:** Modify `src/workflows.ts` (stage list at lines 605-609, the `executeStage` input construction, the failure return paths, the `escalationReasons` call at line 789), `src/lanes.ts` (`escalationReasons` accepts limits); tests `test/replay.test.ts` (must pass unchanged), `test/typed-flows.test.ts` or a new `test/size-flow.test.ts`.

**Interfaces:**
- Consumes `input.stageList`, `input.stageListReason`, `input.size`, `input.sizeWarning`, `sizing` limits (Tasks 2, 8).
- Behaviour, all gated on the new fields being present so recorded runs behave as before:
  1. `stageList` replaces `lane.stages` at line 609 and pushes a warning `{ stage, message: "stage list set: <reason>" }`.
  2. Implement's `StageInput.progress` is filled from `input.sizing` (defaults 15 and 10).
  3. `escalationReasons(stats, unmet, limits?)` uses the tier's `largeMinFiles` for the file limit when `limits` is given (default stays 15 and 600).
  4. A failed run whose `classifyFailure` is `size` returns `status: "failed"` with `metadata.size = { kind: "size_suspected", reason, estimate: input.size, changedFiles }` and a message starting `needs split:`.
  5. `input.sizeWarning` is added to the run warnings.
- No new activity, timer or signal: the command sequence is unchanged.

- [ ] **Step 1: Failing tests:** an in-memory workflow run with a fake provider and `stageList: ["implement","verify"]` executes exactly those stages and records the reason; with `[INJECT_...]` forcing a "no progress" implement failure the result has `metadata.size.kind === "size_suspected"` and the message starts `needs split:`; a run with none of the new fields produces the same stage sequence as before.
- [ ] **Step 2:** Run `npx vitest run test/size-flow.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the five behaviours. Do not move or reorder any existing `await`.
- [ ] **Step 4:** Run `npx vitest run test/size-flow.test.ts test/replay.test.ts test/lanes.test.ts`. Expected: PASS and the replay fixture unchanged (`git status` shows no change under `test/fixtures/`). If replay fails, wrap the offending block in `patched("size-gate")`, run `UPDATE_REPLAY_FIXTURE=1 npx vitest run test/replay.test.ts`, and record the versioning impact in `docs/engineering/EXTENDING.md` and the ADR.
- [ ] **Step 5: Commit** `feat(workflow): consume stage lists, progress limits and size evidence (additive, replay unchanged) [B-NNN]`.

### Task 10: Needs-split report and size tracking
**Workflow code: no.**

**Files:**
- Create: `src/size-report.ts`, `test/size-report.test.ts`
- Modify: `src/activities.ts` (`reportResultTo`, line 216 area) or `src/result-report.ts`; `src/e2e.ts` (`--record`); `src/cli.ts` (command `size-report`); `package.json` script `size-report`

**Interfaces:**
- `export function proposeSplit(files: string[], limits: SizeLimits): Array<{ title: string; files: string[] }>` (the grouping from Task 4, moved here and reused).
- `export function sizeReport(records: Array<{ estimate?: SizeEstimate; status: string; failureKind?: string; changedFiles?: number; attempts?: number }>): { bands: Record<SizeHint, { runs: number; failed: number; sizeSuspected: number }>; advice: string[] }`. Advice names a threshold to lower when `sizeSuspected` is at least 2 and at least 25% of a band's runs (**my call**).
- The Paperclip report for a `needs split:` result lists the evidence (changed files, minutes, activity counts) and the `proposeSplit` parts as a comment for a person; no issues are created (manual mode).
- `e2e --record` writes `estimate`, `failureKind` and `changedFiles` per task into the run record.

- [ ] **Step 1: Failing tests:** `proposeSplit` of 14 files over 3 areas returns parts each under the limit with every file exactly once; `sizeReport` over a fixture of records flags the `large` band when 3 of 4 runs are size-suspected and says nothing when none are; the result report for a `needs split:` result contains the proposal text.
- [ ] **Step 2:** Run `npx vitest run test/size-report.test.ts test/result-report.test.ts`; expect FAIL.
- [ ] **Step 3: Implement** the three pieces and the CLI command (`node dist/src/cli.js size-report <records dir>` printing the bands and advice).
- [ ] **Step 4:** Run those tests plus `npx vitest run test/e2e-driver.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `feat(sizing): needs-split report and size-vs-outcome tracking [B-NNN]`.

### Task 11: ADR, docs, closeout and verification
**Workflow code: no** (documentation and verification).

**Files:** Create `docs/adr/0039-task-size-gate.md` (use the next free ADR number); modify `docs/engineering/EXTENDING.md`, `docs/engineering/knowledge/failure-modes.yaml` (new FM for "task too big for one pass", mitigation = size gate; keep FM-068 open), `docs/engineering/STATUS.md`, `docs/engineering/CHANGELOG-MISSION.md`, `test/chaos.test.ts` only if a structured stage was added (none is planned).

- [ ] **Step 1:** Write the ADR: decision, the lane/tier reuse, the Codex-only guard correction, the two size warnings (admission from task text, after implement from changed files), the versioning impact of Task 9 (state the replay result), and what is deferred (auto split, hygiene and FM-068 recovery, model routing, checkpoint commits).
- [ ] **Step 2:** Dry run: feed the R3 shape (a backlog item with 14 files over 3 areas, tier `production`) through `planFromBacklog` and confirm it lands in `needsSplit`; record the output in `findings.md`.
- [ ] **Step 3:** Run `npm run typecheck`, `npm run check:chars`, then the full suite once: `npx vitest run`. Expected: all pass, `test/fixtures/` unchanged.
- [ ] **Step 4:** `npm run build`, restart the host worker, `docker compose up -d --build orchestrator`, `npm run doctor`. Do not start LOC-174, LOC-172 or LOC-173 until the dry run and the suite pass.
- [ ] **Step 5: Commit** docs with `docs(sizing): ADR, failure mode, status and changelog [B-NNN]`; push only `mission/hardening` when the operator asks.

## Out of scope (separate items, in order)
Failed-run hygiene and FM-068 chain-recovery command; model routing and review failover; checkpoint commits for resuming partial work; automatic splitting (`onSizeFailure: propose|auto`).
