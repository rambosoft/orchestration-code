# Runbook: recover tasks when Paperclip and the orchestration disagree

Everything here was met in the first live Unity game run (Tile Merge 2048, 2026-10-24) or in the earlier runs. Commands run from the repository root after `npm run build`; tokens come from `.env` and are never printed.

## 1. The model in one minute

- **Temporal owns the task.** A task run is one workflow (`pc-<issue id>-<revision>-a<attempt>`). It survives a machine restart, a Docker restart and a worker restart; activities that were running are retried (`MaximumAttempts` 2 for stage activities).
- **Paperclip is the board.** Its adapter starts the workflow, waits for it and reports the result as a comment (with a publication marker `<!-- orchestration-publish {...} -->`) and a status. If the adapter is gone (machine off, Docker restarted, Paperclip restarted) the workflow still finishes, but nobody reports it: the issue shows **blocked** ("requires reconciliation") while the work goes on.
- **`reconcile` is the reporter of last resort.** It reports finished workflows of issues that are `blocked`, `in_progress` or `in_review` (comment with marker, then the status). The worker supervisor runs `reconcile --apply` once at start; its periodic background job was added but **never logged anything in the live run, so do not rely on it**. While tasks run, keep `npm run reconcile:watch` running (a terminal or a scheduled task; every 2 minutes). By hand: `npm run reconcile` (dry run) and `npm run reconcile -- --apply`.
- **The next task starts when its blocker is `done` with a verified publication.** Paperclip's dependency check wants the marker comment of the blocker. A blocker set to `done` by hand without the marker makes the next task fail at once ("Blocker ... is done but has no verified orchestration draft PR metadata").
- **A failed run stays reusable.** The preserved worktree (`<worktrees dir>/<run id>`) and the stage results (`data/artifacts/<issue id>/<run id>/<stage>-<n>.json`) are kept.

## 2. Triage in order

1. Is a workflow really running? `npm run dev -- runs`, or `docker exec test-orch-temporal-1 temporal workflow list --address 127.0.0.1:7233 --limit 5`.
2. If yes, is it alive? `temporal workflow describe --workflow-id <id>`: the pending activity must show `State Started` and a `LastHeartbeatTime` of seconds ago. "Pending activity" is only the name of the section; `Started` plus a fresh heartbeat means it is executing. "Retrying" with `Attempt 2` after a restart is the automatic second attempt (the last one).
3. Is the agent producing? The worktree changes (`git -C <worktree> status`, newest files), and the Claude session transcript (`~/.claude/projects/<worktree path with dashes>/<session>.jsonl`) lists every tool call with timestamps; summing the durations shows where the time went (section 6).
4. If no workflow runs, read the issue: `GET /api/issues/<id>` (status, `blockedBy`, `blockerAttention`, `executionBlocker`) and its comments.

## 3. Cases

| Symptom | Cause | Do |
|---|---|---|
| Issue **blocked**, workflow still **Running** | Adapter lost after a machine, Docker or Paperclip restart | Nothing: wait. The result is reported by reconcile when the workflow ends. Do not restart it. |
| Workflow **Completed** but issue still blocked or in progress | Not reported yet | `npm run reconcile -- --apply` (or wait for the watcher (2 minutes) or run it by hand). |
| Workflow **failed**, early or late stage, worktree preserved | Provider timeout, a flaky test, a gate, a crash | Read why (section 5), then **resume** (section 4). A full restart is only for a lost worktree. |
| Result `needs_review` ("N unresolved review findings", draft PR published) | The review still had blocking findings after the last round | Decide as operator (section 7). The task is `in_review`; the chain waits for you. |
| Next task **failed within seconds**, issue shows an execution lock ("Automatic recovery stopped", `executionBlocker`) | A wakeup ran while a dependency was not verified, or the adapter run was lost | Section 8 (resolve the lock), then make the dependency verified (section 9). |
| Next task will not start though its blocker is done | The blocker has no marker comment, was reopened, or carries an old lock | Section 9. |
| Two workflows for one task | A task was woken twice (a comment plus a status change, or a manual wakeup) | Cancel the newer one (section 10). Its PR would supersede the first. |

