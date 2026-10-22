# Operator guide: projects, tasks, runs, and results

This guide describes the normal Paperclip → Temporal → Windows worker path. Paperclip owns the project and issue board. Assigning an issue to the `temporal_orchestrator` agent starts the Temporal workflow; Temporal owns the workflow lifecycle. Do not also start the same issue from the CLI while its Paperclip workflow is running.

## UI/UX skill guidance

The orchestrator selects portable UI/UX guidance for UI implementation tasks and sends it in the planning, implementation/repair, and review prompts. This works with the configured CLI providers and OpenRouter because guidance travels in the stage prompt; it does not depend on a provider's native skill installation. Framework selection is inferred from the project's root `package.json` dependencies. For monorepos or incomplete manifests, use project `uiUx.include` to force an applicable skill.

Global defaults live in [`uiux.global.json`](../uiux.global.json), which Compose mounts read-only into the bridge. Set `ORCHESTRATOR_UIUX_CONFIG` to a different path inside the container to use another JSON file; mount that file into the container as well. The local CLI resolves the path from its current working directory. If the config file is absent, defaults enable automatic selection and include no forced or excluded skills. A project manifest can override these settings:

```json
{
  "uiUx": {
    "enabled": true,
    "autoSelect": true,
    "include": ["vercel-composition-patterns"],
    "exclude": ["ui-ux-pro-max"]
  }
}
```

`enabled: false` disables skill guidance for that project. `autoSelect: false` disables task-based selection while still allowing explicitly included skills. Project inclusions override global exclusions; exclusions otherwise suppress automatic selection. Available IDs are `ui-ux-pro-max`, `frontend-design`, `vercel-composition-patterns`, and `vercel-react-native-skills`.

The catalog is pinned and maintained in `src/uiux.ts`; update source references and attribution when changing it. Current guidance is a compact, independently written prompt summary. In particular, UI UX Pro Max's searchable dataset and Python scripts are not bundled or run, so the orchestrator does not claim to generate that upstream tool's full design-system report. The frontend-design entry is original interoperability guidance referencing Anthropic's skill; its full text is not redistributed. Framework and task detection is intentionally conservative and can be overridden with `include`/`exclude`.

## Quick start: the normal feature workflow

One `temporal_orchestrator` agent can serve multiple projects. The Paperclip issue's `projectId` chooses the matching orchestrator manifest; do not pin the shared agent's adapter config to a project. For new projects, put each checkout below the shared `ORCHESTRATOR_PROJECTS_ROOT`, set the manifest `root` to its relative folder and `containerRoot` to `/workspace/projects/<folder>`, and mount that shared root once in both containers. Legacy projects with `rootEnv` continue to work with their existing mounts. Each code project still needs its own manifest, GitHub remote/target branch, and clean checkout.

For an already configured project such as Calculator, adding a feature normally requires **one well-scoped Paperclip task**, not a hand-made analysis task, implementation task, review task, and test task. The orchestrator runs those stages using the project manifest: MiniMax plans and reviews, Codex implements and repairs, and deterministic commands verify the result.

1. Open the correct project in Paperclip and create one issue for a coherent, user-visible feature.
2. Write the requested behavior, boundaries, and testable acceptance criteria into the issue. Name exact test commands where known. Say whether the change must preserve existing behavior. Never include credentials.
3. Decide its dependencies before assigning it. If it depends on another unfinished change, add a **Blocked by** relation to that issue. If it is independent, leave it unblocked.
4. Confirm the project's Temporal orchestrator agent is assigned and the issue is ready (no blockers), then assign the issue to that agent. Assignment triggers execution; do not separately run `npm run dev -- run` for the same Paperclip issue.
5. Watch the issue activity for `Temporal workflow started: ...`; use the workflow ID to inspect stages in Temporal UI at `http://localhost:8233`.
6. On success, check the deterministic verification result and draft PR link. `Done` means the gates passed and the draft PR was created; it does not mean the PR was merged.

