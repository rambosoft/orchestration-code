# ADR 0015: A task runs the stages its tier and lane need

Status: Accepted (2026-10-30). Part of the v2 plan, section 3.3 (docs/engineering/research/orchestration-v2-redesign.md).

## Context
Every implementation task ran the same pipeline: OpenSpec, spec optimisation, optional analysis, plan, brief, implement, verify, review (and repair rounds). On a small task of a prototype the model calls before and after the implementation cost as much as the implementation; the operator is on Claude Pro and the free Codex tier, where every call counts. The bootstrap already knew how finished a project must be (`maturity`), but nothing downstream used it.

## Decision
1. **Tier** = the project's maturity (`throwaway | prototype | mvp | production`), written into the generated manifest as `tier`. **Lane** = the task's weight (`light | standard | heavy`), from the `size` the blueprint gave it (`small|normal|large`, written into the task text as a `Lane:` line for small and large) or an explicit `Lane:` line.
2. `src/lanes.ts` holds one table, tier x lane -> stages, OpenSpec, analysis and escalation. Prototype and throwaway tasks are `implement + verify`; MVP standard tasks add a plan and one review; production keeps the full pipeline; OpenSpec and analysis run only for heavy production tasks. The table is pinned by a golden test.
3. The bridge computes the lane (`src/server.ts`) and passes `tier` and `lane` in the run input; OpenSpec and analysis follow the lane unless the task has an `OpenSpec:` / `Analysis:` line. The workflow replaces the profile's stage list with the lane's for `implementation` and `refactor` profiles only. Bug, research, architecture and bootstrap flows are unchanged.
4. Without a plan or brief stage the brief is built from the task text (`deterministicPlan` / `deterministicBrief`): no model call, and the acceptance criteria are already in it.
5. A lane without a review stage still runs the deterministic checks directly, with the same one bounded gate-repair pass.
6. **Escalation**: after implement, a lane without review gets one anyway when the result changed more than 15 files or 600 lines, touches security, data or deployment paths, deletes test files, or the implementer reported unmet acceptance. The check is an activity (`assessChanges`, git only) and the reasons are added to the run's warnings.
7. **Replay safety**: tier and lane are workflow input data, so a run recorded without them keeps the profile's stage list and a recorded run replays unchanged. No `patched()` is needed and the replay fixture is unchanged.

## Consequences
- A prototype task costs one implementation call plus the deterministic checks. A manifest without `tier` (every existing project) keeps today's behaviour until it gets one.
- The bootstrap's MVP preset used to turn OpenSpec on for every task; with lanes it applies to heavy production tasks only. Set `OpenSpec: on` in a task, or leave the manifest without a tier, to keep the old behaviour.
- Not built yet: the single milestone-level review for prototypes (a milestone review task kind), blueprint-declared risk beyond size, and routing fallback chains.
