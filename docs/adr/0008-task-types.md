# ADR 0008: Task types with their own flows (bug, research, architecture)

## Status

Accepted

## Context

Every Paperclip task ran the same pipeline: plan, brief, implement, review, verify. The profile ids `bugfix` and `refactor` existed but had the same stages as `implementation`, and `research` was one generic model call that produced no document. Real work differs. A bug needs its cause understood and proven before anything is changed; a research or architecture question must never change code, but it needs enough project context to be answered well without handing a model (or a third-party API) the whole repository.

Also, the type was chosen per Paperclip agent (`config.profile`), so one agent could only ever handle one kind of task.

## Decision

**A task type is the user-facing concept; a profile stays the delivery stage list it reuses.** `src/task-types.ts` holds the registry (`task`, `bug`, `research`, `architecture`) and the single resolver `resolveTaskType`, with one precedence: explicit API field, then Paperclip labels (`type:bug`, `kind: research`, or a bare unambiguous `bug`/`spike`), then a `Type: bug` line in the task text, then the agent profile (`bugfix` implies bug, `research` implies research). Conflicting labels are an error. The adapter only forwards label names; the bridge resolves them, so there is one definition. A run without a `taskType` takes the original pipeline unchanged, which keeps in-flight Temporal runs replayable (the replay fixture is unchanged).

**Bug flow** (`src/bug.ts`). Two stages run side by side and feed each other:
- `diagnose` (read-only) traces the report through the code and returns hypotheses that each carry concrete evidence and an observable failure; a hypothesis without evidence is dropped by the schema, and the prompt forbids improvements and hypothetical hardening. It also designs the fix: options marked `root_cause` or `workaround`, and a workaround may only be chosen with a written justification.
- `reproduce` (may edit test files only) writes a failing test and names the command and a signature of the failure. The `verifyReproduction` activity does not trust the claim: it undoes edits outside test paths, re-runs the command and requires the announced signature. The command is limited to existing test runners or relative scripts (`reproductionCommandProblem`), because a model chose it and it runs on the worker.
- If only one half succeeds, the other is re-run once with the first's result as a hint (hypotheses and scenarios for reproduction; the failing test output for diagnosis). If neither produced anything, the run ends as `needs_info`: nothing is changed, the issue is blocked, and the comment says what to add or to reproduce manually.
- Then the existing plan, brief, implement, review, verify run. The diagnosis travels as protected constraints and a decisions block (as in ADR 0005); a confirmed reproduction is appended to the verify gate so it must pass after the fix. Without a reproduction the implementation must add its own regression test and a warning is recorded. OpenSpec and the optional analysis stage do not run for bugs unless OpenSpec is explicitly requested. The diagnosis is committed as `docs/analysis/<task>-diagnosis.md`.

**Research and architecture flow** (`src/research.ts`, `src/context-pack.ts`). `scope` turns the request into questions and search terms; a deterministic, redacted, size-bounded context pack is built from them in the isolated worktree (file map, README, package script names, snippets around the terms; credential files and secret-shaped text are excluded); `explore` answers from the pack and returns a validated report with evidence references, confidence, open questions and follow-up task suggestions. Architecture adds options with pros and cons, a decision and consequences (ADR style). The report is committed under `documents.researchDir` / `documents.architectureDir` as a draft PR (`publishWorktree` with `kind: "document"`), and the same markdown is posted as the issue comment. Nothing is implemented. An unreadable exploration answer is kept, redacted and marked, rather than discarded.

All new structured stages use `structuredStage` (validate, repair with diagnostics, deterministic fallback) and are covered by the defect matrix in `test/typed-flows.test.ts`.

## Consequences

- One Paperclip agent can handle every type; the type is visible on the board as a label.
- New provider routes: `providerRouting.diagnose|reproduce|scope|explore`. Quality commands are looked up by task type, then delivery profile, then the agent profile name.
- Workflow impact: no existing command sequence changed, no `patched()` needed; the typed branches are selected by `input.taskType`, which is part of the workflow input. The replay fixture is unchanged and still passes.
- `RunResult.status` gains `needs_info`; the adapter blocks the issue with the question and exits 0 (a normal outcome). Anything that switches on the status must handle it.
- Limits: the reproduction check runs agent-written tests on the worker (the same trust as the existing verify gate). Context quality depends on the scope stage's search terms. Verified with the fake provider only; no real Codex or Claude run of the new flows has been made yet.
- Not done: a refactor type with a behaviour-preserving gate, and creating the suggested follow-up tasks automatically.
