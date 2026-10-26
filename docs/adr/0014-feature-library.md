# ADR 0014: Feature library (reusable features copied into projects)

## Status

Proposed (2026-10-26), extended the same day with the decisions for the first projects (a Unity game with a Spring Boot server, sections 7 to 10). Design only: no code, no library repository, nothing deployed. Evidence for the design is a literature and tool survey (below) and the orchestration's own timing data (B-056); the savings claims are estimates until the pilot in this ADR measures them.

## Context

Most future projects will share a large part of their features (authentication, CRM, dashboard, lead board, ranking). Today every project regenerates them: each feature goes through analysis, plan, implement, review and repair, and the model produces slightly different code, structure and security behaviour each time. The measured cost of that is visible in `npm run timing`: implement dominates (343 of 534 minutes across 39 real runs, one Unity task cost about 5 USD and 35 minutes), 17 of 39 first reviews were rejected, and nothing is carried from one project to the next.

The goal is a place where tested features live once, and the orchestration can install one into a new project, adapt it to that project's style and contract, extend it with options (remember me, forgot password, SSO, code verification), and send improvements back.

### What exists elsewhere (survey, 2026-10-25)

| Idea | Source | Takeaway |
|---|---|---|
| Distribute source, not packages | [shadcn registries](https://vercel.com/academy/shadcn-ui/what-is-a-component-registry.md): a registry serves source you copy, including hooks, pages, configs and rules | The model asked for here. React-centred. |
| Templates with options and later updates | [Copier](https://copier.readthedocs.io/en/latest/comparisons/): updates through Git tags and stored answers; Cookiecutter has none; [cruft](https://gitlab.developers.cam.ac.uk/uis/devops/webapp-boilerplate/-/issues/89) was judged not useful for updating by one team | Updates need a recorded base version. |
| Extract components from a project and version them | [Bit](https://bit.dev/blog/-extracting-and-reusing-pre-existing-components-using-bit-add-l28qlxpz) | JavaScript, package and cloud oriented. Rejected as a base. |
| Golden-path scaffolding | [Backstage Scaffolder](https://roadie.io/blog/the-backstage-scaffolder-a-powerful-new-orchestration-tool) | Team platform, too heavy. |
| Optional features with constraints | Software product lines: [feature models](https://arxiv.org/pdf/2505.03265); LLM-assisted [reengineering of variants](https://dsp.tecnalia.com/items/e22b9c5e-d0dd-4004-802a-2e16fd792133) needs human review | Describe options with `requires` and `conflicts`. Keep a human in the loop. |
| Reusable assets in Unity | Unity packages ship [Samples](https://docs.unity3d.com/Packages/com.unity.cloud.identity@1.4/manual/sample-authentication.html) copied into the project | Same shape for Unity features. |
| Agent maintains a shared library across apps | [Super Library Agent](https://hyper.ai/en/papers/2608.29310) (KAIST, DeepAuto, 2026): naive one-pass extraction has low recall and breaks migrations; guided extraction was better; with a mature library total lines fell about 11% and UI accuracy rose from 80.95% to 84.35%, on content-presentation web apps only | Extraction must be guided and reviewed; the benefit is real but modest on that benchmark. Read from the abstract and results page only. |

No ready-made tool covering extraction, storage, reuse and AI adaptation end to end was found. The search was not exhaustive. Vendor figures (for example a 66% code reduction claim) were not used.

## Decision

### 1. Shape: curated source modules copied into the project

A feature is a set of reviewed source files with tests, a spec and a contract. It is **copied** into a project (no runtime import, no package). The project then owns the code. A lock file records where it came from so that it can be compared and updated later.

### 2. The library is a separate private Git repository (data only)

```
features/<feature-id>/
  feature.json            family level: id, summary, options, constraints, contract version, status
  contract/               openapi.yaml, error codes, feature.spec.md (requirements with ids, e.g. AUTH-001)
  stacks/<stack-id>/      spring-boot | react-ts | unity-mobile | ...
    stack.json            files per option, tokens, dependencies, config keys, adaptation points, verify commands
    files/...             source and tests, LF line endings (.gitattributes)
```

- Features are **separate per stack and share one contract**. A backend and a frontend that implement the same feature declare the same contract major version (`contract: 1.x`); `add` refuses a combination with different majors in one project. Breaking contract changes bump the major version.
- Versions are per feature, as namespaced Git tags (`auth/1.2.0`), because one repository holds many features. The lock stores the version and the commit.
- The library holds no executable install scripts. `add` and `update` only copy and merge files.

### 3. `feature.json` and `stack.json` (schemas live in the orchestration repo, zod, like `contracts.ts`)

- `feature.json`: `id`, `title`, `summary` (at most 200 characters, it is what the blueprint sees), `version`, `status` (`draft` | `curated` | `proven`), `stacks`, `options[]` (`id`, `title`, `default`, `requires[]`, `conflicts[]`), `contract { file, version }`, `provenance { sourceProject, sourceCommit, approvedBy, date }`.
- `stack.json`: `stack` (an id from `src/stack-profiles.ts`), `files[]` (`from`, `to` with tokens, optional `option`, `role`: source | test | config | doc), `tokens[]` (for example `package`, `appName`), `dependencies[]` (coordinates and versions), `configKeys[]` (names and descriptions only, never values), `adaptationPoints[]` (`id`, `kind`: theme | naming | routes | copy | wiring, `files`, `instruction`), `verify[]` (quality commands, limited to the executables the stack profile allows), `covers[]` (requirement ids the tests prove, reusing the "Covers:" traceability the Unity gate already checks).

### 4. The lock file and the CLI

`.library/lock.json` in the project: library repository and commit, and per feature: version, stack, chosen options, token values, and for each copied file its library path and the SHA-256 it had when installed. Paths use forward slashes; the library keeps LF so hashes are stable on Windows and Linux.

CLI (`npm run lib -- <command>`), **a small TypeScript tool in the orchestration repository** (shared zod schemas, Git helpers and allowed-executable rules with the worker, tested with vitest), working against a library checkout configured by `ORCHESTRATOR_LIBRARY_DIR` (the way `ORCHESTRATOR_TEMPLATES_DIR` works):

| Command | Behaviour |
|---|---|
| `list`, `show <feature>` | Catalog and details (options, stacks, contract, adaptation points). |
| `add <feature> --stack S --option a,b --token package=...` | Validate options against `requires` and `conflicts`; refuse if a target file exists; copy; write the lock; print the adaptation points. No scripts are run. |
| `status` | Installed features, files modified locally (current hash differs from the installed hash), newer versions available. |
| `diff <feature>` | Three-way preview of an update. |
| `update <feature> [--to v]` | Unmodified files are replaced. Modified files are merged with `git merge-file` using the base (the library file at the locked version, read from the library's Git history), the project's file, and the new library file. New files are added, removed files are reported but not deleted. Conflicts stay as markers and the command exits non-zero; the lock only advances when there are none (or with `--accept-conflicts`). |
| `outdated` | Features whose library version is newer than the locked one. |

**Why not Copier:** it needs a Python runtime on the worker and in CI; it renders through Jinja, which collides with the curly-brace syntax of JSX, Angular templates, Java and C# strings; its updates use repository-wide tags while this library versions per feature; and the rendering it provides is mostly not needed, because the AI adapt task does the renaming and restyling. What it does well (three-way update from a recorded base) is what `git merge-file` plus the lock provides. If real conditional templating is needed later, adopting Copier for a feature family stays possible; the `feature.json` layout does not prevent it. The CLI estimate is a few hundred lines (an estimate, not measured).

### 5. How the orchestration uses it (later phases, no workflow change decided here)

1. **Catalog in the blueprint.** The blueprint stage receives a compact catalog (id, summary, stacks, options) the way it receives scaffold templates today (`src/bootstrap.ts`), and may mark a task with `feature: { id, stack, options }`. An unknown id or invalid option set is dropped with a warning and the task runs as a normal task (same validation and deterministic fallback pattern as other structured stages; new stages go into `test/chaos.test.ts`).
2. **Install is deterministic and runs in the worker**, before the agent starts. Where it runs must not change the workflow command sequence if it can be avoided (data on an existing activity, as ADR 0011 did); if a new activity is unavoidable it needs `patched()` and a regenerated replay fixture.
3. **The adapt task** is a normal task through the normal gates and review. Its prompt carries the feature spec and adaptation points, the project contract (ADR 0011), and the UI/UX direction (ADR 0010; features must use theme tokens, which the Unity template already requires). The spec comes from the library, so no OpenSpec proposal is generated. Acceptance is the feature's own tests, its contract tests and the hygiene gates. Lane: small (see the speed plan, B-058).
4. **The contract channel names installed features** (from the lock file) and tells the agent to change them only through the adaptation points; wholesale rewrites of library files are a review finding. Library text is untrusted data in prompts like all repository content.
5. **Harvest** (a new task type, human-approved): after a project completes, a read-only pass proposes candidates from the **per-feature task diffs** (the orchestrator already makes one task and one PR per feature, which gives the boundary the paper's AST-based guessing lacks). A generalise task parameterises tokens, removes project names, adds missing tests and writes the manifests, in a worktree of the library repository. It is proved by installing into a clean scratch project from the scaffold template and passing the verify commands. The result is a draft PR to the library repository; **a human merges it** (promotion). Status `proven` requires a second successful reuse.
6. **Doctor** checks the library path, schema validity and catalog freshness.

### 6. Safety and quality rules

- Harvested code is model output until a human approves it: it must pass the security preset (Semgrep and secret scan, B-060) and contain no secrets; only configuration key names are stored.
- Authentication features wrap established providers and libraries instead of implementing cryptography; which provider is a separate decision, deferred.
- `update` never runs without the lock file, never deletes files, and never overwrites a locally modified file without a merge.
- Every feature carries its tests; a feature without passing verify commands cannot reach `curated`.

### 7. Decisions for the first projects (2026-10-26)

The next project is a Unity mobile game with a Spring Boot (Java) server; React is a later stack. Decided with the owner:

- **One server per game, built as a modular monolith.** Each server feature is a [Spring Modulith](https://docs.spring.io/spring-modulith/reference/runtime.html) application module: one top-level package per feature, only its top-level types public, a `modules.verify()` test that fails the build on forbidden dependencies or cycles, and (Modulith 2.0 and later) a Flyway history per module. The module-scoped Flyway behaviour was read from the documentation and is **not yet tried here**; the version and property names are confirmed in the spike (B-074). A library server feature is one module folder, installed with the `lib` copy-in. Extension points keep modules pluggable without runtime plugin loading: an `IdentityProvider` interface (guest first; email and SSO later are new implementations), a per-game score validator for the leaderboard (the anti-cheat hook), and a remote-config source. Because boundaries are verified, modules can later be lifted into a shared service if several games need one.
- **Guest-first accounts** (device sign-in), upgradable to email or SSO later. Which standard provider SSO wraps stays deferred.
- **Offline-first client with ports and adapters.** The game talks to small interfaces (account, cloud save, leaderboard) with a local implementation first and an HTTP implementation later, so a game ships without a server and gains server features by switching an adapter. The Tile Merge 2048 save store is already the local implementation of the save port.
- **Feature folders from the first task.** Client features live in their own folder with their own assembly and tests and depend only on shared interfaces; server features are one package each. This is enforced as a project-contract rule (ADR 0011) from the first task, so harvesting later is a copy, and the per-feature task diffs stay clean boundaries.
- **First game features** and where they live:

| Feature | Home | Notes |
|---|---|---|
| App shell, settings, loading, pause, menus, safe area | Unity `app-shell` | Harvested by hand from Tile Merge 2048 first (about half of its script lines are game-independent; a rough count, not a line-by-line review). |
| Versioned local save | Unity `local-save` | `FileSaveStore` and `Persistence` from 2048. |
| Haptics, sound cues, animation helpers, particle presets | Unity `feedback` and `juice` | Always honour reduced motion. |
| World map and stages | Unity `world-map` | Data-driven from a stages file. |
| Stars per completion, unlocks, rewards, rising difficulty | Unity `progression` (pure logic) | The difficulty curve is data and can be served by remote config so it can be tuned without an app update. |
| Automatic or semi-automatic level generation | Unity `level-pipeline` | Seed in, parameters from the curve, a validator that proves solvability, an editor tool that bakes accepted levels to files. Tested with generated levels. Built inside the first game and generalised after a second use. |
| Guest account, cloud save with a revision number, stage leaderboards, remote config and a minimum-version gate | Spring Boot modules | Cloud-save conflicts: highest revision wins, stats merged by max or sum. |

### 8. Two linked projects, contract owned by the server repository

The game and the server are two projects and two repositories (the orchestrator has one stack profile per project). The server repository owns the OpenAPI contract; the game is a consumer. Today the orchestration has no notion of linked projects: `ProjectManifestSchema` has no such field, `checkDependencies` only verifies that a blocker issue is `done`, and stacked branches assume the same repository. The design:

1. A `links` entry in each manifest (provider or consumer, plus the contract file path on each side).
2. The consumer receives the contract through the library; the lock file pins the server commit, so drift is detectable by `lib status`.
3. When a server task changes the contract file, the orchestrator creates a follow-up issue in the consumer project (update the client, re-sync the copy).
4. Server pull requests run a breaking-change check with [oasdiff](https://github.com/tufin/oasdiff/blob/v1.10.16/BREAKING-CHANGES.md) against the base (flag names verified at build time); the client carries small contract tests, because a spec diff alone does not catch every drift.
5. A cross-project dependency means "wait until the blocker is done", with no branch stacking; the contract is pinned by commit. Whether Paperclip and the bridge handle blockers across projects is **not verified** and is the first spike of B-075.
6. The Unity client for the contract: OpenAPI Generator has no built-in Unity target ([discussion](https://lightrun.com/answers/openapitools-openapi-generator-c-codegen-for-unity)). The options are a commercial generator, NSwag, or generated data classes with a thin hand-written `UnityWebRequest` client. The last is the recommendation; it needs a short IL2CPP spike (B-076).

### 9. Milestone library check (optional per project, low token cost)

Starting the game does not wait for the library tooling: every task already produces its own branch and pull request, so features can be analysed afterwards from those diffs, and the detector is first validated on the 20 Tile Merge 2048 pull requests.

- **Layer 1: deterministic, no model.** After each task is published, group the changed files by feature folder and compute signals per feature: size, tests present, cross-feature references, project-specific words (the game's name, for example). Write a short "library candidates" line into the task result so it appears in the Paperclip comment. These are heuristics; their noise is measured on the 2048 pull requests and tuned.
- **Layer 2: one bounded model call per milestone, only when there is something to judge.** A planned task of the existing read-only research kind (ADR 0008: scope, bounded context, report, draft pull request, issue comment). Input is the compact candidate list, not the code; the stage can be routed to an inexpensive model through the manifest. With an empty candidate list it finishes in seconds with "no candidates" and spends no tokens. Output per candidate: promote, needs generalising (and what to strip), or skip. A candidate seen once goes on a watch list; promotion needs a second use (rule of two).
- **Promotion stays human-approved** and is the harvest of section 5, not part of this check.
- **Project creation.** One catalog option, `library_check` (off, at milestones, at the end), in `src/bootstrap-options.ts`; the wizard reads the catalog from the bridge, so no UI is hard-coded. Defaults follow maturity: off for throwaway and prototype, at the end for MVP, at milestones for production. When on, the plan builder adds one "Library check" task at the end of each milestone (or one at the end), blocked by that milestone's tasks, and it appears in the plan the owner approves. Creating the task automatically when a milestone completes was rejected: it adds logic to the Paperclip reconcile loop, where control-plane coupling has already caused failures (FM-053, FM-054).
- The token cost of the milestone report is not known yet; the first real run measures it with `npm run timing`.

### 10. Order: game first

1. Add the feature-folder and ports-and-adapters rules to the Unity project rules, and the package-per-module rule to the Spring Boot template notes (B-072).
2. Start the first game; early milestones are client-only (shell and save, world map and progression, level pipeline and effects); server milestones come once the server project exists (B-078).
3. In parallel: prototype the Layer 1 detector on the Tile Merge 2048 pull requests and hand-harvest its shell into the library repository (B-073, B-077).
4. Spring Boot profile, modular scaffold template, guest account and cloud-save modules, the contract and the oasdiff check (B-074).
5. Linked projects and the contract follow-up (B-075), and the Unity client spike (B-076).
6. The `library_check` option and the milestone task in project creation (B-077), then the `lib` CLI (B-068) and the harvest (B-071).

## Pilot plan (not started; to be run after B-057 and B-059 so repair noise and gate time are lower)

Question: does installing and adapting a curated feature beat generating it, on time, cost and defects, without hurting quality?

1. **Source.** Build one feature (candidate: authentication with email and password, remember me, forgot password) in project P1 through the normal pipeline on Spring Boot and React. Hand-curate it into the library as v1 with a contract and tests. This is the first harvest, done by hand.
2. **Arms.** Two new projects with different visual styles, the same feature set: **A** generated from scratch by the normal pipeline; **B** installed from the library and adapted. Run each arm twice if the cost allows (model output varies).
3. **Measure** with `npm run timing` and the review artifacts: model minutes, wall clock, cost (the `costUsd` field), repair rounds, gate failures, blocking review findings, security scan results, and a human check that the style was adapted correctly.
4. **Update test.** Release v1.1 with a new option (SSO or code verification), run `update` into project B, and record conflicts and resolution time.
5. **Go criteria** (proposed): arm B needs at most half of arm A's model minutes and cost, no more blocking findings, feature and contract tests green at the first gate, a faithful restyle, and an update with conflicts a person can resolve in minutes. **Stop criteria:** adaptation takes more than 75% of the from-scratch time, or defects increase; then keep the library as templates only and do not build harvest automation.
6. **Unity arm** runs separately after the gate speed work, because Unity builds are slow and would confound the comparison.

Update 2026-10-26: with a Unity game and a Spring Boot server as the first projects, a better first pilot candidate is the guest account or cloud-save as a Spring Boot module with a Unity client, or the Tile Merge 2048 app shell installed into the new game. Authentication on Spring Boot and React stays as the alternative.

Limits of the pilot: two or four runs are evidence, not proof; model variance, learning between arms and cache warmth (Gradle, Unity Library) are confounders and are recorded with the results.

## Alternatives considered

| Option | Why not (now) |
|---|---|
| Versioned packages (npm, Maven, UPM) | The user wants source that adapts to each project's style; packages can't be restyled and force one version everywhere. May still be right for pure utilities. |
| Copier | See section 4. Kept as an escape hatch. |
| shadcn-style registry server | Good item shape (borrowed in `stack.json`); React-only and needs a server. |
| Bit | Package and cloud oriented, JavaScript only. |
| Backstage templates | Platform for teams, far more than needed. |
| Automatic LLM extraction first | The survey shows naive extraction has low recall and breaks migrations. Curated first, guided harvest later, human approval throughout. |

## Consequences

- A new repository and a new CLI to maintain; copies diverge from the library over time, which is why the lock file and `update` are part of the first version, not an extra.
- The library only pays off from the second reuse; the pilot decides whether the investment continues.
- Stack coverage multiplies maintenance (feature times stack); start with Spring Boot, React and Unity.
- Depends on stack profiles for Spring Boot and React (B-060) before those stacks can have verified features.
- Linked projects need an orchestration change (manifest `links`, a follow-up issue on contract changes, a cross-project blocker rule); until then the contract is kept in sync by hand.
- The milestone check adds a task per milestone to plans when the option is on, and a new task kind; the new kind goes into the task-type registry and the chaos table like any structured flow.
- No change to the current workflow, replay fixture or deployed services by this ADR.

## Open items

- First features are now set for the first game (section 7); a dashboard, CRM and ranking features follow in later projects.
- Authentication provider approach for email and SSO (deferred by the owner; guest-first for now).
- Whether projects with linked repositories need a combined end-to-end check (server running, client test against it); optional and expensive, so not in the first version.
- Whether promotion approval later becomes semi-automatic (first version: always a human).
- Library repository name and location; licensing and ownership note for harvested code.
- How reuse is recorded for the `proven` status (entry in `feature.json` on promotion, proposed).
- Contract test tooling per stack (OpenAPI validation for Spring Boot, generated client types for React, an equivalent for Unity) is chosen when the first feature is built.