## 4. Resume instead of repeating (the failed-in-the-last-stage case)

A run that failed late has done the expensive work: plan, brief, implement, review, repair. `resume-run` starts a new workflow with the **original input and run id**. The activities find the preserved worktree and skip every stage whose saved result has an identical input (hash of stage, provider, model, effort and prompt); only the stage that failed and what follows it executes.

```bash
npm run resume-run -- <workflow id of the failed run>
# prints { workflowId: "<id>-resume1", runId, originalRunId }
```

What is reused and what runs again (measured on the T12 run: plan, brief and implement were reused; review and verify ran again):
- **Reused:** plan, brief, spec stages, implement (including a repair pass whose findings are unchanged), anything with the same prompt.
- **Runs again:** the review stage (its prompt carries the diff and screenshots), a verify that failed (nothing is saved for a failed gate), and everything after.
- The result is a normal run: gates, review, publication, draft PR. The workflow id keeps the issue-id prefix, so `reconcile` reports it.

Steps:
1. Find the cause and make sure the worktree holds the work (`git -C <worktree> status`). Do not edit the agent's code by hand unless you are fixing a real defect on purpose.
2. Clear the Paperclip lock without starting a new run: section 8, outcome `blocked` and `sourceIssueStatus: "blocked"`. Do **not** set the issue to `todo` (Paperclip would start a full new run).
3. `npm run resume-run -- <failed workflow id>`.
4. Watch it: `temporal workflow describe`, or `data/logs/worker-activity-events.jsonl` (`activity.reused` lines name the skipped stages).
5. When it ends, `reconcile` reports it (within 3 minutes) and Paperclip starts the next task. If the issue is already `done` the report is never made: **do not mark a task done by hand before its result is reported.**

A resumed run that fails again can be resumed again (`-resume2`). A worktree that is gone, or a run whose base moved, cannot be resumed; set the issue to `todo` to run it from the start (the new run uses a new branch and supersedes the open PR of the old one).

## 5. Reading why a run failed

- `GET /v1/runs/<workflow id>` (bridge, bearer token): `result.message`, `result.metadata.review.stopReason` (see `operate-and-e2e.md` section 4), stages with `(fail)`.
- `data/artifacts/<issue id>/<run id>/quality-<n>.json`: every gate command with its exit code and duration; the failing one has the output.
- Unity: `<worktree>/Logs/playmode-results.xml` (NUnit): the failing `test-case` and its message. Exit code 8 = tests failed, 6 = no verdict (compile error, licence, crash, timeout).
- `implement-<n>-activity-<m>-failure.json`: a provider timeout or crash (`claude timed out after N ms`).
- Rule of thumb: one failing test out of many that passed on the previous round of the same task is a flaky test, not the task's defect. Wall-clock thresholds (`within 100ms`) measured in batch mode on a loaded machine are the typical case; fix such a test properly (count frames or use a virtual clock), do not widen the number.

## 6. Why a task takes longer than expected (Unity and any large suite)

Sum the Claude session transcript: the T11 run spent 43 of 58 minutes in 7 full PlayMode runs of about 6 minutes. A suite grows with every task. The defence is in place for every project: the implementation prompt tells the agent to run only the affected tests while working and the full suite once at the end (`src/test-strategy.ts`), and the Unity implement limit is 120 minutes (review 30). If a suite still dominates, split heavy capture fixtures from behaviour tests.

## 7. `needs_review`: accept or send back

The PR is published as a draft with the open findings in a comment. Decide per finding:
- Out of scope for this task (it needs a later task): accept, and put the carried-over requirement into the **description** of the later task (never a comment, see section 10).
- Real defect: comment on the task and run it again (`todo`), or fix and resume.
Accept = `PATCH /api/issues/<id> {"status":"done","comment":"..."}` **after** the result was reported (the issue is `in_review` and the marker comment exists).

## 8. Paperclip execution lock ("Automatic recovery stopped")

