# ADR 0026: A milestone check that changes nothing publishes a report

Status: Accepted (2026-10-31). Found in the first live run of the v2 plan (Minesweeper, LOC-135). Extends ADR 0018.

## Context
- A milestone check verifies the exit criteria and fixes only what falls short. When everything holds, the implementer changes nothing, which is the best outcome. The publish step then fails with "publish gate failed: no changes were committed", the run ends failed, the task rests in review and the next milestone never starts.
- LOC-135's first run found one issue (the 30×16 board is clipped on a phone screenshot). The pull-request screenshot shows the board is a deliberate pannable viewport (a 30-column board cannot fit a portrait phone at the 48-unit touch size), and the second run correctly changed nothing. The project then stood still on a correct result.

## Decision
- The workflow recognises a check by its title prefix (`MILESTONE_CHECK_PREFIX`, shared with the bootstrap that writes it). When a check ends with no changed file, the workflow writes `docs/checks/<task id>.md` (the check's title, the result and the implementer's summary) through the existing document activity. The task then publishes a normal draft pull request, finishes `completed` and gives the next milestone its branch and publication marker.
- Ordinary tasks are unchanged: no changes still fails at the publish gate, because an implementation task that built nothing is a defect.
- Replay safety: under `patched("milestone-check-report")`.

## Consequences
- Every milestone check leaves a record in the repository, whether it fixed something or not (a fixing check has its own diff).
- A check recognised by title: a task someone renames loses the behaviour. The prefix is one constant.
- Test: `test/lanes.test.ts` (report written and published; none for a check that changed something, none for an ordinary task).
