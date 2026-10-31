# ADR 0025: A failing gate command carries the acceptance trace with it

Status: Accepted (2026-10-30). Found in the first live run of the v2 plan (Minesweeper, task LOC-132). Extends ADR 0022.

## Context
- The verify gate runs the quality commands in order and stops at the first failure; the acceptance trace (every numbered criterion has a `Covers:` test, a reachability test boots the scene) ran only after every command had passed.
- LOC-132 (pause and settings screens) hit an unrelated flaky timing test in the Unity PlayMode suite first. The task's single repair pass fixed that test. The trace then ran, found that two criteria had no test, and failed the task with no repair left. The trace reads test sources only: it was known before the first Unity run and could have been repaired in the same pass.

## Decision
- The trace is computed before the commands run. When a command fails, its result carries the trace problem as an extra `acceptance-trace` check, so the findings that go to the repair prompt contain both. When every command passes, the trace still fails the gate on its own, as before. The trace is not run when a passing result is reused.

## Consequences
- One repair pass can fix a failing test and the missing criteria tests together. A task with several independent gate problems no longer needs one repair per problem it cannot afford.
- No extra Unity run: the trace is a file read. Test: `test/gate-trace.test.ts` (a failing Unity command and an untested criterion are reported together).
- Not done: repairing more than once per gate (the budget stays one pass, see the robustness rules).
