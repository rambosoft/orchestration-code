# ADR 0006: One recovery policy for every structured stage, enforced review, and size limits that warn

## Status

Accepted

## Context

Live runs failed repeatedly for reasons that had nothing to do with the task: a spec with the wrong heading, a model answer that was a few characters over a limit, JSON wrapped in a code fence, an extra key, a lint warning about requirement length surfacing after the work was already done. Each failure was fixed where it appeared, which left roughly thirty independent fail-fast exits in `projectWorkflow`, each handling model output its own way. Auditing them also found two gates that did not gate: the reviewer's verdict was parsed only for OpenRouter, so a Codex or Claude review could never block anything; and deterministic verification passed vacuously when a project had no quality commands, followed by a model "verify" call that could only ever pass.

## Decision

- **One policy** (`structuredStage` in the workflow) for every stage whose answer must be structured: validate, then up to N repair attempts that carry the validator's diagnostics, then a **deterministic fallback** built only from already validated inputs (`src/fallbacks.ts`), and only when no fallback exists fail with the last diagnostic. Digest, plan and brief always have a fallback; analysis salvages what it can and otherwise is skipped with a recorded warning. Infrastructure failures (an activity failing after its retries) are not repaired; they fail with a precise stop reason.
- **Tolerant in, strict out.** Handoff schemas drop unknown keys, coerce scalars to lists, default missing fields and clamp over-long descriptive text; identifiers and protected requirement text are never altered. Token budgets on outputs remain the hard control and always have a compress-or-fallback path.
- **Size never fails a run.** Input-side budgets are generous (planning context 12k tokens), specification text above 10,000 characters is accepted with a warning, and OpenSpec's own style findings (long or brief text, "consider splitting", placeholder purpose) are non-blocking. Structural findings still fail with the validator output and get a repair pass.
- **Gates must gate.** The review assessment is read for every provider (`applyReviewAssessment`), tolerant of fences, prose and unknown severities; an unreadable review gets one restatement request and then fails closed (`review_unparseable`). Review runs up to four rounds (default two). A code task without quality commands is refused at admission and again at the workflow start. The redundant model verify call is dropped.
- **Warnings are first-class.** Fallbacks, skipped analysis and size warnings are collected in `metadata.warnings` and appended to the final message, which the Paperclip adapter already posts into the issue.
- **Proof, not hope.** `test/chaos.test.ts` runs the real workflow against a mock model that corrupts each structured stage in eight ways; `test/robustness.test.ts` fuzzes the fallbacks over hundreds of random specs. A new structured stage is not done until it is in the chaos table.

## Consequences

- A run whose real work is sound no longer dies on formatting or size; degraded stages are visible, not silent.
- Review findings now actually block, so runs can fail on genuine reviewer objections where they previously passed. That is the intended behaviour of the gate.
- Deterministic fallbacks are less polished than a good model answer (a plain brief, acceptance criteria taken from requirement text). Warnings tell the reader when one was used.
- More code paths (about 400 lines) with a test table to keep them honest.
