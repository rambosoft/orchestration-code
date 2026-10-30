# ADR 0020: A deferral the implementer declares and the reviewer passes is accepted, not left in review

Status: Accepted (2026-10-30). Found in the first live run of the v2 plan (Minesweeper, task LOC-116).

## Context
- The implementer ends its answer with `UNMET_ACCEPTANCE:` and the criteria it could not meet. Each item was a blocking finding at every review round (so no silently weaker variant ships). After the last round the task was published as a draft with the items as open findings and finished `needs_review`.
- A project contract may allow deferring a criterion that belongs to a later task (`docs/PROJECT_CONTRACT.md` in a generated project). In LOC-116 the implementer did so twice and the reviewer passed twice with the declaration in front of it. The task still ended `needs_review`; Paperclip showed it in review and every task depending on it waited for a person. An autonomous project stalled on the first real dependency.

## Decision
1. First round unchanged: a declared item goes back to the implementer for rework once, as before.
2. When the implementer then declares the item again and the review that follows finds no blocking finding and no external blocker, the item is an accepted deferral. It is recorded as a warning in the result ("accepted as a documented deferral after review"), not as a blocking finding, and the task finishes `completed`.
3. A review that still blocks keeps the old behaviour: bounded rounds, then a draft PR with the open findings and `needs_review`.
4. The milestone check (ADR 0018) is the backstop that verifies the deferred criterion is met by the time its milestone ends.
5. Replay safety: the rule is under `patched("accept-reviewed-deferral")`.

## Consequences
- A project no longer stops at the first deferral the contract allows. The cost is that a reviewer who waves a deferral through ends the question; the warning keeps it visible in the Paperclip comment.
- Tests: `test/typed-flows.test.ts` (deferral accepted after rework and a passing review; unmet item plus a blocking review still ends `needs_review`).
