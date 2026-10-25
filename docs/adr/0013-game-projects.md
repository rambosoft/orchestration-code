# ADR 0013: Game projects (game design stage and Unity scaffold)

## Status

Accepted and implemented (2026-10-24). Verified with `test/game.test.ts`, the chaos table, and a real scaffold of a Unity project on the worker host (EditMode proof, hygiene, commit), followed by PlayMode capture and an Android AAB on the generated project. A live game through Paperclip is recorded separately (B-055).

## Context

The bootstrap flow planned applications from a stack decision, a charter and a blueprint. A game needs its rules, boundaries and edge cases pinned before any task exists (the 2048 family alone differs across implementations on merge order, spawn odds and win/lose precedence), a visual bar that is about screens, feedback and touch rather than CSS, an engine scaffold, and gates that run the engine.

## Decision

1. **Options.** `product_kind` (app|game), `engine` (auto|unity), `game_orientation`, `game_art`, `game_fps` in the catalog. A game resolves to a mobile platform (a web default moves to Android, derived and reported), the Unity engine, a frontend-only shape, at least unit tests, and keeps visual verification on (it is the Unity capture, not Playwright).
2. **Stack without a model.** A Unity game gets `unityStackDecision()` and the `unity-mobile-2d` template; the model is not asked to choose an engine the option already decided.
3. **A `design` stage after the charter, only for games.** `GameDesign` (`src/game.ts`): numbered rules (R-001..) with exact values and edge cases, controls, scoring, progression, win and loss, screens, feel, audio, accessibility, assets, persistence, performance budget, a test-case table, risks and open questions. It goes through `structuredStage` (validate, one repair with diagnostics, deterministic fallback that uses the requester's own sentences and says so), is in the chaos table, appears in the approval summary and in the Bootstrap tab, and is committed as `docs/GAME_DESIGN.md` and `docs/RULES_SPEC.md`. The blueprint prompt receives its digest and the game milestone order (foundation, core logic, playable slice, UX shell, polish, performance and release); every task names the rule ids it covers and the last task runs the strict traceability check.
4. **Scaffold with the real Editor.** `scaffoldProjectImpl` creates the project with `Unity.exe -createProject` (so GUIDs and `.meta` files are genuine), copies `templates/unity-mobile-2d` (assemblies, EditMode and PlayMode tests, the capture harness, the Android build method, hygiene script, ignore and attributes files), adds the test framework to the manifest, runs one import pass, proves EditMode tests and hygiene, and only then commits. A failure before the repository exists removes the folder.
5. **The manifest** uses the `unity-mobile` stack, gates by maturity (hygiene, EditMode, PlayMode, and an Android build: none for prototype, warning for MVP, failing for production), the Unity visual capture, and longer provider timeouts.
6. **Game rules in the contract channel** (ADR 0011): engine-free logic assembly, scenes and prefabs only through editor scripts, run the Unity gates, no per-frame allocation, review checks (rule coverage, allocations, safe area and touch targets, screenshots of every screen, performance budget). They reach the plan, implement and review prompts without new workflow steps.
7. **Game visual bar** replaces the web bar for games (theme as data, no Unity default look, safe area and 48dp targets, feedback within 100 ms, legibility without colour alone, frame budget) and scales with maturity.

## Consequences

- Workflow impact: a new `design` command exists only in the bootstrap branch for games; application runs keep their command sequence and the replay fixture is unchanged. `StageName` gains `design`.
- A game project needs a Unity 6 Editor with the Android module and an activated licence on the worker; `doctor` says so.
- iOS builds are not covered (they need macOS). Art and audio are procedural or free-licence by default; generated assets need keys and are not wired.
- The quality of scenes and UI authored by a model is the weakest link; the capture screenshots and the review rubric are the mitigation, and a generator/evaluator polish loop remains an option.