Paperclip refuses to wake an agent for an issue whose previous run ended without a verified outcome. The issue shows `executionBlocker` with `recoveryActionId` and `runId`. Resolve it with an honest attestation (a board-level statement: write only what is true):

```
POST /api/issues/<id>/recovery-actions/resolve
{ "actionId": "<recoveryActionId>", "outcome": "restored", "sourceIssueStatus": "todo",
  "resolutionNote": "...",
  "executionReconciliation": { "runId": "<runId>", "providerStopped": true,
    "actionOutcome": "not_performed", "outcomeEvidence": "<at least 20 characters of facts>" } }
```
- Verify before you attest: the provider process is gone (the workflow ended), and nothing was published (`git ls-remote --heads <repo> "codex/<issue id>*"`, no PR).
- To keep the issue from starting a new run use `outcome: "blocked"`, `sourceIssueStatus: "blocked"` and no `executionReconciliation`.
- `executionBlocker` may still show after a successful resolve; trust the issue status and the next wakeup.
- Read the failed heartbeat run for the reason: `GET /api/heartbeat-runs/<runId>` (`error`).

## 9. Dependencies that never become ready

- "Blocker X is done but has no verified orchestration draft PR metadata": the blocker was set `done` without the publication comment. Paperclip refuses `done` -> `blocked`, so reconcile cannot report it. Post the result comment with the generator reconcile uses (`resultComment` in `src/reconcile.ts`, includes the marker). A comment on a closed issue **reopens it to `todo` and locks it again**: resolve that lock with `sourceIssueStatus: "done"` and `PATCH status done` right away. Prevention is better: never mark a task done by hand before reconcile has reported it.
- A task shows `blocked` while its blocker is done: it carries an old execution lock (section 8).
- Pause the chain on purpose: set the **next** task to `backlog`; the running one finishes and nothing starts. Resume: set it to `todo`.

## 10. Things that wake an agent (and what not to do)

- **Comments wake the assignee.** A comment on a task that is not running fails immediately if its blockers are not verified and leaves an execution lock. Never comment on tasks that have not started or are done. Put carry-over text into the **description** (`PATCH /api/issues/<id> {"description": ...}`).
- A manual wakeup (`POST /api/agents/<id>/wakeup`) plus a status change can start **two** workflows for one task. Use one trigger only. Cancel a duplicate: `temporal workflow cancel --workflow-id <id>` or `npm run dev -- cancel <id>`; check afterwards that its cancellation did not re-open the issue.
- Restarting Docker, Paperclip or Windows kills adapters: expect the first row of section 3.

## 11. Restarting the worker safely

1. Hold the next task: set it to `backlog`.
2. `node dist/src/cli.js drain --wait-minutes 0` must say no runs in flight (a restart interrupts a running stage; Temporal retries it once, which uses the last attempt).
3. `npm run build`, stop the `run-worker.ps1` supervisor and the `node dist/src/worker.js` process, start the supervisor hidden again (`scripts/run-worker.ps1`); `npm run doctor` must pass.
4. Release the held task (`todo`).
Prompt, workflow and gate changes only take effect after this restart. A bridge change needs `docker compose up -d --build orchestrator`; a manifest change needs `docker compose restart orchestrator`. The worker reads only the names listed in `scripts/run-worker.ps1` from `.env` (add new settings there).

## 12. Unity specifics

- Licence: `npm run doctor` shows `unity:licence`; "No valid Unity Editor license found" (exit 198) means sign in through Unity Hub once.
- Short worktree path: Android builds fail on long paths; keep `ORCHESTRATOR_WORKTREES_DIR=C:/w`.
- One Editor per project: the orchestrator stops stray Editors of a worktree and waits for `Temp/UnityLockfile` before each Unity command. A capture warning "project already open" costs the screenshots of that review round only.
- Acceptance gate: a game task fails verify while a numbered criterion (`T5-AC2`) has no test that says `Covers: T5-AC2` (or an open `Deferred: T5-AC4 -> T8 reason`).

## 13. Operator checklist

