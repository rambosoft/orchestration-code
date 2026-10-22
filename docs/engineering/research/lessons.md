# Lessons and anti-patterns

Tags: [P] primary-verified, [O] opinion / industry practice (not verified here).

- [P] Cancellation never reaches an activity that does not heartbeat; a 16-minute CLI child can outlive a cancelled workflow. Heartbeat on a timer and on child output; kill the process tree (Windows: taskkill /T) on cancel.
- [P] Non-retryable errors exist (ApplicationFailure nonRetryable, nonRetryableErrorTypes). Retrying auth/validation/config errors only re-spends cost.
- [P] History limit 51,200 events / 50 MB; return paths/SHAs from activities, not large outputs. Our pipeline is far below the limit.
- [P] Replay tests (Worker.runReplayHistory) catch non-determinism before it breaks in-flight workflows.
- [O] Lost-response recovery: make each side effect check-then-act with a key derived from workflowId+stage (already true for push/PR; not for LLM stages — FM-006).
- [O] Runaway cost comes from unbounded loops and retries; bound review rounds (done), retries, wall time, and tokens (not done).
- [O] Child processes that run model-written code must not inherit service tokens.
- [O] Treat repo/spec/issue text as data in prompts; add an explicit preamble.
- [O] "Plan complete" is not "project complete": here Done = gates passed + draft PR (documented in architecture.md); merge stays human.
- [O] Abstraction creep: the plugin registry has one plugin (rtk); do not extend it without a second real consumer.

## Lessons from the first real end-to-end run (dino-runner, 2026-10-22)

Evidence: 3 stacked tasks, Codex for OpenSpec/plan/brief/review/verify, Claude for implement; 11 attempts, 8 distinct pipeline defects (knowledge/metrics/runs/2026-10-22-e2e-dino-runner.json). All items below were observed in that run.

- **Never fail a run on the first malformed LLM artifact.** Specs with the wrong delta heading, MODIFIED-for-new-requirement and an unticked checklist all killed otherwise good runs. Pattern now used everywhere: validate, give ONE bounded repair pass that feeds the validator's own diagnostics back to the author stage, validate again, then fail honestly.
- **Check cross-artifact invariants in the cheap stage, not the expensive one.** The delta-vs-main-spec mismatch surfaced only at archive, after a 4-minute Claude implementation. `openspec-delta.ts` now checks it at validation time.
- **Stage budgets must be derived, not guessed.** The brief must carry the plan's criteria verbatim yet its cap (800) was below the plan's (900); the digest cap (1400) was below a normal 9-requirement spec. Rule: downstream cap >= protected upstream content + own overhead; the invariants are unit-tested; a soft cap with a 1.5x hard ceiling degrades instead of failing.
- **Agents follow their own skills.** Claude ran the archive skill itself and left browser-only checklist items unticked. The orchestrator owns archive: make it idempotent (date-prefixed archive names) and also tell the agent not to do it.
- **Gate only on what can be verified unattended.** Browser/manual checks are recorded as "Unverified manually" notes, not blocking checkboxes; genuinely missing work still fails.
- **The environment is a dependency.** nvm re-created the symlinked Node path mid-run (`spawn node.exe ENOENT`); the host worker silently died; the compiled worker was stale after edits; `claude` was logged out; `npm` was not on PATH for the launcher. `doctor` now checks all of these before a run, and Node is spawned by its real path.
- **Cross-platform is real here.** The bridge runs in a Linux container while the worker is on Windows. CI on Linux caught a path test that Windows hid, and exposed a latent bug (Windows-style `rootEnv` resolved with POSIX semantics). Run CI-equivalent checks on Linux before trusting a green local run.
- **Scripted edits can silently do nothing.** A string replace that matched nothing meant the delta-format sentence never reached the proposal prompt although it had been reported as done; Python turned `\b` into backspace characters in two regexes. Every scripted change needs an assertion or a test; `npm run check:chars` guards control characters.
- **Review is weak at completeness.** The Codex reviewer passed a change with unfinished checklist items; deterministic gates (quality commands, checklist, archive) are the real gates.
- **Each retry costs minutes of model time.** A reusable chain driver with attempt auto-increment, stacking and usage summary (`npm run e2e`) replaces hand-run scripts.
- **Git state looks different from the container and from the host.** The bridge's Linux git called a clean Windows checkout "modified" because of CRLF working files over an LF index (`core.autocrlf=true` only applies on the host). git's own status stays stale-dirty even with `-c core.autocrlf=true`, so admission now decides dirtiness itself: only content differences ignoring end-of-line count. Suggest `.gitattributes` with `* text=auto eol=lf` in managed repos so the two views agree.
