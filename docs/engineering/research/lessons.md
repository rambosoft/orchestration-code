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