- Before a long run: `npm run doctor`, no running workflows you forgot, `.env` loaded by the supervisor.
- While it runs: do not touch finished issues, do not comment on waiting ones.
- After any restart: `npm run reconcile`, then look at the board.
- After a failure: reason (section 5), resume (section 4), let reconcile report, next task.

## 14. Merging the stack of draft PRs

Every task is published as a draft PR whose **base is the previous task's branch** (ADR 0004), so the PRs form a chain (`main` <- T2 <- T3 <- ... <- Tn). Each branch contains all earlier tasks. Merging the PRs one by one from the bottom puts each task into its parent branch only: after the first PR, the rest still point at branches that never reach `main`, and GitHub shows their mergeability as "unknown" for a long time (seen with PRs 2 to 15 of Tile Merge 2048; only the first one reached `main`).

Do one of these instead:
- **Merge the tip once (recommended).** Open one PR from the last branch of the stack into `main`, check it is mergeable (`gh pr view <n> --json mergeable,mergeStateStatus`), merge it with a merge commit (keeps one commit per task), and close the older stacked PRs as superseded with a comment. Check beforehand: `git rev-list --count origin/main..<tip>` (the commits you expect), `git merge-tree --write-tree origin/main <tip>` (no conflicts), and that each stack branch is an ancestor of the tip.
- **Merge from the top down:** merge the last PR into its parent, then that parent into its own parent, and so on up to `main`. Every merge must target a branch that is still part of the chain.
- Tasks published later (a new task after a merge) are based on the previous task's branch again: repeat the first option for them.

`npm run stack-pr` does the first option for you: it finds the open orchestrator PRs of the project clone, retargets the tip PR onto the real base (its diff then holds every stacked commit) and lists the stacked tasks in its description. It is a dry run until `--apply`; `--through <PR number|task id|branch>` cuts the stack at a milestone (the later tasks stay stacked above it); `--close-stacked` closes the intermediate PRs with a pointer to the tip (their branches are kept). It never merges: you merge the tip PR yourself.

```bash
npm run stack-pr -- --repo C:/workspace/orchestration-projects/<project> --through LOC-9
```

## 15. Automatic recovery (reconcile service, classifier, gate repair)

- **Reconcile runs inside the worker.** When `PAPERCLIP_API_TOKEN` is set the worker reports finished workflows to Paperclip every 2 minutes (`ORCHESTRATOR_RECONCILE_SECONDS`, `ORCHESTRATOR_RECONCILE=0` turns it off) and writes `data/logs/reconcile-heartbeat.json` each cycle. `npm run doctor` shows `reconcile:service`: a warning means the file is missing, older than three intervals, or its last cycle failed (the message says which). `npm run reconcile:watch` shows the same loop in a terminal.
- **Ready blocked tasks get a dependency-wake retry.** If Paperclip leaves an assigned task blocked after every first-class blocker is done and no Temporal workflow started for that task, reconcile verifies each blocker has a published orchestration branch, then reasserts the same blocker IDs. Paperclip rechecks readiness and emits its idempotent dependency wake; the orchestrator never clears dependencies or starts work around them. This also recovers a wake lost when a blocker immediately reopens for a queued follow-up run. A blocker without publication metadata is reported and left for repair instead of creating a repeat-failure loop. Before retrying, reconcile checks Paperclip's issue-run history and leaves any task with an unresolved execution-reconciliation hold untouched; that hold must be resolved through Paperclip's supported recovery action.
- **Failures are classified** (`src/failure-class.ts`): *environment* (licence, long path, locked project, disk), *transient* (timeouts, network, rate limits), *gate* (a deterministic check failed because of the code), *model* (unusable answer, review findings left), *external* (approval, credential), *budget*, *unknown*.
- **Transient and environment failures are resumed once, automatically** (`ORCHESTRATOR_AUTO_RESUME=0` turns that off): the reconcile service starts `<id>-resume1` with the saved stage results, only for a run that ended within 6 hours, and posts nothing to the task (a comment wakes the agent and can lock the issue, FM-054). A second failure of the same run is reported as before. Everything else is reported and waits for you.
- **A failed check gets one repair pass inside the run.** A deterministic check that fails because of the code (tests, build, hygiene, acceptance trace, review prefilter) sends its own output to one implement stage and the checks run again; a failure the machine caused is not repaired (a code change cannot fix a licence). The run's final message lists the repair as a warning.
- **Token budget.** A manifest `budget: { maxCostUnits, warnAt }` warns near the limit and stops the run before the next model call with `TokenBudgetExceeded`; raise it with `npm run resume-run -- <workflow id> --budget N`. `npm run usage -- --since 2026-10-24` shows cost units, raw tokens and the cache hit rate per run. Units are input-token equivalents (cache write 1.25x, cache read 0.1x, output 5x); the first game cost about 640 k per task and 1.5 M for the heaviest.
- **Reachability and leftovers.** A screen task must prove it is reachable from the booted game (`SliceHarness.Boot()`), and the verify gate rejects added TODO/FIXME markers, not-implemented stubs, placeholder copy and skipped tests (`orchestrator:allow` on a line is the escape hatch, `ORCHESTRATOR_PREFILTER=0` turns the check off).

