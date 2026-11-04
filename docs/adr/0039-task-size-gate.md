# ADR 0039: A task-size gate keeps implementation passes small and stops paying for oversized ones

Status: Accepted (2026-11-04). Extends ADR 0015 (lanes), ADR 0029 (prototype lane and test scope) and ADR 0030 (tiers). Number 0037 is unused.

## Context
- Luxus task R3 timed out twice at 45 minutes in `implement`. It named 14 files over 3 areas, more than one pass can finish.
- The Temporal retry of `implement` reused the half-written worktree of the previous attempt, so attempt 2 started from edits nobody had verified.
- A timeout was classified `transient`, so reconcile resumed the run automatically and paid for the same oversized task again.
- A Codex run that never edits anything burned the whole 45-minute silence watchdog before failing.

## Decision
Keep a task small enough for one implementation pass, and when it is not, fail early, never retry blindly and hand the split to a person.
1. **Estimator and limits** (`src/task-size.ts`, B-175). `estimateSize` counts files and areas (`areaOf`; root-level files share the area "."), from a measured diff or from the task text (`filesNamedIn`, which ignores framework names such as Node.js). `DEFAULT_SIZE_LIMITS` per tier (`production`: small up to 2 files, large from 10 files, at most 2 areas; `mvp` 2/12/3; `prototype` and `throwaway` 3/40/6). `sizeLimitsFor(manifest)` lays the manifest's `sizing` numbers over the tier defaults.
2. **Manifest options** (B-176, B-177). Optional `sizing`, `testScope` (`affected` applies the milestone filter of ADR 0029 on every tier, `full` gates every task on all commands) and `lanes` (stage list per lane). Absent fields change nothing; no shipped manifest changed.
3. **Generation gate** (B-178). `planFromBacklog` with `limits` leaves large items out of the tasks and lists them in `needsSplit` with a `proposeSplit` proposal (parts grouped by area, each under the large cutoff); small items get `Lane: light`; `mergeSmall` merges consecutive small same-area items (never critical or dependent ones). The `plan-from-survey` CLI passes the limits from the project manifest, takes `--merge-small` and prints a "Needs a split" section (B-184).
4. **Failure class `size`** (B-179). `classifyFailure` returns `size` (escalate) for `no progress` / `SizeSuspected`, or a timeout / stall with the `implement:` prefix, before the transient patterns. Other stages stay transient. A `size` failure is not resumable, so reconcile never auto-resumes it.
5. **Clean retry** (B-180). On attempt 2+ of `implement` the activity runs `git reset --hard HEAD` and `git clean -fd` in the worktree before the provider (warning `clean-retry`); exit codes are checked (`WorktreeResetError`). Implement errors carry an `implement:` prefix.
6. **Codex progress guard** (B-181). A pure `progressVerdict` and a 30-second worktree sampler in `CliProvider.run` kill the process tree and fail with `codex no progress: <reason>` when a Codex implement run makes no first edit (`firstEditMinutes`) or goes idle (`idleMinutes`). A file change, or a Codex command or turn event, counts as progress.
7. **Admission signals** (B-182). A `Stages:` line in the task and the manifest `lanes` lists resolve to run input `stageList` / `stageListReason` (a code task must keep implement and verify, else HTTP 400), plus `sizing`, `size` and `sizeWarning` (large on the task text, from `src/stage-admission.ts`).
8. **Workflow wiring** (B-183). The workflow reads the optional input: `stageList` replaces the lane's stages in canonical order (plan, brief, implement, review, verify, duplicates dropped) with a `stage list set` warning; `sizing` fills the implement `progress` limits; a second warning compares the real changed-file count after implement; a `size` failure becomes a needs-split result.
9. **Report** (B-184). `src/size-report.ts`: `sizeReport` (bands, advice at 2 or more or 25% size-suspected), the "Needs a split" section of the Paperclip result comment, and the `size-report` CLI that compares the estimate with the outcome per run.

## Reuse
Lanes, tiers and the milestone test filter are the existing ones (ADR 0015, 0029, 0030); the gate adds numbers per tier and a failure class, not a new lane or workflow step. `Lane: light` and the lane stage lists are the existing mechanism.

## Corrections found while planning
- The progress guard is Codex-only: only the Codex CLI emits item events and runs in a worktree we can sample; other providers keep the silence watchdog.
- The plan stage produces no file list, so the admission warning comes from the file names in the task text, and the second warning from the real changed-file count after implement.
- Needs-split is a reconcile comment only: no status change and no worker write (FM-054 and the manual-first policy). The issue stays where it was until a person acts.
- While a Codex command is in flight (items started minus completed above zero) the idle verdict is suppressed; the 45-minute silence watchdog backs up a hung command. `no_first_edit` still applies at `firstEditMinutes` and only after a successful worktree sample, so a failing git never kills a run.
- The event counter is independent of the 1 MB stdout cap, so a chatty healthy run is not frozen into a false idle.

## Versioning impact
Task 9 (B-183) adds no workflow command: `stageList`, `sizing` and the size fields are optional run input read by existing steps, and the failure result carries extra data on the existing result. No `patched()` is needed. Evidence: `test/replay.test.ts` passes unchanged against the recorded history and `git status --short test/fixtures` is clean after the full suite. In-flight runs have no `stageList` or `sizing` and behave as before. Task 6's `implement:` prefix and clean retry live in activities, which are not replayed.

## Known limits
- A Temporal StartToClose timeout (`TimeoutFailure`) carries no `implement:` prefix and is not classed `size`; only provider-raised timeouts and no-progress kills are.
- Survey `old_paths` is clamped to 1..8 in `src/survey.ts`, so a survey item can only trip the area-count rule, not the 10-file cutoff; the survey S/M/L size is deliberately not mapped to the gate.
- `changedFiles` is not recorded in `metadata.size` or in e2e records.
- A `Stages:` line is ignored for projects without a tier and for the bug flow, without a warning.
- Manifest `onSizeFailure` is stored but only `manual` behaves.
- The merged task of `mergeSmall` keeps `Lane: light` even if the combined files exceed the small limit; a long merged prompt throws.

## Evidence
Dry run of the R3 shape (14 old paths over `src/a`, `src/b`, `src/c`, set after parsing because the schema clamps to 8) through `planFromBacklog` with `DEFAULT_SIZE_LIMITS.production`: no task is generated; `needsSplit` holds R3 with 14 files, 3 areas, reasons "14 files (large from 10)" and "3 areas (limit 2)", and a proposal of `src/a part 1 [6]`, `src/b part 1 [4]`, `src/c part 1 [4]`, each under 10 files. Pinned by the regression test "leaves a too-large item out of the tasks and proposes parts under the limit" in `test/plan-from-survey.test.ts`.

## Deferred (separate items)
Failed-run hygiene and the FM-068 chain-recovery command; model routing and review failover; checkpoint commits so a retry can resume partial work; automatic splitting (`onSizeFailure: propose|auto`); a second calibration of the `mvp` limits against real runs.

## Operator steps after merge
`npm run build`, restart the host worker (it runs `dist/`), `docker compose up -d --build orchestrator`, `npm run doctor`. Until then the new code is not live.
