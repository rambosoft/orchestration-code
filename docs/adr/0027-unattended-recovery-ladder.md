# ADR 0027: An unattended project recovers from every non-final ending without a person

Status: Accepted (2026-10-31). Found across the first live run of the v2 plan (Minesweeper): LOC-116, 117, 132 and 135 each stopped the chain until an operator acted. Extends ADR 0016, 0020 and 0024.

## Context
- The orchestration healed only transient and machine failures (resume once). Every other ending was classed "escalate to a person": a gate or model failure, an unclassified failure, and a task finished `needs_review`. A task resting in review or failed stops everything behind it, so an auto-approved prototype stood still until someone resumed it, set it to `todo`, or deployed a fix and re-queued it. Each fix was a separate special case (ADR 0020, 0022, 0025, 0026); the dead ends themselves stayed.

## Decision
A ladder, from the cheapest recovery to the one that needs a person:
1. **Resume once on a gate or model failure.** The resume keeps the finished implementation and runs the gates, the one bounded repair pass and the review again (what an operator did by hand). Budgets, external prerequisites and failures nobody can classify still wait for a person. (`autoResumeDecision`, `src/reconcile.ts`.)
2. **Resume once more after a deploy.** The reconcile service runs inside the worker and passes the worker's start time. A failure that ended before the current worker started is resumed one more time and the 30-minute age window does not apply: the new code may have fixed it.
3. **A prototype or throwaway task finishes when only advisory review findings remain.** After the bounded rounds, the draft pull request still carries the open findings as a comment, but the task is `completed` with a warning and the chain continues. The milestone check (ADR 0018) verifies the result. MVP and production tiers keep `needs_review`. (`patched("accept-open-findings-prototype")`.)
4. Everything else stays a person's decision, in `in_review` with the failure as the comment (ADR 0024), bounded by the run-storm breaker.

## Consequences
- The attempts per task are bounded: one resume, one more after a deploy, six runs in half an hour at most.
- A prototype's per-task review can no longer stop the project; its findings are not lost, they are on the pull request.
- Not done: an auto-resume for `unknown` failures (a person should look at those), and a policy for MVP and production tiers (their review is meant to gate).
- Tests: `test/reconcile.test.ts` (gate and model resume, redeploy rule), `test/typed-flows.test.ts` (prototype finishes with open findings).
