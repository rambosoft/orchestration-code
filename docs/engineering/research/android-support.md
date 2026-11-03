# Android support: research, analysis and plan (2026-11-01)

Goal: the orchestration builds MVP and production-grade Android apps unattended, learns from every failed run, and converges on reliable output. Decisions taken with the operator: native **Kotlin + Jetpack Compose first**, Flutter as a later pack, Google's "Modern Android Development" architecture, tier-based gates (MVP: build + unit + lint; production adds detekt, ktlint, coverage, dependency scan), ADR + research note in the repo, tooling may be installed on the worker, workflow changes allowed (but avoided where data on existing steps is enough).

## 1. What exists today (verified in the repo)

- Stack profiles are data (`src/stack-profiles.ts`): `node-web`, `unity-mobile`, `react-ts`, `angular`, `spring-boot`. A new stack = profile id + pack (`src/stack-packs.ts`) + executables + template.
- Quality commands are limited to `node|npm|pnpm|yarn` plus per-profile `unity|mvn|gradle`. **A Gradle wrapper (`./gradlew`) is a path and cannot be a quality command.** First blocker: AGP 9.5 needs Gradle 9.6, so a system `gradle` cannot stand in for the project's pinned wrapper.
- Scaffold templates (`src/bootstrap-templates.ts`) cover Vite+React and Unity. `bootstrap-options.ts` offers `mobile_android` and `mobile_cross` but no Android template, so those fall back to "the first task initialises the project", the least reliable path.
- Unity is the model for everything Android needs: a verdict parser that does not trust exit codes (`src/unity.ts`), a hygiene script gate, heal-before-repair, a short worktree root (`ORCHESTRATOR_WORKTREES_DIR`) and doctor checks.
- `log-compact` and `stack-traits` already know JVM frames and Gradle output folders.
- Host: JDK 21 (Temurin), an Android SDK folder with AVDs (`Medium_Phone`); no `adb`/`sdkmanager`/`gradle`/`flutter` on PATH, no `ANDROID_HOME`.

## 2. Findings from research (versions move monthly: verify at scaffold time)

- **Android CLI + Android Skills (Google, preview April 2026).** `android create` (official templates, e.g. `compose-empty`), `android sdk install`, `android emulator`, `android run`, `android docs`, `android skills add`. The `android/skills` repo (Apache 2.0) ships agent skills: `jetpack-compose`, `navigation`, `testing-setup`, `performance`, `security`, `play`, `agp-9-upgrade`, `r8-analyzer`, `camerax`, `identity`, `device-ai`, `wear`, `xr`, `media3`; installable as a Claude Code or Codex plugin. Windows installs were reported flaky, so the CLI is optional and the skills checkout is pinned (the Unity plugin pattern, ADR 0012 item 8).
- **Toolchain.** AGP 9.5.0 is stable (Oct 2026): Gradle 9.6, JDK 17+, build-tools 36.0.0, compileSdk up to 37. Compose 1.12 requires compileSdk 37 and AGP 9. The Compose compiler is a Kotlin plugin (`org.jetbrains.kotlin.plugin.compose`) versioned with Kotlin; the Compose BOM is the single place to pick Compose versions. AGP 9 has built-in Kotlin, which changes the plugin block. **The template must be build-verified at scaffold time**, not trusted from memory.
- **Architecture (official guidance, Now in Android):** layered (UI, optional domain, data), single source of truth, unidirectional data flow, ViewModel + `StateFlow`, `collectAsStateWithLifecycle`, Hilt, Room, DataStore, type-safe Navigation, offline-first repositories, test doubles instead of mocks, convention plugins in `build-logic`, Roborazzi screenshot tests, baseline profiles for release.
- **Gates that work in CI:** pre-merge = compile, affected unit tests, Android Lint, ktlint, detekt; start detekt at error-level rules and tighten; lint `abortOnError`; compilation, signing and core test failures block, style warnings start as trend data; separate gates, aggregated verdict.
- **Screenshots:** Roborazzi runs Robolectric on the JVM, so Compose screenshots need **no emulator** (fast, headless, Windows-friendly). It is the better default evidence for the review stage; the emulator becomes a milestone-only gate (`connectedDebugAndroidTest`).
- **Flutter (follow-up):** feature-first MVVM, Riverpod 3, `go_router`, `very_good_analysis`, pyramid of unit, widget and `integration_test`. Needs the Flutter SDK on the worker; iOS gates cannot run on Windows.

