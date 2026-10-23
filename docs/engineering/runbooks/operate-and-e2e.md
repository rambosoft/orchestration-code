# Runbook: operate the stack and run an end-to-end check

Everything here was exercised in the dino-runner e2e (2026-10-22). Commands run from the repo root after `npm run build`.

## 1. Preflight (always first)
```bash
node dist/src/cli.js doctor        # or: npm run doctor
```
Needs `ORCHESTRATOR_API_TOKEN` (bridge check) and `OPENROUTER_API_KEY` (if a manifest routes to OpenRouter) in the shell. It checks Node real path, config values, bridge health, worker pollers on the task queue, git/gh and `gh auth`, every provider the manifests route to (codex login, claude auth, OpenRouter key), leftover worktrees, and whether `dist` is older than `src`. FAIL lines name their fix; WARN lines do not block.

## 2. After any code change
1. `npm run build`
2. Restart the **host worker** (it runs `dist/`): stop the `node dist/src/worker.js` process, then start `scripts/run-worker.ps1` (or `node dist/src/worker.js` with the variables from `.env`). A stale worker silently runs old code (FM-023); `doctor` warns.
3. Restart the **bridge** only if `src/server.ts`, `src/contracts.ts`, `src/http-guard.ts`, `src/workspaces.ts` or a manifest changed: `docker compose up -d --build orchestrator`.
4. Re-run `doctor`.
Workflow code changes must also follow the `patched()` rule in `EXTENDING.md`.

## 3. Run a chain of stacked tasks
```bash
ORCHESTRATOR_API_TOKEN=... node dist/src/e2e.js examples/dino-runner.tasks.json --max-attempts 2 --record docs/engineering/knowledge/metrics/runs/<date>-e2e-<project>.json
```
Each task is POSTed to the bridge with the previous task's published branch as its parent, polled until done, and a failure stops the chain (or retries under the next attempt number). The summary lists per-stage seconds and token usage and totals per provider. Pre-conditions for the target project: manifest in `projects/`, a GitHub repo with an initial commit, a clean checkout in the projects root, `requiredSourcePaths` pointing at a tracked file.

This path bypasses Paperclip (no board issues, no blocker re-check). Test the adapter hop separately (BACKLOG B-024).

## 4. Reading a failure
`GET /v1/runs/<workflowId>` returns `result.message` and `result.metadata.review.stopReason`:

| stopReason | Meaning | First action |
|---|---|---|
| `openspec_stage_failed` | proposal, validation or digest failed after its repair pass | read the message; the spec is in `data/worktrees/<runId>/openspec/changes/` |
| `brief_output_invalid` | brief over its hard ceiling or missing protected items | check `briefBudgetExceeded` metadata and plan size |
| `openspec_archive_failed` | archive or reconcile failed after quality gates | inspect `tasks.md` and the delta specs in the worktree |
| `blocking_findings_remain_after_final_review` | review rounds exhausted | read `unresolvedFindings` |
| `publish_failed` | publish guard or git/gh error | the message names the files or the command |

Transient `spawn ... ENOENT` or auth errors: run `doctor`, fix, restart with the next attempt number.

## 5. Housekeeping
`node dist/src/cli.js cleanup --dry-run`, then `cleanup --days 7` (default) removes old task worktrees; `--all` removes every one. Branches are never deleted (they back draft PRs). Do not run `--all` while a run is active.

## 6. Bootstrap a project (ADR 0009)
**One-time setup.** `npm run plugin:build` (needs `npm install` once in `plugins/project-bootstrap`), then `docker compose up -d --build orchestrator` and `docker compose up -d paperclip` (the second mounts the plugin folder and reloads the adapter; plan it between runs). In Paperclip (instance admin): install the local path `/opt/paperclip-plugins/project-bootstrap` (Settings, Plugins, or `POST /api/plugins/install` with `{"packageName":"/opt/paperclip-plugins/project-bootstrap","isLocalPath":true}`), create a company secret that holds `ORCHESTRATOR_API_TOKEN`, and set the plugin settings (`bridgeUrl`, `bridgeToken`): `npm run build` then `npm run plugin:setup` (needs `PAPERCLIP_API_TOKEN` of an instance admin and `ORCHESTRATOR_API_TOKEN`) does both and is safe to repeat. The worker needs `ORCHESTRATOR_PROJECTS_ROOT`, `PAPERCLIP_API_TOKEN`, a `gh` login and npm network access (`npm run doctor`).
**Use.** Open "New AI project" (sidebar or top bar), describe the idea, pick maturity and platform (Advanced shows every option), press "Create and plan". The project's Bootstrap tab shows progress and the plan; "Approve and create" builds the repository, manifest and tasks. Without the browser: `npm run bootstrap:e2e -- examples/aurora-store.bootstrap.json --approve`.
**If it fails.** The task comment says what exists. Before the repository was created the scaffold removes its own folder; after it, delete the GitHub repository and the folder named in the message and `projects/generated/<project id>.json`, then move the task back to todo. A project is bootstrapped once: a project whose manifest exists is refused.

## 7. After the machine was off, asleep or offline (reconcile)
Temporal keeps running workflows and finishes them even when the laptop is off, but the Paperclip adapter that reports the result is gone, so Paperclip marks the task **blocked** ("requires reconciliation") although the work is done and the draft PR exists. Nothing is lost; the result only has to be reported:

```bash
npm run reconcile                      # dry run: lists what it would report
npm run reconcile -- --apply           # reports it: a comment (with the PR and the publication marker) and the status
npm run reconcile -- --apply --issue LOC-65 --days 7
```
It handles blocked, in-progress and in-review tasks whose latest workflow ended within `--days` (default 3), skips results already reported and workflows still running, and never invents a result: a workflow that itself failed is listed with the advice to retry the task from Paperclip. **It also runs by itself every time the worker (re)starts** (`scripts/run-worker.ps1`), so after a reboot the board catches up without anyone doing anything. A task that comes back as `in_review` has an open review finding; accept the PR (move the task to done) or comment what to fix and re-run it.
