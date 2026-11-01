# ADR 0030: A lane without plan and brief stages gives the implementer the full task text

Status: Accepted (2026-11-01). Corrects ADR 0015, decision 4.

## Context
- ADR 0015 decision 4 says that without a plan or brief stage "the brief is built from the task text (`deterministicPlan` / `deterministicBrief`): no model call, and the acceptance criteria are already in it". That was not true. `deterministicPlan` without an OpenSpec digest sets `acceptance_criteria` to the generic line "Implement the task as described and cover it with focused tests", `task_goal` to the first non-empty line of the task clamped to 300 characters, and the brief's hard constraints to the sentences of the task that contain *never*, *do not*, *avoid* or *must not* (`extractTaskConstraints`). The implementation prompt is the formatted brief and nothing else.
- So on every `implement + verify` run the implementer saw one line of the task, the prohibition sentences, and nothing of the acceptance criteria or the "read first" paragraph. The verify gate still demanded a `Covers:` test for every criterion id in the full task, so a task either failed the gate or passed it by deferring criteria nobody had read.
- Found on Cinderfield LOC-157 (T33): the implementer built only T33-AC1, the one criterion containing the word "never", and answered the repair pass "the task text gives only T33-AC1" (it refused to invent AC2 to AC5, correctly). LOC-156 (T32) passed its gates yet reported "no screen uses it yet" and an unchanged game name: its rename criterion had never reached it.
- The Minesweeper tasks before ADR 0029 mostly ran the heavy lane, where the plan stage reads the whole task, which hid the defect. ADR 0029 moved every non-check prototype task to the lean lane and exposed it.

## Decision
- A run whose brief was built from the task text (`briefFromTask`) gives the implementer, the gate-repair pass, the review-repair pass and the reviewer the full task text first ("TASK (the full text from the task board; its acceptance criteria are binding)"), then the brief. `briefText()` in `src/workflows.ts` replaces `formatBrief` at the eight places that hand the brief to a model. Runs with a plan and brief stage are unchanged.
- Prompt text only. No workflow command is added or reordered, so there is no `patched()` and the replay fixture is unchanged.

## Consequences
- An implement prompt grows by the task text (about 1 000 tokens for a 4 000 character task). Cheaper than one repair round.
- Tasks that already ran lean may have shipped with unread criteria. Those whose report admits it, or whose acceptance trace needed a repair pass, should be re-run or checked against their criteria; see STATUS.
- Regression test: `test/lanes.test.ts`, "gives a lean task's implementer the full task text". It fails without the change.