## 3. Predicted failure modes of unattended Android runs

| Risk | Mechanism | Counter |
|---|---|---|
| Wrapper not runnable as a gate | schema rejects paths | new `gradlew` executable resolved to the worktree wrapper, profile-gated, flag allow-list |
| Cold Gradle daemon, 3-10 min first build | gate timeouts, wasted repairs | dependency-prepare pass, shared Gradle user home, `--console=plain`, per-gate timeouts, build cache |
| Long Windows paths | AGP/ninja failures | existing short worktree root |
| Hallucinated versions / APIs | stale coordinates | version catalog only (hygiene rule), unresolvable dependency is a gate, skills pack points to official docs |
| Architecture drift, duplicated UI | each task invents components | project contract rules + reuse index in prompts + hygiene script |
| Giant tasks | one task = a whole feature | vertical-slice breakdown rules (section 5) |
| Lint noise | hundreds of warnings hide the defect | baselines, `severity: warn` below production, similar-line folding (exists) |
| Missing SDK pieces | `Failed to install platform` mid-run | doctor checks + setup script, licences accepted once |
| Flaky emulator | boot timeouts | Roborazzi first, emulator milestone-only |

## 4. What to add (ranked)

P0, no workflow change (data on existing steps, replay fixture unchanged):
1. **Profile `android-kotlin`** and executable `gradlew` (wrapper resolved from the worktree; flags allow-list: no `--init-script`, `-I`, `--project-dir`/`-p` outside the repo, `--include-build` outside).
2. **Gradle verdict parser** (`src/android.ts`): JUnit XML, lint and detekt reports; green requires reports with tests and no failures; stale reports removed; exit-code hints. Mirrors `src/unity.ts`.
3. **Android pack** for `onboard` (detect `settings.gradle(.kts)` + `com.android.application`), tier gates: MVP `testDebugUnitTest`, `lintDebug`, `assembleDebug`; production adds `detekt`, `ktlintCheck`, Kover coverage threshold, dependency scan, `assembleRelease` (R8), `verifyRoborazziDebug`.
4. **Template `android-compose`**: version catalog, single `app` module, package-by-feature, Hilt, Room, Navigation, Roborazzi, detekt, ktlint, Kover wired, a sample feature with ViewModel test and screenshot test; proven by a real `assembleDebug` + tests.
5. **Rule pack in `projectContract`** (ADR 0011): the architecture rules as short, checkable statements (section 5).
6. **Android hygiene script** (`scripts/check-android-hygiene.mjs`) as a gate: version-catalog-only dependencies, no hardcoded user strings, no `GlobalScope`/`runBlocking` in app code, no `!!`, ViewModels free of `android.*`/`Context`, one immutable UI-state class per screen, `collectAsStateWithLifecycle`, a test file for every ViewModel/use case/repository, preview + screenshot test per screen, no duplicate composable names, shared UI only in `core/designsystem`, features do not import each other.
7. **Doctor checks**: JDK >= 17, `ANDROID_HOME`, platform and build-tools, licences, AVD, cmdline-tools, short Gradle user home.
8. **Skills**: pinned `android/skills` plugin dir for Claude, and the installed ECC skills that fit (`android-clean-architecture`, `kotlin-patterns`, `kotlin-coroutines-flows`, `kotlin-testing`, kotlin reviewer agent) named in stage prompts.

P1 (activity logic, replay-safe):
9. **Visual engine `android`**: run the Roborazzi record task, copy PNGs to the reviewer (same path as web/Unity).
10. **Reuse index**: before plan/implement, extract a compact index (feature folders, public composables with signatures, repositories, use cases, design tokens) into the prompt. Deterministic, token-bounded.
11. **Learning loop**: Gradle failure classes (dependency resolution, Kotlin compile, KSP, Hilt missing binding, Room schema, lint ids) in `failure-modes.yaml` and the fallbacks table; each real run appends to `docs/engineering/research/android-run-learnings.md`.

