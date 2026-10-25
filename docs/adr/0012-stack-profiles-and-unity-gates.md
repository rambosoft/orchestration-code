# ADR 0012: Stack profiles and Unity gates

## Status

Accepted and implemented (2026-10-24). Verified with unit tests (`test/stack-profiles.test.ts`, `test/unity.test.ts`, `test/unity-hygiene.test.ts`, `test/dependencies.test.ts`) and a real Unity 6000.3.11f1 run on the worker host (`docs/engineering/research/unity-game-support.md`, section 5c, and the scaffold results in STATUS.md).

## Context

Quality gates, dependency preparation and the screenshot review assumed Node: quality commands were limited to `node|npm|pnpm|yarn`, dependency preparation only ran `npm ci`, and visual evidence meant a dev server and Playwright. A Unity project needs the Unity CLI, an Editor import pass, and a capture that works without a browser. A spike on the worker host showed what is true in practice: `unity test` and `unity build` give machine-readable verdicts (exit 8 tests failed, 6 no verdict), PlayMode runs render with a real GPU in batch mode but `WaitForEndOfFrame` never fires, Android builds fail on long project paths, and test assemblies that are not constrained with `UNITY_INCLUDE_TESTS` break the player build.

## Decision

1. **A stack profile is data.** `src/stack-profiles.ts` defines `node-web` (default) and `unity-mobile`. The manifest has an optional `stack: { profile, unity: { editorVersion, executeMethods } }`. Without it nothing changes.
2. **Executables follow the profile.** `unity` is accepted by the quality command schema but the manifest check (`stackCommandProblems`) allows it only for `unity-mobile`, and only as `unity test|build|recompile` with the CLI's own flags: no `--`, no `--args`, `--editor-path`, `--allow-install`, `--accelerator` or `--proxy`, paths stay inside the repository, and `--execute-method` only for a method declared in `stack.unity.executeMethods`. A model-chosen reproduction command (bug flow) may not use `unity`.
3. **Dependency preparation detects the worktree.** A folder with `Assets/` and `ProjectSettings/ProjectVersion.txt` gets one `unity run` import pass (timeout at most 840 s) before the npm step, so the workflow input and the replay fixture do not change.
4. **The Unity CLI's exit code is not a verdict.** In the verify activity (`src/unity.ts`) every Unity command gets a default timeout and `--non-interactive`; a stale report or build output is removed before the run; a green `unity test` needs a NUnit report with tests and no failures; a build with a declared output needs that output; a red run gets a hint that says what the exit code means.
5. **Visual evidence has an engine.** `visual.engine: "unity"` (with `unityFilter`) runs the project's PlayMode capture test and copies `Logs/screenshots/*.png` to the reviewer, exactly like web screenshots. Problems are warnings unless `required`.
6. **Unity hygiene is a committed script** (`templates/unity-mobile-2d/scripts/check-unity-hygiene.mjs`): `.meta` files present, generated folders ignored, force-text serialization, the test framework declared, test assemblies constrained, logic assemblies free of the engine, no `Resources.Load` or per-frame allocation in game code, and rule traceability (`--strict-rules` makes it a failure; the last task runs it).
7. **Worktrees can live in a short folder** (`ORCHESTRATOR_WORKTREES_DIR`, default `<data>/worktrees`) because Android builds fail on long paths.
8. **Claude in a Unity project** may run the Unity CLI (`unity` added to its allowed tools) and loads Unity's official agent plugin with `--plugin-dir` from `UNITY_AGENT_PLUGIN_DIR`, a checkout pinned by `npm run unity:plugin`. The plugin is never copied into generated repositories (Unity Companion License).

## Consequences

- No workflow change; the replay fixture is unchanged.
- Existing Node projects behave as before; `QualityCommand.executable` widens to include `unity` in types.
- The Unity CLI is beta (1.0.0-beta.13): it is called through `src/unity.ts`, and raw `Unity.exe -batchmode` stays a fallback.
- Cold imports and Android builds are slow (minutes); gates run per task, so Unity projects are slower than Node ones. Concurrency of Unity runs on one host is not measured.
- `npm run doctor` reports `unity:cli`, `unity:licence`, `unity:editor`, `unity:android` and `unity:plugin` for projects with the profile. A missing licence fails every Editor run with "No valid Unity Editor license found".
