# Validation results

Validation records observed results from this Windows host and the persistent local stack. `PASS` means the command or behavior completed successfully; `BLOCKED` means a prerequisite is unavailable; `NOT RUN` means it was not exercised. The deterministic fake provider is not a real model run.

## Automated checks

| Check | Status | Command and evidence |
| --- | --- | --- |
| Dependency install | PASS | `npm ci`; lockfile install completed. |
| TypeScript build | PASS | `npm run build`; emitted `dist/`. |
| Type check | PASS | `npm run typecheck`; no diagnostics. |
| Unit tests | PASS | Latest `npm test`; 2 test files, 24 tests passed. |
| Temporal scenario suite | PASS | `npm run demo:validate`; feature, research, repair, retry, approval, rejection, duplicate-trigger, cancellation, parallel-task, and isolation results are listed below. |
| Plugin capability gate | PASS | Included in `npm run demo:validate`; an unavailable required plugin produced the expected failed workflow instead of a success result. |
| Formatter / linter | NOT RUN | No formatter or standalone linter is configured in this project; typecheck and unit tests are the configured source checks. |
| Compose service health | PASS | Paperclip `127.0.0.1:3100`, bridge `127.0.0.1:3101`, Temporal `127.0.0.1:7233`, UI `127.0.0.1:8233` were running during live integration. |
| Paperclip source image build | PASS | `npm run stack:up`; pinned Paperclip tag built through the official Dockerfile and all remaining generation, UI, server, plugin, and Rust runner stages completed. The private-corpus generator exception is described under build notes. |
| Paperclip adapter environment | PASS | `temporal_orchestrator` environment test returned `status: pass`. |
| Paperclip → Temporal → Paperclip | PASS | Paperclip LOC-8 heartbeat run `7c7d9682-4645-4f86-8e21-ca083e9ae111` completed exit code 0; Temporal workflow `pc-34852426-5377-4ca3-865e-7cdc7e3f9a71-1`; Paperclip issue was marked done and received result comments with stage/artifact details. |
| Post-rebuild Paperclip → Temporal → Paperclip | PASS | Created LOC-9 (`78446fe1-9ddf-4c91-963f-d56a6d041f30`) against the freshly rebuilt Paperclip image. Workflow `pc-78446fe1-9ddf-4c91-963f-d56a6d041f30-1` completed; the issue became `done` and the result comment contained research/verify summaries and artifact references. |

Latest deterministic workflow output:

| Scenario | Observed result |
| --- | --- |
| Feature pipeline | `completed` |
| Research profile | `completed` |
| Repair profile | `completed` |
| Bounded review/repair failure | `failed` as expected for injected review failure |
| Activity retry | `completed` after deterministic first-attempt failure |
| Invalid result | `failed` as expected |
| Activity timeout | `failed` as expected |
| Required plugin unavailable | `failed` as expected |
| Approval | `completed` after approval signal |
| Rejection | `PASS` |
| Duplicate trigger | `PASS` |
| Cancellation | `CANCELLED` |
| Parallel workflows | both `completed` |
| Isolation | `PASS` |

## Requested scenario groups

| Group | Status | Evidence / limits |
| --- | --- | --- |
| Feature implementation | BLOCKED | The orchestration feature pipeline completed with the deterministic fake provider. No real code change was made by a provider and verified in the demo project. |
| Seeded bug repair | BLOCKED | Repair profile completed in the deterministic harness; no provider-authored fix or regression test run is claimed. |
| Research-only output | PASS | Fake-provider research workflow completed. A real provider research run is blocked because `claude auth status` reported `loggedIn: false`; no provider cost or model is claimed. |
| Behavior-preserving refactor | NOT RUN | No before/after real code diff was produced. |
| Isolated parallel work | PASS (workflow isolation) | Two workflows completed concurrently and the isolation assertion passed. Parallel provider edits in separate worktrees were not exercised. |
| Bounded review failure and repair | PASS (fault path) | Injected review failure stopped after configured bounded repair behavior. This is a deterministic orchestration test, not an LLM review. |
| Human approval | PASS | Approval signal completed a workflow; rejection path passed. |
| Idempotency and recovery failures | PASS (covered subset) | Duplicate trigger, activity retry, timeout failure, cancellation, and parallel execution were observed. Temporal server process crash/restart recovery was not force-tested in this final pass. |
| Real provider runs | BLOCKED | Claude reported logged out; Codex marketplace is registered but the installed Codex CLI does not support ECC plugin installation, and its authenticated provider execution was not verified. Gemini CLI is not installed. |

## Build and tool setup notes

