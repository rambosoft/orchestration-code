# ADR 0029: A prototype reviews and runs its slow tests once per milestone

Status: Accepted (2026-10-31). Extends ADR 0015 (lanes) and ADR 0018 (milestone checks).

## Context
Measured from `data/logs/worker-activity-events.jsonl` for the Cinderfield Minesweeper project (166 stage completions, 16 game tasks):
- `implement` is 543 of about 566 stage-minutes (median 4.5, p90 24.6). Plan, review and the one-off setup stages are noise next to it.
- The blueprint marked most tasks `Lane: heavy`, and a prototype heavy task still ran plan, implement, review, verify. The review rejected 22 of 43 times, and every rejection cost another implement round of 2 to 15 minutes plus a second review. ADR 0018 put one review in the milestone check, so the per-task review was paid for twice.
- The gate runs the full PlayMode suite after every task (1 to 8 minutes, more with repairs), and the task text told the agent to run the same suite itself at the end, so it ran twice.
- OpenSpec and analysis were already off for prototypes by the lane table; the manifest flags only looked as if they were on.

## Decision
1. **Lane.** On a `prototype` project the bridge runs every task except a milestone check no heavier than standard (`implement + verify`), whatever `Lane:` the blueprint wrote, and always runs the milestone check heavy (plan, implement, review, verify), even if its text has no `Lane:` line. `effectiveLane` in `src/lanes.ts`, called by `src/server.ts`. An operator who wants a per-task plan or review on a prototype changes the tier, not the lane. The lane table is unchanged, so its golden test still holds.
2. **Tests once per milestone.** A quality command may carry `scope: "milestone"` (`QualityCommandSchema`). On a prototype the bridge gates a task on the commands without that scope, and the milestone check on all of them (`gateCommandsFor`). If every command is milestone-scoped they all stay, so a task is never left without a gate. The Unity template marks the PlayMode suite `scope: "milestone"` for prototypes; EditMode and the hygiene check still gate every task. The agent still runs the PlayMode fixtures it touched while it works, and the acceptance trace ("Covers:", slice criterion) still runs on every task; only the full run waits. Other tiers ignore the scope.
3. **Task text.** For a prototype the per-task time-budget paragraph no longer tells the agent to run the full PlayMode suite at the end (`gameAcceptance(..., milestoneSuite)`).
4. **Escalation.** The review that a lane without review adds after a large result no longer counts generated and binary files (`.meta`, images, audio, fonts) towards the 15-file limit. `assessChanges` returns an extra `countedFiles`; `files` is unchanged because the check task uses it to decide "nothing changed". A recorded result without `countedFiles` counts every file as before.
5. **Cinderfield manifest** (local, git-ignored): PlayMode `scope: "milestone"`, `openSpec.enabled` and `analysis.enabled` false so the file says what the lane does.

## Replay safety
No workflow command sequence changes: the lane and the command list are decided in the bridge and arrive as run input, and the escalation field is activity output. No `patched()` and the replay fixture is unchanged. Runs already recorded keep their stage list.

## Consequences
- A prototype task is one implementation call plus EditMode and the hygiene check; a milestone costs one plan, one implementation, one review and the full suites. On the Cinderfield data this removes the plan and review calls of every heavy task and the repair rounds the review caused, and shortens each gate by the PlayMode run.
- A regression that only the full PlayMode suite catches now surfaces at the milestone check, which fixes it with the smallest change (ADR 0018). A long milestone therefore risks a larger fix; keep milestones to about 4 to 6 tasks, or add an intermediate check task.
- Not done: running independent tasks in parallel (needs several Paperclip agent slots and one Unity import per worktree), a cheaper review model, a seeded Unity `Library` for new worktrees.
