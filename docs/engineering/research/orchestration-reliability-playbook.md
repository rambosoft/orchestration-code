# Orchestration reliability: brief for the improvement session

Written 2026-11-04 after the Luxus M1 run (LOC-170 R12, LOC-174 R3). Read this first, then follow the steps in the operator's list.

## Goal (operator, verbatim intent)
The orchestration must be reliable and not break on each task. It must decide itself when a task is too big and split it into smaller tasks, and give each task the stages it needs: a small task is quick to implement with few stages and verifications. Tests run only on the affected area per task, and the whole app once per milestone, unless the project's manifest forces the full suite for every task.

## Evidence (what failed, and why)
- R3 (shell and auth bootstrap) was one task: implement timed out at 45 min on a fresh worktree in both runs (codex, ~2.5M input tokens per pass). A pass that started from the half-written worktree needed 22 more minutes. So the task was larger than one pass; the 45 min limit cut productive work and every retry paid for the context again.
- The activity retry reuses the partial worktree: the second attempt inherited a barrel `src/services/index.ts` that did not export what `App.tsx` imported, and did not converge (typecheck, lint, test and knip all failed, 4 min total, nothing hangs).
- The stall guard for implement equals the stage timeout (45 min), so it never fires first.
- Review crashed with `spawn ENAMETOOLONG` (the prompt with the diff was an argument): fixed in 353dd4d (prompt on stdin). Needs `npm run build` and a worker restart after any change.
- What codex did inside a timed-out run was lost: c9a2591 now puts command, file-change and turn counts into the timeout error.
- The stacked chain breaks when a branch of a parent moves after its published run (FM-068); a failed run kept the issue escalated in Paperclip, a clone issue was needed (LOC-171 cancelled, LOC-174 is R3).
- Claude CLI was signed out for a while; routing review to claude made review a single point of failure.

## Requirements for the change
1. Size gate at planning: estimate a task (files, areas, public surface, characterization/doc obligations) and split above a threshold into ordered subtasks with their own acceptance criteria and blockers. Reuse `src/plan-from-survey.ts`, the plan schema in `src/handoffs.ts`, the `--only/--area` options.
2. Stage profiles by size: small = implement + affected tests + one review; medium = + specialist review; large = split first. Fewer stages means a smaller replay/command sequence: workflow edits need `patched()` and a regenerated replay fixture (docs/engineering/EXTENDING.md); prefer data on existing steps.
3. Test scope policy in the manifest: `affected` per task (the intelligence `affected-tests` tool exists), the whole app at milestone gates, `full` forced per task when the project says so.
4. Retry policy: cap implement attempts, start a retry from a clean worktree or the last verified commit (not a half edit), stop a run that makes no file change for N minutes (no-progress guard), and stop paying for the same task more than twice.
5. Failed-run hygiene: a failed dispatch must not leave Paperclip escalated; the chain recovery (FM-068) should be a command, not API archaeology.
6. Model routing (cost): codex default, claude (opus) for architecture and critical areas, review not on a single provider, DeepSeek flash for cheap review.

## Rules of the repo that apply
CLAUDE.md hard rules: reproduce defects with a failing test first, affected tests per task and the full suite once at the end (memory: test policy), stage by explicit path, `type(scope): summary [B-NNN]`, push only `mission/hardening`, update BACKLOG.md, STATUS.md and CHANGELOG-MISSION.md after each item, no PRs unless asked.

## Open luxus state
M1 chain: R12 merged (PR 14), R3 = LOC-174 (no PR yet; worktree C:\w\b444d039-7135-486c-bb01-e490025e661e holds a partial, failing implementation), R5 = LOC-172 (blocked by LOC-174), INPUT = LOC-173. Do not start them before the new planner exists.
