# ADR 0028: A prototype finishes when the only review finding is a check no code change can satisfy

Status: Accepted (2026-10-31). Found in the first live run of the v2 plan (Minesweeper, LOC-138). Extends ADR 0027.

## Context
- LOC-138's acceptance asks for a recorded profile on a mid-range Android device. The host has no device. Review 1 found the profile test too weak and the phone board clipped; the repair fixed what code could fix. Review 2 left one high finding, `fixableInCode: false` ("mid-range Android profiling evidence is still missing").
- A finding that no code can fix is an external blocker (`isExternalBlocker`). The workflow stopped with "external prerequisite requires operator action" and the task rested in review, although the chain had nothing a person could usefully do before the milestone check. Two review rounds had been spent and the third could only give the same answer.

## Decision
- For `prototype` and `throwaway` tiers, when the only remaining findings are external blockers whose category is not `approval` (a check that needs a device, a person or a later task; reviewers file a missing device under `acceptance` or `environment` alike, so the category cannot separate them), the findings go on the draft pull request as the open-findings comment and the task finishes `completed` with a warning, as in ADR 0027 step 3. The milestone check verifies the result.
- Unchanged: `approval` findings still stop the run for a person (the deterministic gates have passed, so a real setup problem would already have failed them), MVP and production tiers still stop on any external blocker, and code-fixable findings are still repaired first.
- Replay safety: under `patched("accept-unfixable-prototype")`.

## Consequences
- A criterion that needs hardware the host lacks is recorded on the pull request and no longer blocks a prototype; the evidence gap is visible, not hidden.
- Not done: the planner should mark such a criterion as manual or deferred when it writes the task, so the implementer does not build a test that only asserts on a device.
- Tests: `test/typed-flows.test.ts` (prototype finishes with the comment; MVP and an environment finding still stop).

## Correction (same day)
The first version excluded `environment`. The next review of LOC-138 filed the same missing device measurement under `environment`, so the run stopped again. The rule now excludes only `approval`.
