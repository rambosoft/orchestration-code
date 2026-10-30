# ADR 0022: A failed run is recorded as blocked with an owner and an action; the reachability gate sees a boot done in setup

Status: Accepted (2026-10-30). Both found in the first live run of the v2 plan (Minesweeper, task LOC-117). Extends ADR 0021.

## Context
1. **Recording a failure.** When a workflow fails, the adapter sets the Paperclip task to `blocked` with the failure as a comment. Paperclip now answers HTTP 422 to `blocked` without an unresolved blocker, a pending approval or an `unblockDescriptor` ("Entering blocked requires ..."). The adapter never sent one, so every failed run ended "Workflow result could not be recorded in Paperclip; task requires recovery" and the task stayed in the state the run left it in. The adapter test passed because its fake Paperclip accepts any status.
2. **The reachability gate.** A screen task carries a criterion "Reachable from the real game"; the gate (`sliceProblem`, ADR for the first game) requires the covering test to boot the real scene. It read only the 80 lines after the `Covers:` comment. The Minesweeper menu task had a fixture whose `[UnitySetUp] Boot()` calls `SliceHarness.Boot()` for every test, and its covering test asserted layout on the running menu. The gate called it "does not boot the real game scene", the run spent a repair round on it, and the task failed on a correct implementation.

## Decision
1. `blocked` always carries `unblockDescriptor: { owner: "board", action }` (the action says to answer the question for `needs_info`, otherwise to read the failure, fix the cause and resume or move the task back to todo). One helper, `statusPatch` in `src/reconcile.ts`, is used by the reconcile step and the worker-side report; the adapter (plain JavaScript in the Paperclip container) has the same two lines. The tests check the request body, because a fake server cannot enforce the rule.
2. The gate counts a boot done by a setup method (`[UnitySetUp]`, `[SetUp]`, `[OneTimeSetUp]`, `[UnityOneTimeSetUp]`) of the same file, or by a helper method of the same file that contains the boot call and that the covering test calls. A boot in an unrelated test, a missing assertion and a missing boot still fail.

## Consequences
- A failed run lands as a visible blocked task with a named next action instead of an unrecorded state.
- The gate stays a source trace and keeps its limits (a boot in a base class or another file is not seen); the next false negative is handled the same way, with a test of the real pattern first.
- Tests: `test/reconcile.test.ts` (`statusPatch`), `test/adapter-resilience.test.ts` (request body), `test/acceptance.test.ts` (setup and helper boots).