## 16. What the model is shown (input and output trimming)

- **Reviewer:** a digest of the change, not a raw diff: every changed file is listed, source/tests/config/docs are shown in that order inside a 60 000 character budget, scenes and prefabs are summarised, generated build output, binaries, lock files and .meta files are only counted (and generated files in the change are reported as a finding). A follow-up round shows only the files that changed since the reviewer last saw them. If a review seems to have missed something, open `artifacts/<task>/<run>/review-diff-<n>.json` and the review prompt to see what was shown.
- **Failures:** a failing check is captured whole and compacted (framework frames folded, repeats counted, error lines kept). The artifact `quality-<n>.json` holds the compacted text. A command with a declared `report` (or a Unity test run) leads with the failing tests.
- **Stacks:** the repository decides, not the project setting: Unity, Node, JVM (Maven/Gradle), .NET, Python, Go and Rust are found from their marker files, per folder, so a Unity client next to a Spring Boot server gets both. Generated-output, test-file conventions and the agent's allowed commands come from one table (`src/stack-traits.ts`); a new stack is one row per rule.
- **Agent output:** with rtk installed, implementing agents run long-output commands as `rtk err <command>` (errors only, same exit code); `rtk recall <id>` prints the full output. `ORCHESTRATOR_RTK=0` stops the hint. The implementer's final message has a fixed short shape (at most 12 bullets).
- **Measure:** `npm run usage -- --since <date>` before and after a change shows cost units and the cache hit rate per run.

## 17. What a Claude session starts with

- A Claude session starts with the skills, agents, hooks and MCP servers of every plugin enabled in the *user* settings of the machine. Measured here: 51 133 tokens before any work, re-read on every turn. Orchestrated runs therefore switch the operator's enabled plugins off (`--settings` with `enabledPlugins` false, read at run time from `~/.claude/settings.json`): 36 095 tokens. A plugin that the project itself enables stays on, and the Unity agent plugin (`--plugin-dir`) is not affected. `ORCHESTRATOR_CLAUDE_USER_PLUGINS=1` turns this off.
- `ORCHESTRATOR_CLAUDE_SETTING_SOURCES=project,local` goes further (31 541 tokens) by ignoring the user settings altogether; the default model then comes from the account rather than from `model` in the user settings, so check it first.
- On stages that run commands, an RTK hook shortens the output of git, Maven, Gradle, pytest, Go, Cargo, dotnet, Vitest/Jest, tsc, npm/pnpm and lint (`src/rtk-claude-hook.ts`). It never rewrites file reads, searches or listings. `rtk gain` shows what it saved; `ORCHESTRATOR_RTK_HOOK=0` turns it off. Commands RTK does not know (unity, npm test) get the `rtk err` hint instead.
- Check a run: `npm run usage` shows cost units and the cache hit rate; the first game was about 640 k cost units per task.
