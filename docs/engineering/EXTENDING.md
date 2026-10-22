# Extending and resuming

**Resume the mission:** read `STATUS.md`, then the first `todo` row of `BACKLOG.md` (tier, then score). After each item update BACKLOG, `knowledge/failure-modes.yaml`, `CHANGELOG-MISSION.md`, STATUS. Commit `type(scope): summary [B-NNN]`; push only `mission/hardening`.

**Add a workflow profile (shape):** add an entry to `src/profiles.ts` (stages, approval, gates); allow its id in `src/server.ts` profile check; add a manifest `qualityCommandsByProfile` entry. Workflow command-sequence changes must use `patched()` and a regenerated replay fixture (`UPDATE_REPLAY_FIXTURE=1 npx vitest run test/replay.test.ts`).

**Add a quality gate:** deterministic gates are manifest `qualityCommands` (executables limited to node/npm/pnpm/yarn in `src/contracts.ts`; widen that enum deliberately). They run in `executeStage` (`stage === "verify"`) with a scrubbed environment (`src/env.ts`).

**Add a publish check:** extend `SENSITIVE_PATH` / `SECRET_CONTENT` in `src/publish-guard.ts` and add a case to `test/publish-guard.test.ts`.

**Add a provider / agent role:** implement `AgentProvider` in `src/providers.ts`, register in `getProvider`, extend `ProviderIdSchema`; CLI providers must pass credentials via the `PROVIDER_CREDENTIALS` keep-list only. Non-retryable errors: throw `ApplicationFailure.nonRetryable` (see `src/activities.ts`).

**Add a config option:** zod schema in `src/contracts.ts`, document in `knowledge/config-schema.md`.

**Where things live:** metrics `knowledge/metrics/`, failure modes `knowledge/failure-modes.yaml`, decisions `research/decisions.md`. No eval harness exists yet (B-020). Simplicity policy text: `src/simplicity.ts`.
