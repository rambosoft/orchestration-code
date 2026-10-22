# Runbook: stuck or failed run

1. `npm run dev -- inspect <workflowId>` (status, progress). Runs end on their own after 48h (`ORCHESTRATOR_WORKFLOW_TIMEOUT_MS`); approval waits fail after 24h.
2. Cancel: `npm run dev -- cancel <workflowId>`. Stage activities heartbeat every 10s, so a running provider process tree is killed within seconds (Windows `taskkill /T`).
3. Failed publish ("publish guard blocked..."): inspect the named paths in `data/worktrees/<runId>`; remove the offending file or confirm a false positive, then restart with a new attempt number. Nothing was pushed.
4. Disk: worktrees under `data/worktrees` are never auto-removed (B-010 open): `git worktree remove --force <path>` from the project root.
5. Retried identical stage: results are reused from `artifacts/<task>/<runId>/<stage>-<n>.json` (metadata.reused=true).
6. Rebase/force-with-lease happens only in `sync-stack` (human-invoked).
