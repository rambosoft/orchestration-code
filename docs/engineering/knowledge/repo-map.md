# Repo map (verified 2026-10-22)

**What it is:** "paperclip-temporal-orchestrator": Paperclip task board -> adapter -> HTTP bridge -> Temporal workflow -> host worker running LLM CLIs/OpenRouter in an isolated git worktree -> gates -> draft PR.

## Execution path
1. `paperclip-adapter/index.js` (Paperclip external adapter) POSTs `/v1/runs` to the bridge and polls the result.
2. `src/server.ts` bridge: bearer auth, zod payload, manifest lookup, git admission (`workspaces.admitRepository`: clean tree, GitHub remote, fetch base SHA), `client.startRun` (workflow id `pc-{task}-{rev}-a{attempt}`, reuse policy ALLOW_DUPLICATE_FAILED_ONLY).
3. `src/workflows.ts::projectWorkflow` (one ~230-line function): dependency recheck -> `prepareWorktree` -> `npm ci` -> optional OpenSpec (prepare/propose/validate/optimize) -> profile stages `plan`,`brief`,`implement`,(`review` || `verify`), repair <=1 -> OpenSpec archive -> `collectWorktree` -> `publishWorktree`.
4. `src/activities.ts::executeStage` -> `plugins.check` -> provider (`providers.ts`: fake | codex/claude/gemini CLI spawn | openrouter fetch) or deterministic `runCheck` for quality commands.
5. `src/workspaces.ts::publishWorktree`: `git add --all`, commit, push, `gh pr create --draft` (re-checks for an existing PR).
Other: `cli.ts` (run/inspect/cancel/approve/sync-stack/resume), `handoffs.ts` (plan/brief schemas, token budgets, compression validation), `openspec*.ts`, `uiux*.ts` (skill catalog), `rtk.ts` (optional output filter), `validate-demo.ts` (scenario suite against live Temporal), `worker.ts`.

## Config lives in
`project.example.json`, `projects/*.json`, `.env` (ignored), `uiux.global.json`, `docker-compose.yml`. See config-schema.md.

## Keep / change / remove
| Area | Verdict | Why |
|---|---|---|
| Temporal-owned lifecycle, stable workflow ids, bounded review rounds | keep | ADR 0001; tests cover |
| Clean-git admission, source-presence gate, draft-PR idempotency | keep | tested |
| Handoff schemas and compression validation | keep | tested; complex but justified |
| Child-process env inheritance (quality commands, npm ci) | change | secrets exposed to model-written code (FM-001) |
| Activity options (no heartbeat, no non-retryable classes, no workflow timeout) | change | FM-003..005 |
| `projectWorkflow` monolith | keep for now | refactor only after replay tests exist |
| Test-injection flags in public API payload | change | FM-009 |
| `git add --all` in publish with no guard | change | FM-002 |
| No CI, lint, license, CLAUDE.md | add | |
