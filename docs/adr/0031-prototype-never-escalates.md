# ADR 0031: A prototype task is never escalated to a review

Status: Accepted (2026-11-01). Narrows ADR 0015, decision 6, for the prototype tier. Completes ADR 0029.

## Context
- ADR 0015 decision 6 adds a review to a lane without one when the result changed more than 15 files or 600 lines, touches security, data or deployment paths, deletes test files, or the implementer reported unmet acceptance. ADR 0029 kept it for prototypes as a safety net and only stopped generated files from counting.
- Measured on the Fairway Frenzy chain (LOC-155 to LOC-162): a screen task always touches UXML, USS, C#, tests and docs, so the net fired on most of them (22 files, 16 files, 1124 lines, 832 lines). Each time the task ran a review with screenshots; on LOC-160 the review rejected, a repair round and a second review followed (about 20 of its 66 minutes), and LOC-156 spent two reviews and a repair round the same way.
- That is the per-task review the project decided against: a prototype reviews once per milestone, in the check task (ADR 0018, ADR 0029).

## Decision
- In the workflow, a run whose tier is `prototype` sets the lane's `escalation` to false, so a prototype task runs the stages of its lane and nothing more, whatever its size, paths, deleted tests or reported unmet criteria. A reported `UNMET_ACCEPTANCE` is still recorded in the run result and the milestone check verifies it.
- Under `patched("prototype-no-escalation")`: runs recorded before this change kept the escalation and replay unchanged. The replay fixture needs no regeneration (it has no tier, and the existing history replays through the old path); the replay test passes unchanged.
- Other tiers keep the escalation. Its tests now run on the `mvp` tier, which has the same stage list; a new test proves a prototype with 40 files, 5000 lines, a deleted test file, a risky path or an unmet-acceptance report stays `implement + verify`.

## Consequences
- A screen task of a prototype is one implementation call plus the gate; the review, its screenshots and the repair round move to the milestone check.
- A real defect now surfaces at the milestone check instead of the task. Keep milestones short, or add an intermediate check task.
- Takes effect after the worker restart; tasks already running keep the behaviour they started with.
