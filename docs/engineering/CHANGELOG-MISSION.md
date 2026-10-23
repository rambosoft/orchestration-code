# Mission changelog

One line per completed item: id, commit, evidence.

- baseline 99c5f00 (main): existing code committed; 70 tests / typecheck green (knowledge/metrics/baseline.json).
- B-001 4694e32: child env scrubbed (test/env.test.ts, 74 tests green).
- B-003: bridge hardening: timing-safe token, 1MB body cap, test flags gated (test/http-guard.test.ts, 79 tests green).
- B-002: publish guard blocks credential paths, secret patterns, >5MB files, node_modules before commit/push (test/publish-guard.test.ts, 82 tests green). Caveat: regex heuristics can false-positive on fixtures; blocked runs need human review.
- B-009: untrusted-content notice in CLI and OpenRouter prompts (test/untrusted-notice.test.ts, 84 tests). Effect on model behaviour unverified.
- B-006: workflowExecutionTimeout (48h default, ORCHESTRATOR_WORKFLOW_TIMEOUT_MS) and 24h approval timeout via patched('approval-timeout') (test/timeouts.test.ts, 86 tests). Token/cost budgets remain B-016.
- B-005: auth, config, plugin and invalid-result failures are non-retryable (test/non-retryable.test.ts, 90 tests).
- B-004: executeStage heartbeats (10s); heartbeatTimeout 2m + WAIT_CANCELLATION_COMPLETED on stage proxy; child process trees killed on activity cancel (test/cancellation.test.ts, 92 tests). Live worker cancel not exercised; abort path verified at runCheck level, CliProvider path by code only.
- B-008: duplicate start returns the live Temporal runId plus alreadyStarted (test/duplicate-start.test.ts, 93 tests).
- Review fixes (independent ts reviewer): publish guard now NUL-delimited (-z), scans commits made by the agent against baseSha, covers .envrc/.netrc/.npmrc/credentials.json; env scrub extended (AWS_, PRIVATE_KEY, PASSPHRASE, COOKIE, DATABASE_URL, *_PAT) while keeping Claude CLI auth tokens; OpenRouter aborts on activity cancel; auth/rate-limit regex word-bounded; command.ts breaks publish-guard<->workspaces import cycle (96 tests). Not fixed: binary content scan, POSIX process groups (FM-015).
- B-011: replay test over fresh + committed history fixture (test/replay.test.ts, 97 tests). Mutation check: dropping a stage -> Nondeterminism error (detected); reordering same-type activities is NOT detected (Temporal compares command type only). Regenerate fixture with UPDATE_REPLAY_FIXTURE=1 after intentional patched() changes.
- B-007: stage result reuse keyed by sha256(stage,provider,model,effort,prompt) within a run (test/stage-reuse.test.ts, 99 tests). Only ok results reused; worktree-state drift not hashed.
- B-013: SIMPLICITY_POLICY (adapted Ponytail principles) in implement/repair prompts and a low-severity complexity note in review (test/simplicity.test.ts, 102 tests). Effect on output quality unverified (no real provider).
- E2E (dino-runner, 3 stacked tasks, codex + claude implement): all green after 8 pipeline fixes (see knowledge/metrics/runs/2026-10-22-e2e-dino-runner.json). 111 tests.
- E2E hardening pass: root-resolution fix (CI red -> green), early delta checks, brief hard ceiling, doctor, cleanup, e2e driver, openspec route, worker env validation, stale-build check, classifyProviderError, model config. Honest correction: the earlier claim that the proposal prompt got the delta-format sentence was wrong until this pass (replace had silently matched nothing); now covered by test/openspec.test.ts. 146 tests; CI green on 163b60f.
- B-038 (ADR 0007): quality command severity warn|fail; optional visual verification (playwright-core screenshots of the running app attached to the review, Codex via --image); doctor visual:browser check; run-worker.ps1 survives stderr and restarts the worker; adapter does not cancel a healthy workflow on Paperclip lease loss (FM-037). 283 tests. Evidence: real capture of dino-runner (4 PNGs in 10s, no warnings) and Codex reading one through the exact pipeline arguments. Not yet verified: a full Paperclip run with the visual gate (pixel-tree task next).