Example issue text:

> Add a percentage button to the calculator. It applies the existing calculator's percentage semantics to the current operand. Keep the UI responsive and keyboard accessible. Add tests for whole numbers, decimals, and chained operations. Run `npm test`. Do not change other arithmetic behavior.

Create separate issues only when they represent distinct deliverables, need different owners/review boundaries, or must be sequenced/parallelized independently. For ordinary implementation, planning, review, repairs, and testing are internal workflow stages.

## OpenSpec for implementation tasks

OpenSpec is enabled by default for implementation profiles. The worker uses the pinned `@fission-ai/openspec` 1.14.3 CLI (Node.js 20.19 or newer) and Codex's `$openspec-propose` workflow. On the first enabled task for a repository, it initializes OpenSpec in the isolated task worktree with the Codex skills. The first PR therefore includes the project OpenSpec setup along with its change artifacts.

Before proposal generation, the worker installs locked npm dependencies with `npm ci` when the project has both `package.json` and `package-lock.json`. This makes project tools such as Playwright available in a fresh isolated worktree; installation failures stop the run before OpenSpec or planning.

Set a project default in its manifest:

```json
"openSpec": { "enabled": false }
```

Omit `openSpec` or set `enabled` to `true` to use the default. A task can override that setting by adding one standalone line to its title, description, or prompt:

```text
OpenSpec: off
```

Use `OpenSpec: on` to enable it for one task in a project where it is disabled. The marker is removed before the task prompt reaches providers. Conflicting on/off markers stop dispatch with an error. Research-only profiles do not run OpenSpec.

For an enabled implementation task, the Codex OpenSpec stage creates a proposal, behavior delta specs, a design when needed, and a task checklist. The CLI strictly validates the change before a dedicated semantic optimization stage creates the planning digest and one-sentence task goal. That digest must retain every requirement, scenario, and hard constraint from the validated source; schema, budget, and coverage failures stop the workflow without discarding the source artifact. Planning consumes the task goal and digest rather than repeating the original task prose. Planning produces compact decisions; a separate brief builder converts those decisions and authoritative requirements into the execution brief. Implementation receives the brief and applicable UI/UX and validation guidance. Review receives the brief checklist, implementation summary, applicable UI/UX checks, and complete current diff. After review and deterministic quality checks pass, the worker archives the change, updates the project's main specs, validates those specs, and publishes the branch. Missing CLI/version mismatch, incomplete or invalid artifacts, incomplete checklist, or archive failure stops publication and preserves the worktree for recovery. There is no implicit skip; disable OpenSpec on the project or task when needed.

Inspect the `openspec` and `spec_optimize` stages in Temporal history and artifacts under `data/artifacts/<task-id>/<run-id>/`. The context file preserves the complete validated source; the optimizer artifact records its compact digest and coverage counts. Project `openspec/specs/` contains the current requirements, and `openspec/changes/archive/` retains completed proposals and checklists.

## Worker availability and implementation timing

Run `npm run worker:install` once in PowerShell to register a hidden Windows Task Scheduler job for the current signed-in user. The job starts at sign-in and restarts after unexpected worker exits. Structured Activity events go to `data/logs/worker-activity-events.jsonl`; host process output goes to `data/logs/worker-console.log`. It uses the current user's Codex login. If a worker is already running when you install it, that process is not interrupted; the scheduled task takes over at the next sign-in. Check Task Scheduler for the task named `Paperclip Temporal Orchestration Worker` and inspect its Last Run Result and logs if a queue stalls.

Worker JSON logs record each Activity's schedule-to-start queue wait, attempt/retry count, provider runtime, and total Activity duration. A `activity.queue_wait_alert` warns when the wait reaches `ORCHESTRATOR_QUEUE_WAIT_ALERT_MS` (default 60 seconds). Stage artifacts retain Activity duration, queue wait, provider duration, and Codex JSONL event/item counts and token usage when the CLI returns them. These measurements separate worker availability delays from actual agent work; gather a baseline before setting a task latency target.

