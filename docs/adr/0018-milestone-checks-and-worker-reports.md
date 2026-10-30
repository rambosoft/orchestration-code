# ADR 0018: A prototype checks each milestone once; the worker can report its own results

Status: Accepted (2026-10-30). Part of the v2 plan, sections 3.3 and 3.8 (docs/engineering/research/orchestration-v2-redesign.md). Extends ADR 0015.

## Context
- A prototype task runs implement + verify with no review (ADR 0015). Nothing then looked at what a milestone produced as a whole.
- A multi-hour run is held by an adapter lease. When the lease is lost (Paperclip restarted, machine asleep) the result reaches the task only through the reconcile step, minutes later, and much of `reconcile.ts` exists to repair that.

## Decision
1. **Milestone check.** For a prototype, `buildIssuePlan` appends one task per milestone (`<milestone key>-CHECK`, "Check milestone: <title>") in the heavy lane: a Codex plan, one Claude implementation and a Codex review. It verifies the milestone's exit criteria against the running result, fixes what falls short with the smallest change, adds a test per fix and reports an unmeetable criterion as `UNMET_ACCEPTANCE`. It waits for every task of its milestone and the next milestone waits for it. Milestones with only research tasks get none; other tiers get none (they review per task). The whole-product polish block stays on the last real task.
2. **Worker-side report** (opt-in, `ORCHESTRATOR_WORKER_REPORTS=1` on the bridge, `PAPERCLIP_API_TOKEN` on the worker). A run started with `reportToPaperclip` ends with an idempotent `reportResult` activity (8 attempts, backoff) that puts the result on the Paperclip issue: done, in review or on hold, with the same comment the adapter writes, found by the same "Temporal workflow `<id>` finished" text. The result is marked `reportedToPaperclip`; the adapter then returns without posting it again (a second comment wakes the agent), and the reconcile step sees it already reported. If Paperclip is unreachable the result is returned unmarked and the adapter or reconcile reports as before. A failed run is never commented on by the worker (FM-054); bootstrap runs are left to the adapter.
3. **Replay safety.** The report step is in a thin wrapper around the unchanged pipeline and runs only when the input carries the flag, so recorded runs replay exactly; the replay test passes unchanged.

## Consequences
- A prototype costs about one Claude implementation per task plus three model calls per milestone, instead of a review per task.
- With the flag on, the task is updated even when the adapter is gone. The flag is off by default because it has only been tested against a fake Paperclip: try it on one task and watch for a duplicate comment or a run that Paperclip leaves in a recovery hold, then turn it on.
- The reconcile step is unchanged and remains the backstop; its Paperclip-internal heuristics can only be retired after the flag has run in practice.
- Not built: making the adapter start runs without holding a lease at all (needs Paperclip's cooperation), milestone checks for other tiers, a configurable check prompt.