- The Paperclip application was built locally from the exact stable tag `v2026.916.1` (`d554c4789ed3930f8a53ac9fdf6503b3187097da`) and its running Compose container and adapter were verified in the earlier live round trip above.
- `npm run stack:up` rebuilt Paperclip successfully. Its source references the separate private `paperclipai/paperclip-evals` repository; that corpus cannot be fetched here. `scripts/prepare-paperclip.ps1` therefore retains the release's schema-checked capability inventory and skips only the corpus-dependent regeneration step, then runs the other Paperclip generators. The image build and post-rebuild round trip passed with this explicit constraint.
- Paperclip restarted once against an existing embedded PostgreSQL data directory with a stale `postmaster.pid`. After stopping the container, only the stale PID marker was removed; all database data remained. Paperclip then recovered normally and served `/api/health` with HTTP 200.
- Paperclip is installed as a separately mounted external adapter. Adapter test-environment validation returned HTTP 200 / `pass` after the rebuild; live LOC-8 and LOC-9 assignments exercised the actual adapter and API result update.
- ECC Claude plugin installation completed with Claude CLI's native plugin commands. Codex's ECC marketplace was registered, but native plugin installation is blocked by installed `codex-cli 0.130.0-alpha.5`, which has no `codex plugin add` command. No CLI upgrade was attempted.
- Gemini CLI was not installed. The user requested a real provider task only where authentication is usable; no real provider request was made while Claude reported logged out.

## Limitations

The automated suite validates workflow routing, contracts, policy gates and failure handling with the fake provider. It does not demonstrate provider-authored code edits, test-driven repair, merge behavior, provider billing metadata, or recovery after forcibly restarting the Temporal server. Paperclip onboarding's AI-provider wizard was not completed; authenticated Paperclip accounts, organization, agent, adapter, issue assignment and API round trip were exercised directly.

## MiniMax + Codex routing change (2026-10-20)

| Check | Status | Command and evidence |
| --- | --- | --- |
| Stage route validation, OpenRouter provider tests, and error reporting | PASS | `npm test`; 15 tests cover manifest model requirements, Codex implementation routing, MiniMax non-coding routing, OpenRouter request model, credential non-disclosure and child-process isolation, missing key, timeout, 401, 429, 503, and preserving provider causes in run status. |
| TypeScript type check | PASS | `npm run typecheck`; no diagnostics. |
| Production build | PASS | `npm run build`; no diagnostics. |
| Deterministic Temporal scenario suite | PASS | `npm run demo:validate`; feature/research/repair, bounded failure, retries, plugin gate, approval/rejection, duplicate trigger, cancellation, parallel workflows, and isolation all produced expected outcomes using the explicitly selected fake provider. |
| Live MiniMax request | BLOCKED | The ignored project `.env` does not currently contain `OPENROUTER_API_KEY`. No real request was made and no Paperclip stored credential was read or reused. Add the key to `.env`, restart `npm run worker`, then run a disposable research task to validate. |
| Provider failure in Temporal run status | PASS | A disposable research workflow selected the OpenRouter route with no key configured; after bounded Activity retries, Temporal returned `research Activity failed after bounded retries: Activity task failed <- OPENROUTER_API_KEY is not configured for the Windows worker`. No external request was sent. |
| Real Codex implementation stage | FAIL | `codex login status` reported logged in. A feature task ran through Temporal in a disposable Git repo under ignored `data/`, but `codex exec` exited 1 on both bounded Activity attempts and produced no code change. The installed CLI reported the configured model as unknown; a backed-up one-line model change also remained unknown, so the original config value was restored. The workflow will preserve bounded provider error details in the run result. |
| Live Paperclip → Temporal → OpenRouter → Paperclip round trip with stage routing | NOT RUN | Historical fake-provider round trips above remain valid, but the updated model-routing path was not exercised live because the host worker key is absent. |

The Paperclip adapter no longer accepts a provider override; `project.example.json` is the source of stage routes. Provider IDs and model IDs are safe workflow input. The OpenRouter key is read only by the Windows worker process from ignored `.env` or its process environment.

## Git-safe project workflow implementation (2026-10-21)

| Check | Status | Command and evidence |
| --- | --- | --- |
| TypeScript type check | PASS | `npm run typecheck`; no diagnostics. |
| Unit and Git workflow tests | PASS | `npm test`; 2 files, 24 tests. Tests reject untracked input files, verify source presence and fixed base SHA, create a complete task worktree, push to a disposable local bare remote, mock GitHub CLI draft-PR responses for idempotency and auth failure, verify deterministic failure output, and exercise stacked rebase success and conflict handling. |
| Build | PASS | `npm run build`; no diagnostics. |
| Adapter syntax | PASS | `node --check paperclip-adapter/index.js`. |
| Compose configuration | PASS | `docker compose config --quiet`. |
| Bridge image with Git | PASS | `docker compose up -d --build orchestrator`; image rebuilt and service recreated. Bridge `/health` returned `ok: true` and listed both configured manifests. |
| Updated adapter activation | PASS | `docker compose restart paperclip`; startup recovery completed and `/api/health` returned `status: ok`, `bootstrapStatus: ready`. Paperclip persistent data remained available. |
| Windows Temporal worker update | PASS | Existing idle worker process was restarted after confirming no Temporal workflows were running; it loaded the final activities. |
| Calculator input-mount admission | PASS (safely rejected) | Read-only `git status` inside the bridge container showed modified and untracked files. An authenticated `POST /v1/runs` for the Calculator manifest returned HTTP 400: `project working tree is not clean (tracked or untracked changes)`. The admission error occurred before Temporal start. `C:\workspace\calculator` was not edited by this implementation. |
| Temporal scenario suite | PASS | `npm run demo:validate`; feature, research, review-repair, bounded review failure, activity retry, approval/rejection, duplicate dispatch, cancellation, parallel workflow, and isolation assertions all returned their expected outcomes with the fake provider. |
| Formatter / standalone linter | NOT RUN | No formatter or standalone linter script is configured. |
| Real GitHub draft PR | NOT RUN | Git push was exercised against a disposable local bare remote; `gh` responses were mocked. No real GitHub PR was created. |
| Real Paperclip code-task round trip | BLOCKED | Calculator admission correctly rejects its current dirty baseline. The checkout also has no configured GitHub remote, so a real publish cannot be validated until its owner commits a clean baseline and configures the remote. No Calculator code workflow was dispatched. |
| Real provider stages in this validation | NOT RUN | The Temporal scenario suite selected the deterministic fake provider. No MiniMax or Codex result is claimed here. |