For a controlled Codex implementation comparison, set `providerRouting.implement.reasoningEffort` to `low` in a disposable project manifest and compare against the omitted setting (Codex's existing default) on the same representative tasks in separate worktrees. Do not change the default project route based on speed alone: compare OpenSpec completion, acceptance coverage, deterministic results, review blockers, repair count, and elapsed stage time. Keep the current route unless the faster setting meets the same quality bar. The setting is optional and applies to Codex implementation and repair; it does not affect planning, review, OpenSpec, or other providers.

## Start a new project, step by step

1. **Prepare the repository.** Create a project folder below the host `ORCHESTRATOR_PROJECTS_ROOT` (outside this orchestration checkout), clone or initialize its Git repository, set `origin` and the target branch, install its dependencies, and commit a complete baseline. Confirm `git status --porcelain` is empty and `gh auth status` succeeds. The orchestrator rejects dirty checkouts, including untracked files; it will not stage or commit existing user work.
2. **Create the Paperclip project.** In Paperclip, create a project and record its project ID. Configure its primary workspace to `/workspace/projects/<folder>` inside Paperclip; that path maps to the matching Windows folder beneath `ORCHESTRATOR_PROJECTS_ROOT`.
3. **Use the shared Docker mount.** Compose mounts the common host project root once at `/workspace/projects` in both `paperclip` and `orchestrator`. No per-project Compose change is needed. Recreate services only when the shared mount changes, then verify the project folder exists inside both containers.
4. **Create the manifest.** Copy `project.example.json` to `projects/<slug>.json`. Set its `id` to the Paperclip project ID, `root` to the folder name relative to `ORCHESTRATOR_PROJECTS_ROOT`, and `containerRoot` to `/workspace/projects/<folder>`. Add the Git remote and target branch, required source paths, quality commands, and desired stage routing/profile. Keep secrets out of this file.
5. **Configure the worker.** Keep `ORCHESTRATOR_PROJECTS_ROOT` and `OPENROUTER_API_KEY` in the ignored `.env`; keep Codex authenticated through its host CLI login. Do not pass provider keys to Docker, Paperclip connections, workflow inputs, or issue prompts. Restart the Windows worker after env changes. Recreate the orchestrator after manifest changes.
6. **Connect the Paperclip agent.** Reuse the shared `temporal_orchestrator` agent and bridge URL `http://orchestrator:3101`; leave adapter `projectId` unset so each assigned issue selects its manifest. Ensure the board API token is configured if task comments/status and dependency checks are enabled. Verify bridge health and the project's mounted folder before assigning real work.
7. **Run a small smoke task.** Use a disposable project or a low-risk change with a clear acceptance command. Confirm the Paperclip issue, Temporal workflow, artifact directory, and draft PR all agree before using the setup for important work.

After setup, everyday feature work is created in Paperclip as described above; do not make a new manifest for every task. A new manifest is needed for a new project or materially different workflow configuration.

## Where to see the exact work

1. **Paperclip issue** (`http://localhost:3100`): open the issue and read its activity/comments. The adapter posts the Temporal workflow ID and a final run summary here. The run's **Logs** view shows adapter output and errors. Use the issue page for the human-readable result and current status.
2. **Temporal UI** (`http://localhost:8233`): find the workflow ID in the Paperclip comment, for example `pc-<issue-id>-<revision>`. Its event history shows each Activity, retry, signal, and result. This is the source of truth for workflow execution and recovery.
3. **Run JSON and stage outputs**: `data/artifacts/<paperclip-issue-id>/<run-id>/`. Open `plan-1.json`, `implement-1.json`, `review-1.json` (and later repair/review attempts), and `quality-1.json`. The final Paperclip comment and Temporal result include artifact paths and publication metadata. Run IDs keep attempts/revisions separate.
4. **Actual project files**: implementation work is on a named task branch in `data/worktrees`. After gates pass, the branch is pushed and a GitHub draft PR is created. The input checkout remains untouched.

## Enable RTK command-output filtering for one project

RTK is an optional Codex implementation-stage hook. It can shorten command output the coding agent reads; it does not change the deterministic quality commands or their exit-code gate. RTK must be installed on the Windows worker, and its project-scoped Codex hook must be present in the target project before enabling the manifest toggle.

1. Install RTK on the Windows worker using its official Windows installer (`winget install rtk-ai.rtk`) and verify `rtk --version` succeeds. If `winget` is unavailable, use the official Windows release ZIP and verify it against the release `checksums.txt`. Ensure the worker's `PATH` includes the RTK binary. The orchestrator does not install or upgrade host software.
2. In the target project checkout, run `rtk init --codex`, review the generated `.codex/hooks.json`, `RTK.md`, and `AGENTS.md` changes, then commit the project-scoped setup. Open Codex in that project, use `/hooks` to inspect and trust the RTK hook, and confirm it is active. Codex skips untrusted project hooks. Keep this hook project-local; do not use `rtk init -g` for a project-specific rollout.
3. In that project's orchestrator manifest, add or enable the RTK plugin:

   ```json
   { "id": "rtk", "version": "0.1.0", "enabled": true, "required": false, "config": { "stages": ["implement"] } }
   ```

   Set `enabled` to `false` to turn it off for the project. Set `required` to `true` only after the worker CLI and committed hook are confirmed; otherwise a missing prerequisite fails the Codex implementation stage. Optional configuration falls back to the ordinary Codex path and records why RTK was inactive in stage metadata.
4. Recreate the orchestrator container after changing a manifest and restart the Windows worker if its `PATH` changed. Run a small task, inspect the implementation artifact's `metadata.commandOutputFiltering` field, and confirm the CLI reports `hook: PreToolUse Completed` with a rewritten command (for example, `rtk git diff HEAD~1`). From that task's worktree, run `rtk gain --project --history`; this confirms project-scoped history and shows RTK's estimated command-output reduction. A manifest check or a hook dry-run alone does not prove that Codex trusted and executed the hook. RTK may warn that no global hook is installed even when the project hook is active. If history reports `SQLITE_CANTOPEN`, merge RTK's displayed data-directory path into `[sandbox_workspace_write].writable_roots` in Codex `config.toml`, preserving existing roots. `rtk bypass <command>` keeps a specific command's output unfiltered when the compact result lacks detail.

The initial integration applies only to Codex `implement` stages, including review repairs. OpenRouter stages and the worker's deterministic quality commands remain unchanged. RTK's savings figures describe command-output reduction and are estimates; compare actual provider usage and acceptance outcomes before enabling it broadly.

For a CLI run, use `npm run dev -- runs` to list workflow IDs and `npm run dev -- inspect <workflow-id>` for the structured stage summaries and artifact references. `npm run dev -- cancel <workflow-id>` cancels an open workflow. `npm run dev -- resume <manifest> <task-id> <same-revision> "<prompt>"` attaches to the same identity; `restart` uses a new revision and creates a new workflow. Use Paperclip assignment/retry for Paperclip issues so its status and Temporal lifecycle remain aligned.

**ECC is not needed to view outputs.** ECC can provide reusable coding practices or commands inside a supported coding harness, but it is not a Paperclip/Temporal run viewer and it does not expose stage history. Use Paperclip, Temporal UI, the JSON artifacts, and the project files above to inspect the work. Keep ECC optional and avoid adding it to a task unless its specific coding guidance is useful.

## Start a new project

1. Create a project folder, preferably under `C:\workspace`, initialize Git, commit a complete baseline, configure a GitHub `origin` and target branch, and confirm `gh auth status` succeeds. Keep it separate from this orchestration repository and from unrelated parent checkouts. The orchestrator rejects both modified tracked files and untracked files; it never snapshots or stages existing changes.
2. Create the project in Paperclip and record its project ID. Set its workspace to the path the Paperclip container can see. On Windows, add the host folder as a bind mount to both the `paperclip` and `orchestrator` services in `docker-compose.yml`. Set `containerRoot` to the orchestrator's mount path (for example `/workspace/my-app`) for Git admission, and use the host checkout path in the root environment variable for the Windows worker. Recreate Paperclip and the orchestrator after changing mounts.
3. Copy `project.example.json` to `projects/<slug>.json`. Set a unique `id`, `name`, project root environment variable, `containerRoot`, `repository.remote`, `repository.targetBranch`, and `repository.requiredSourcePaths` for critical source files; then set supported `defaultProfile`, stage routing, quality commands, plugin requirements, and retry/approval policy. For multi-blocker work, also set `repository.integratedBaseBranch` to a branch that contains every prerequisite commit. Add the root variable to the ignored `.env` and point it at the host checkout. Do not put provider credentials in the manifest.
4. Add the new manifest to the orchestrator's `projects/` directory and set the Paperclip agent's `projectId` to the manifest ID. Compose bind-mounts this directory read-only into the orchestrator, so changes are picked up after recreating the orchestrator container; rebuilding the image is not required. Confirm `http://localhost:3101/health` lists it (authenticated bridge health is available to the configured adapter). Verify the project folder exists on both sides of the bind mount before assigning work.
5. In Paperclip, use the `temporal_orchestrator` adapter with bridge `http://orchestrator:3101`. Keep the OpenRouter key in the ignored `.env`; Codex uses its host CLI login. Restart the Windows worker after credential or manifest changes.

## Create professional task plans

Break a project request into independently reviewable, vertical deliverables. For each issue, specify:

- the user-visible result and scope;
- concrete acceptance criteria, including exact test or quality commands;
- files or areas that may change and important constraints;
- the predecessor issue IDs, when work truly depends on another task.

### Sequential work: one after another

Use separate issues when the deliverable needs a staged rollout or should be independently reviewed. Create the issues and add a Paperclip **Blocked by** relationship for every hard dependency; mentioning another task in prose or making it a child does not enforce ordering. Assign the ready first issue. A dependent issue should remain blocked until its predecessor passes gates, publishes a draft PR, and Paperclip reports `done`. It then branches from the predecessor's published commit and its draft PR targets the predecessor branch, producing a stacked PR. Review/merge the stack bottom-up.

For one feature with a few sequential internal activities, prefer one issue: the workflow itself does plan → implement → review/repair → deterministic verification → publish. Do not create separate plan/review/testing issues unless those are truly separate deliverables.

### Parallel work: independent tasks

Create multiple unblocked issues and assign each to the orchestrator when their changes can safely proceed independently. Each task gets its own branch based on the configured base branch; they do not automatically see or include one another's unmerged work. Add file ownership boundaries to descriptions when there is any chance of overlap. Avoid parallel work when both tasks edit the same feature/files, depend on each other's outputs, or require a shared integration change. For multiple prerequisites, configure an integrated base that already contains every required commit; the system will not silently merge divergent parent branches. Parallelism is bounded by the manifest/worker limits, so queued work may wait for capacity.

Check the dependency graph before assigning. Assigning a ready issue triggers its heartbeat/workflow automatically; do not manually start a second workflow for it.

Prefer one issue per coherent outcome instead of a single huge prompt or many tiny implementation fragments. Ask MiniMax to plan/research/review and Codex to implement/repair through the configured stage routes; deterministic quality commands run on the Windows worker. Do not include API keys or ask an agent to print environment variables.

## Trigger, monitor, and recover

- **Trigger:** in Paperclip, assign the ready issue to the Temporal orchestrator agent (or use its retry/reassign action after a failed run). Confirm a comment with `Temporal workflow started: pc-...` appears.
- **Monitor:** check the issue log/comment and the matching workflow in Temporal UI. The workflow ID is stable for a task revision; repeated triggers for the same revision attach to the same workflow instead of starting a duplicate.
- **Success:** confirm the issue has a final completed status/comment, Temporal reports a completed result, quality checks pass, and the result files are present. Do not infer success from a plan artifact alone.
- **Provider failure:** inspect the failed stage and CLI/API error in the issue log and Temporal history. An OpenRouter 401/429 or server error needs key/account/rate-limit follow-up; a Codex quota/auth failure needs the host CLI usable again. The workflow reports these failures and does not silently switch to fake. A successful plan is not evidence that implementation succeeded.
- **Timeout budget:** CLI provider limits are project-scoped by `providerTimeouts`, in milliseconds keyed by stage. The default is 180 seconds; the configured Activity ceiling is 16 minutes, with two total Activity attempts. Keep a provider timeout below that ceiling with room for setup and artifact writing. Calculator `implement` is set to 720000 ms (12 minutes) after the expression-editor task exceeded the old 3-minute default. A provider timeout is recorded as a structured `*-failure.json` artifact with stage, activity attempt, elapsed time, configured limit, error category, and preserved worktree path. It does not include raw process output or credentials.
- **Implementation and review repair:** implementation and repair prompts require every acceptance criterion to map to changed code and observable test evidence, focused regression coverage, and a complete-diff inspection. They run focused tests for changed behavior; the configured deterministic suite is run by the workflow. Review returns structured findings with severity, category, evidence, acceptance criterion, and code-fixability. Only critical/high code-fixable findings trigger the single repair; the repair prompt turns each finding into a test-backed checklist. The initial review and deterministic suite run concurrently. If repair is needed, the full deterministic suite runs once after repair and before the focused follow-up review; the final provider verification consumes that result without rerunning the suite. Minor polish is non-blocking. Environment or approval prerequisites stop the workflow for operator action and are never sent to Codex as code fixes. The project manifest must explicitly configure required deterministic suites (for example, Calculator implementation includes both `npm test` and `npm run test:e2e`). Two total reviews is the hard maximum. `policy.maxReviewRounds` defaults to `2` and is capped at `2`; legacy `maxRepairAttempts` is accepted temporarily and mapped to total review rounds, capped at `2`. Run results report review/repair counts, findings disposition, provider usage and timing, queue wait, and the stop reason. If the container appears to use a stale setting, inspect `/app/projects/<slug>.json` inside the orchestrator container and recreate it so the live manifest mount is applied.
- **Retry:** first identify and fix the failing stage's cause; preserve the old attempt and inspect any partial worktree before trying again. Then use Paperclip's Retry/recovery action and confirm a new attempt/workflow ID appears. If Paperclip says automatic recovery stopped, repeated clicks on Retry can return `execution_reconciliation_required` without creating a run. Do not repeatedly press Retry or manually start a duplicate. Inspect the failed run, confirm the provider process is stopped, and inspect its worktree. In this installed Paperclip version, an authorized board operator resolves the execution recovery through `POST /api/issues/<issue-id>/recovery-actions/resolve`, with `outcome: "restored"`, `sourceIssueStatus: "todo"`, the current `actionId`, and an `executionReconciliation` record containing the failed `runId`, `providerStopped: true`, an evidence-based `actionOutcome` (`completed`, `not_performed`, or `mixed`), and a concise `outcomeEvidence`. If work partially happened, use `mixed` and describe the preserved changes; never mark uncertain effects as `not_performed`. Resolution queues a successor attempt. Confirm that Paperclip links the new run to the failed one and that its Temporal workflow starts before considering retry successful. Keep the same issue for the same acceptance contract; use a new issue/revision for materially changed scope.

  **Missing recovery action:** if `GET /api/issues/<issue-id>/recovery-actions` returns no active action, or the issue is blocked but Retry responds `execution_reconciliation_required`, stop. Do not set the issue to `todo`, fabricate an `actionId`, or dispatch a direct Temporal run. Keep it blocked, record the failed Paperclip run ID, Temporal workflow ID, stopped-process evidence, worktree path, and failure artifact path in an issue comment, then escalate to a Paperclip board operator/admin to repair the recovery record. Resume only after Paperclip exposes a valid active recovery action or its documented administrative reconciliation path. This is the fallback used for LOC-23, where no action was exposed despite a stopped Codex process and preserved partial work.

Example PowerShell request (fill in the IDs from that issue's recovery/run details; do not paste a key into chat):

```powershell
$line = Get-Content .env | Where-Object { $_ -match '^PAPERCLIP_API_TOKEN=' }
$token = ($line -replace '^PAPERCLIP_API_TOKEN=', '').Trim('"')
$headers = @{ Authorization = "Bearer $token" }
$body = @{
  actionId = '<recovery-action-id>'
  outcome = 'restored'
  sourceIssueStatus = 'todo'
  resolutionNote = '<what you inspected and why it is safe to continue>'
  executionReconciliation = @{
    runId = '<failed-run-id>'
    providerStopped = $true
    actionOutcome = 'mixed'
    outcomeEvidence = '<at least 20 characters describing observed effects and preserved work>'
  }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3100/api/issues/<issue-id>/recovery-actions/resolve' `
  -Headers $headers -ContentType 'application/json' -Body $body
```
- **Dependencies:** when an issue is blocked by another issue, complete/retry the predecessor first. Paperclip should wake the dependent task after all recorded blockers become `done`; do not manually run a blocked dependent issue.
- **Stacked PRs:** a code task becomes Done only after deterministic gates pass and its branch, commit, push, and draft PR are confirmed. A single dependent task stacks on that exact commit and targets its PR branch. For several blockers, the configured integrated base must already contain each published prerequisite commit. After the parent merges, use `npm run dev -- sync-stack <worktree> <child-branch> <parent-pr-url> <target-branch> [remote]` to rebase and retarget the child; resolve any conflict manually.

## Recent Calculator example: LOC-14

LOC-14's plan stage completed using MiniMax, but its implementation Activity failed when the authenticated host Codex CLI returned: `You've hit your usage limit ... try again at Nov 20th, 2026 12:15 AM.` The implementation was therefore not completed, and no review or deterministic verification ran for that attempt. This is confirmed by Temporal's failed Activity history; it was a Codex quota limit, not a MiniMax failure or a review finding. The worktree/artifacts preserve partial work from that attempt. The workflow did not silently fall back to a different coding provider. Restore Codex CLI availability, reconcile the stopped Paperclip recovery state for LOC-14, inspect the partial worktree, and only then explicitly retry. Do not start its dependent LOC-15 until LOC-14 is actually done and has its published draft PR.

After Codex access was restored, the first Retry click still returned `execution_reconciliation_required`; Paperclip correctly held the task because the old attempt had partial uncommitted edits. The stopped run was reconciled as `mixed`, with the `calculator.js` and `index.html` changes preserved in the old worktree, then Paperclip automatically queued a linked successor. The successor completed plan (MiniMax), implementation and repair (Codex), reviews and verification (MiniMax), and deterministic tests (12 passed). LOC-14 is now `done`; its draft PR is [#2](https://github.com/rambosoft/calculator/pull/2), stacked on LOC-17's branch. LOC-15 became `in_progress` after its blocker completed.

This incident also illustrates why the issue log and Temporal history matter: issue status alone does not say which stage failed. See the workflow's Activity failure for the provider's actual error, and check that later stages have run before describing a task as reviewed or tested.

The `data/artifacts` and `data/worktrees` paths are local to this orchestration workspace. Do not delete failed-run artifacts until the run has been reviewed and any needed worktree or patch has been recovered.
