# Extending and resuming

**Resume the mission:** read `STATUS.md`, then the first `todo` row of `BACKLOG.md` (tier, then score). After each item update BACKLOG, `knowledge/failure-modes.yaml`, `CHANGELOG-MISSION.md`, STATUS. Commit `type(scope): summary [B-NNN]`; push only `mission/hardening`.

**Add a workflow profile (shape):** add an entry to `src/profiles.ts` (stages, approval, gates); allow its id in `src/server.ts` profile check; add a manifest `qualityCommandsByProfile` entry. Workflow command-sequence changes must use `patched()` and a regenerated replay fixture (`UPDATE_REPLAY_FIXTURE=1 npx vitest run test/replay.test.ts`).

**Add a quality gate:** deterministic gates are manifest `qualityCommands` (executables limited to node/npm/pnpm/yarn in `src/contracts.ts`; widen that enum deliberately). They run in `executeStage` (`stage === "verify"`) with a scrubbed environment (`src/env.ts`).

**Add a publish check:** extend `SENSITIVE_PATH` / `SECRET_CONTENT` in `src/publish-guard.ts` and add a case to `test/publish-guard.test.ts`.

**Add a provider / agent role:** implement `AgentProvider` in `src/providers.ts`, register in `getProvider`, extend `ProviderIdSchema`; CLI providers must pass credentials via the `PROVIDER_CREDENTIALS` keep-list only. Non-retryable errors: throw `ApplicationFailure.nonRetryable` (see `src/activities.ts`).

**Add a config option:** zod schema in `src/contracts.ts`, document in `knowledge/config-schema.md`.

**Where things live:** metrics `knowledge/metrics/`, failure modes `knowledge/failure-modes.yaml`, decisions `research/decisions.md`. No eval harness exists yet (B-020). Simplicity policy text: `src/simplicity.ts`.

**Optional stage example (analysis):** see `docs/adr/0005-optional-analysis-stage.md`. A new optional stage needs: a name in `StageNameSchema`, a route key in `providerRouting`, a pure module with schema, prompt, validate and render functions (`src/analysis.ts` is the template), a `patched("<stage-name>")` guarded block in `projectWorkflow`, a Fake provider answer for tests, a workflow test proving where its output flows, and budgets with invariants in `HANDOFF_BUDGETS`.

**Task types (ADR 0008):** a type is an entry in `src/task-types.ts` (aliases for labels and `Type:` lines, a delivery profile, a flow). A new type that only changes prompts or gates can reuse the `delivery` flow with an investigation pre-phase like `bug` in `projectWorkflow`; a read-only document type reuses `investigation`. New stages follow the optional-stage recipe above plus: add them to the defect matrix in `test/typed-flows.test.ts`, give the Fake provider an answer and `[INJECT_*]` markers, and keep the typed branch selected by `input.taskType` (workflow input), so untyped runs keep their command sequence and the replay fixture stays valid. Model-chosen commands that the worker runs must pass a guard like `reproductionCommandProblem`.

**Project bootstrap (ADR 0009):** an option is one entry in `OPTION_CATALOG` (`src/bootstrap-options.ts`) plus, if a maturity should set it, a line in `PRESETS`; the wizard picks it up from the bridge catalog with no plugin change, and a test checks that every preset value is valid for its option. A scaffold template is one entry in `src/bootstrap-templates.ts` (package names without versions, config files, the checks the project is gated on, an optional `visual` block); the stack stage is told which templates exist. A new model stage follows the three existing ones (schema with tolerant fields, prompt, repair prompt, deterministic fallback, a route in `bootstrap.global.json`) and must be added to the bootstrap table in `test/chaos.test.ts`. The Paperclip plugin lives in `plugins/project-bootstrap/` (`npm run plugin:build`, `npm --prefix plugins/project-bootstrap test`); keep `@paperclipai/plugin-sdk` pinned to the version of the Paperclip checkout in `.runtime/paperclip` and rebuild after a Paperclip upgrade.
