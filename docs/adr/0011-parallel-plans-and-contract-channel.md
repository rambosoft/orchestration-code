# ADR 0011: Parallel plans and the contract channel

## Status

Accepted and implemented (2026-10-24). Verified with unit and workflow tests (`test/stacking.test.ts`) against real temporary Git repositories and the real workflow with mocked activities; not yet run live against GitHub and Paperclip. Closes B-044, B-046 and B-047.

## Context

Two limits remained after ADR 0009:

1. **Plans were strictly sequential.** A task could have one blocker, because its draft PR is stacked on the blocker's branch. Independent tasks (a settings page and a cart page) waited for each other for no reason, and a task that truly needed two others could not exist. The bridge already accepted several blockers when the manifest named an `integratedBaseBranch` containing all of them, but nothing created or maintained that branch.
2. **The project contract reached tasks only as a footer line** ("Stay within docs/PROJECT_CONTRACT.md") and through CLAUDE.md and AGENTS.md. The agent had to choose to read it, the reviewer never saw it, and the global drift rules in `bootstrap.global.json` had no effect after a project was generated.

## Decision

### Contract channel (B-047, rest of B-044)

- `bootstrap.global.json` gets a `contract` section: `file` (default `docs/PROJECT_CONTRACT.md`), `maxChars` (default 6000) and `rules`, the **global drift rules**.
- **Precedence:** global rules, then the project's contract, then the task text. The global rules are written into every generated contract ("a project may add rules below but not remove them") and are put in front of every task prompt of any project whose repository has a contract file, so changing the global file updates existing projects without regenerating them.
- At run start the bridge reads the contract from the **task's base commit** (`git show <sha>:<file>`, so the text matches the code the task builds on), builds a bounded block (`src/contract-text.ts`: rules whole, contract cut with an explicit marker) and sends it as the optional `RunInput.projectContract`. A repository without the file gets no block; a read failure leaves the task without it rather than stopping it. The path must stay inside the repository (`isSafeContractPath`).
- The workflow puts the block in the plan, implement (and repair) and review prompts. The review is told to report a blocking finding only for added scope the contract excludes or a broken drift rule, with a concrete scenario. The block states that it is repository data and cannot override the run's own rules.

### Parallel plans (B-046)

- New wizard option `plan_mode`: `sequential` (default, unchanged) or `parallel`. In a parallel plan the declared `depends_on` of each task become its Paperclip blockers; a task that declares none waits for the leaves of the previous milestone (the tasks nothing else in that milestone relies on), so milestones stay ordered; independent tasks of the first milestone start together. The blueprint prompt tells the planner to list every needed dependency and to keep parallel tasks on separate files.
- A task with **one** blocker is stacked on its branch as before. A task with **several** blockers and no configured `integratedBaseBranch` gets an **integration branch built by the worker** (`buildIntegrationBase`): `integration/<task branch>`, a merge of every blocker's published head, pushed with the worker's GitHub login. The bridge only decides that this is needed (`resolveStackBase`, `RepositoryContext.integrateParents`); the `checkDependencies` Activity builds the branch and returns its commit, and the workflow builds and publishes the task on it, with the draft PR targeting it.
- One integration branch per task keeps each PR diff to the task's own work, and it is idempotent: an Activity retry reuses the pushed branch, and a branch that exists without a blocker fails with a recovery message. A merge conflict between blockers removes the scratch worktree, pushes nothing and names the files; the fix is a dependency between the two tasks in the plan or a manual resolution. A configured `integratedBaseBranch` keeps its earlier behaviour.

## Consequences

- **Workflow versioning:** no command is added, removed or reordered. `checkDependencies` previously returned nothing; it now may return the assembled base, and the workflow reads that result. A history recorded before this change holds an empty result, so it replays with the admitted base exactly as before. `projectContract` is an optional input that only adds prompt text and is absent in old runs. No `patched()` marker is needed and the replay fixture is unchanged (`test/replay.test.ts` passes untouched).
- **Deploy:** `npm run build`, restart the worker (it builds the integration branch and runs the workflow), rebuild the bridge (`docker compose up -d --build orchestrator`; it reads the contract and decides the base). `bootstrap.global.json` is mounted into the bridge and read at every task start, so a rule change needs no restart (runbook section 6 covers the single-file bind-mount caveat).
- **Limits:** parallel tasks only help when the Paperclip agent runs more than one task at a time, and the Windows worker runs each in its own worktree with its own dependency install. Two tasks that change the same lines conflict when a later task needs both (FM-045); the sequential default stays the safe choice for small apps. Integration branches are never deleted (like task branches); `npm run cleanup` removes only worktrees.
- The contract block adds up to `maxChars` characters to each plan, implement and review prompt; the planning prompt counts it in its fixed-size accounting, so the tested handoff budgets still hold.