## Calculator RTK pilot (2026-10-21)

| Check | Status | Evidence / limits |
| --- | --- | --- |
| RTK Windows install | PASS | Installed official `rtk 1.0.1` Windows x86_64 release ZIP after confirming `winget` was unavailable. SHA-256 matched the release `checksums.txt` (`64b4807c50b61dddf2ac1e86751dbda9117ab94ed02bf266e6584da571c39896`). Added the install directory to the user `PATH`; restarted the Windows Temporal worker. |
| Calculator project hook | PASS (after trust) | `rtk init --codex` generated `.codex/hooks.json` with `PreToolUse` / `Bash` / `rtk hook codex`, plus `RTK.md` referenced by `AGENTS.md`. Setup commit `e6f736e` was pushed to Calculator `main`. Codex initially showed the hook as new and inactive; after reviewing and trusting that exact hook in `/hooks`, a normal Windows Codex CLI call reported `hook: PreToolUse Completed` and rewrote `git diff HEAD~1` to `rtk git diff HEAD~1`. |
| Project manifest and worker | PASS | Active manifest `projects/calculator-2.json` requires plugin `rtk` version `0.1.0` on `implement` only. The recreated bridge listed active project `ac002660-592a-4dc6-a2f2-18c581fe57c7`; worker-side `resolveRtkStatus` returned `active: true`, version `rtk 1.0.1`. The archived Calculator manifest was left unchanged. |
| Feature issue | PASS | Paperclip `LOC-22` (“Add a switchable scientific mode and advanced operations”) was created unblocked at medium priority and assigned to Temporal Orchestrator. It is done. PR [#11](https://github.com/rambosoft/calculator/pull/11) was confirmed merged at `2026-10-21T12:20:16Z` (the user reported the merge first). |
| Feature quality and review | PASS | The workflow added Simple/Advanced mode and scientific operations. First review requested an accessible-name fix and DOM-level mode-toggle tests; the repair addressed both. Repair-stage `npm test` passed all 38 tests, deterministic quality recorded exit code 0, and the second review returned `VERDICT: PASS`. The OpenRouter verify narrative also included an unrelated statement that commands could not be run; the orchestrator's recorded `npm test` exit code 0 is the authoritative test result. |
| RTK usage during feature run | PASS (manual wrapper use; automatic hook not yet trusted) | Implementation and repair artifacts report RTK `1.0.1` active and show `rtk npm test`, `rtk git diff --check`, and diff summaries. Because the hook was not trusted until after this workflow, its automatic rewrites were not recorded for the feature run itself. The feature run's provider receipt did not expose Codex token usage. |
| Automatic hook savings smoke | PASS (command-output estimate only) | After hook trust, a post-run Codex smoke test rewrote `git diff HEAD~1` automatically. From the project worktree, `rtk gain --project --history` recorded 4 commands; the diff command estimate was 112 tokens saved (2.8%), with aggregate history 4.0K input / 3.9K output / 112 saved. Two `git status` calls saved 0, and `git log --stat` passed through with 0 saved. These small smoke commands do not measure total model usage or the original feature run. |
| RTK tracking database | PASS (after sandbox access fix) | `rtk init --codex` reported that Codex's workspace-write sandbox needs the RTK data directory writable for SQLite history. Added the reported `%LOCALAPPDATA%\rtk` directory to `[sandbox_workspace_write].writable_roots`, preserving existing Codex settings. The project-scoped history then recorded smoke commands. |

### Pilot conclusion

The project-local toggle and Windows Codex hook work after the hook definition is reviewed and trusted. RTK reduced one representative Git diff output by an estimated 112 tokens (2.8%); this is command-output savings only. The actual feature workflow used explicit RTK wrappers but ran before hook trust, so its automatic hook savings cannot be measured from `rtk gain`. Keep RTK enabled for this selected Calculator project during the pilot; use more representative implementation runs before treating the small smoke estimate as evidence of overall token or cost reduction. Deterministic `npm test`, review, and publication gates remained unchanged.
