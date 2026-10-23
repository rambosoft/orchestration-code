# Config schema and precedence (verified 2026-10-22, src/contracts.ts, src/server.ts, src/project-roots.ts)

- **Project manifest** (`ProjectManifestSchema`, zod): id, root/rootEnv/containerRoot, defaultProfile, providers.default, providerRouting[stage]{provider,model,reasoningEffort}, providerTimeouts (<=900000ms), openSpec.enabled, uiUx, qualityCommands / qualityCommandsByProfile (executable enum node|npm|pnpm|yarn), repository{remote,targetBranch,integratedBaseBranch,requiredSourcePaths}, plugins[], policy{maxReviewRounds(1-2),maxRepairAttempts,maxParallelism,requireApprovalBeforeMerge}. No `schema_version` field.
- Loaded by bridge: `ORCHESTRATOR_PROJECT_FILE` (default `project.example.json`) + every `*.json` in `projects/`; duplicate ids fail.
- **Env** (`.env.example`): TEMPORAL_*, ORCHESTRATOR_DATA_DIR/HOST_DATA_DIR/PROJECTS_ROOT/MAX_ACTIVITY_CONCURRENCY/QUEUE_WAIT_ALERT_MS/API_TOKEN, OPENROUTER_API_KEY, PAPERCLIP_*. Not validated at startup (worker reads with `??` defaults; bridge only checks API token).
- **Precedence** for a run: task payload (profile, openSpec flag, approval, test-injection flags) > project manifest > profile defaults (`profiles.ts`) > code defaults. Project root: `rootEnv` env var > `DEMO_PROJECT_ROOT` (default project) > `ORCHESTRATOR_PROJECTS_ROOT`+`root` (must stay inside).
- Gaps: no global config layer; no startup validation of env; test-injection flags (`injectReviewFailure`, ...) accepted from the public API payload (FM-009).

## Additions from the e2e hardening pass (2026-10-22)
- Provider model precedence for CLI providers: manifest `providerRouting.<stage>.model`, then `CODEX_MODEL` (codex only), then the pinned default (`DEFAULT_CODEX_MODEL`). Claude uses the route model only.
- `providerRouting.openspec` is honoured for the OpenSpec proposal, repair and reconcile stages; without it they use Codex.
- Env: `CLAUDE_MAX_BUDGET_USD` (default 10 per Claude stage), `ORCHESTRATOR_WORKFLOW_TIMEOUT_MS` (default 48h), `ORCHESTRATOR_ALLOW_TEST_FLAGS=1` (bridge accepts test-injection flags), `ORCHESTRATOR_BRIDGE_URL` (doctor and e2e driver, default http://127.0.0.1:3101).
- Worker startup now fails fast on an invalid `ORCHESTRATOR_MAX_ACTIVITY_CONCURRENCY` or `TEMPORAL_ADDRESS` (`src/env-validation.ts`).
- Handoff budgets (`HANDOFF_BUDGETS` in `src/handoffs.ts`): planningContext 2800, openSpecDigest 2200, plan 900, brief 1200 (hard ceiling 1800), reviewChecklist 900; invariants are unit-tested.

## Analysis stage and manifest aliases (2026-10-23)
- Manifest `analysis`: `{ enabled: boolean (default false), docsDir: relative path (default docs/analysis) }`. A task line `Analysis: on|off` overrides `enabled` (parsed by `parseTaskDirectives`, together with `OpenSpec: on|off`). Route: `providerRouting.analyze`.
- Manifest `aliases`: readable alternative ids; the id is normally the Paperclip project UUID. `GET /health` lists ids and aliases; the bridge resolves either.
- New handoff budgets: `analysis` 1400 tokens, `planningContext` 3600, `brief` 1700 (hard ceiling 2550).

## Quality gate severity and visual verification (2026-10-23, ADR 0007)
- `qualityCommands[].severity`: `"fail"` (default, run stops) or `"warn"` (a failing command becomes a warning in the final message). Use `warn` to adopt knip or jscpd without blocking work; same executables as before (node, npm, pnpm, yarn).
- Manifest `visual` (optional, default off): `{ enabled, command: {executable, args, cwd?}, url (http://localhost, 127.0.0.1 or [::1] only), readyTimeoutMs (default 60000), viewports [{name,width,height}] (1 to 3, default desktop 1280x720), steps (1 to 40 of press{key} | wait{ms<=10000} | click{selector} | shot{name}), maxImages (default 6, max 8), required (default false) }`.
- Behaviour: during the review activity the app is started in the task worktree, screenshots are taken with `playwright-core` driving an already installed Chromium, and the images go to the reviewer (Codex via `--image=`; other providers get the file paths). Any capture problem is a warning; `required: true` fails the review instead. Screenshots live under the run artifacts, never in the repository.
- Browser discovery: `ORCHESTRATOR_BROWSER_PATH`, then the newest Playwright download (`PLAYWRIGHT_BROWSERS_PATH` or the default cache), then system Edge or Chrome. `npm run doctor` reports `visual:browser` for projects that enable it.
