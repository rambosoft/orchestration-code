# ADR 0005: Optional analysis stage before planning

## Status

Accepted

## Context

Plan and brief stages choose an approach implicitly, in one pass, with no recorded alternatives. For tasks where the right answer is an algorithm or a set of tuned parameters (a difficulty curve, a rate limit, a retry schedule) that is where quality is won or lost: the first plausible approach is implemented, and reviewers have nothing to compare it against. OpenSpec describes WHAT must hold; nothing in the pipeline compares HOW.

## Decision

- Add an optional `analyze` stage between the OpenSpec digest and planning. It runs read-only (Codex read-only sandbox, Claude plan mode) and returns one validated JSON object (`AnalysisSchema`): the problem and implied constraints, two to five genuinely different candidate approaches with strengths and weaknesses, explicit evaluation criteria, the chosen approach with named parameters and the derivation of each value, testable validation properties, risks, and one to five implementation requirements.
- Enable per task with an `Analysis: on|off` line in the task text, or per project with `analysis.enabled` in the manifest. The route is `providerRouting.analyze` and defaults to the project default provider.
- Validate with the same pattern used elsewhere: one bounded repair pass with the validator's diagnostics, then fail with `analysis_output_invalid`. Parsing tolerates fenced or prose-wrapped JSON but never accepts truncated JSON.
- The decisions are authoritative downstream. Implementation requirements and validation properties are merged into the plan's protected hard constraints, so they reach the brief verbatim and cannot be paraphrased away. The planning, implementation and review prompts receive the decisions block; review treats a contradiction of a chosen parameter, or a missing test for a validation property, as blocking.
- The full analysis is rendered to `docs/analysis/<task>.md` (configurable `analysis.docsDir`, must stay inside the worktree) by the `writeAnalysisDocument` activity before publication, so the reasoning is part of the pull request.
- The workflow branch is guarded with `patched("analysis-stage")` so in-flight workflows replay unchanged. Handoff budgets grow accordingly (planning context 3600, brief 1700 tokens) with unit-tested invariants.

## Consequences

- Tasks that opt in gain a comparison of alternatives, concrete numbers with derivations, and tests required by name; reviewers and the PR carry the reasoning.
- One extra model call per opted-in task (about a minute and under 1.4k output tokens) and one more failure surface (covered by repair and tests).
- The analysis is only as good as the model's reasoning from repository text: it cannot run experiments. The validation properties exist so that the implementation proves the claims with tests.
- Tasks that do not opt in are unchanged.