P2 (needs `patched()` + replay fixture): dedicated **architecture review** stage for production tier; **app-level plan check** validating the feature breakdown (slice dependencies, shared components planned once). Start both as prompt data; promote only if runs show it is not enough.

P3: Flutter pack (`flutter` executable, `flutter analyze/test`, `very_good_analysis`), KMP shared module, Play delivery (signing via secrets, never in the repo), baseline profiles, macrobenchmarks.

## 5. Feature breakdown and reuse

1. **Slice rule.** One task = one observable vertical slice: `screen + state + ViewModel + use case/repository + tests`. Never "all data layer" or "all UI". Infrastructure (theme, navigation shell, DI, database) comes first, once.
2. **Task contract per slice** (optional, tolerant plan fields): user story, screens and routes, UI state fields, events, data sources, error/empty/loading states, accessibility, testable acceptance criteria, and `reuses:` naming components from the index.
3. **Definition of done = gates**, not the model's claim: tests for the new ViewModel/repository, screenshot test, clean hygiene, lint/detekt clean for the tier.
4. **Reuse enforcement.** Reuse index in plan and implement prompts; hygiene flags duplicate component names; shared UI lives in `core/designsystem`; cross-feature logic goes through a `core` interface.
5. **Simplest code.** Reviewer-checkable constraints: no abstraction without two uses, no use case that only forwards a repository call (MVP), no module per feature before six features, no custom DI or navigation framework, official libraries first.
6. **Library allow-list.** Default stack: Compose BOM, Material 3, Navigation, Hilt, Room, DataStore, Retrofit or Ktor + kotlinx.serialization, Coil, WorkManager, Timber, Turbine, fakes (MockK only if needed), Roborazzi, Kover. Anything else needs a recorded reason; the hygiene script checks `libs.versions.toml` against a project-extendable allow-list.

## 6. Work plan for this session

1. ADR 0037 + backlog B-149..B-158 (renumbered 2026-11-02: ADR 0031 and B-106..B-115 were taken by other work).
2. `gradlew` executable, `android-kotlin` profile, command allow-list, tests.
3. `src/android.ts` verdict parser wired into verify, tests with stub reports.
4. Pack + onboard support, doctor checks, `scripts/android-setup.ps1`.
5. Template `templates/android-compose` + hygiene script + bootstrap entry (`ecosystem: "android"`), rule pack.
6. Build the template for real on this host (SDK packages listed before install); fix what breaks.
7. Roborazzi visual engine; reuse index.
8. `npm run typecheck`, `npx vitest run`, `npm run check:chars`; replay fixture only if the workflow changed.
9. E2E app: waits for the operator's app idea.

## 7. Open items / risks

- Template version pins are validated only by building here; they age. A scheduled template-build check is the cheap guard.
- Android CLI is a preview, reported flaky on Windows: optional, never a dependency of the gates.
- Emulator screenshots depend on hardware acceleration on this host; unverified.
- `gradlew` runs the worktree's wrapper script, which is model-influenced. Mitigation: the publish guard and hygiene script fail if `gradle/wrapper/*` differs from the template's checksums.

## Sources

- Android Skills and CLI: https://github.com/android/skills , https://lilting.ch/en/articles/android-cli-v0-7-agent-preview
- AGP release notes: https://developer.android.com/build/releases/gradle-plugin
- Compose compiler plugin: https://developer.android.com/develop/ui/compose/compiler
- Now in Android: https://github.com/android/nowinandroid
- CI quality gates: https://xckevin.github.io/en/blog/android-ci-cd-quality-gates/ , https://xckevin.github.io/en/blog/android-ci-cd-ktlint-detekt-firebase-pipeline/
- Flutter 2026 practices (secondary): https://dev.to/hamberluo/modern-flutter-best-practices-for-2026-56o3
