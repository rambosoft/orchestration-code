# ADR 0017: Gates that a model cannot satisfy are healed by the orchestrator; stack packs onboard existing repositories

Status: Accepted (2026-10-30). Part of the v2 plan, sections 3.6 and 3.7 (docs/engineering/research/orchestration-v2-redesign.md). Complements ADR 0012.

## Context
- The last live Unity task failed three times on missing `.meta` files. Only the Unity Editor can write them (a model must not invent GUIDs), so the gate repair pass, which hands the failure to a model, could never succeed. It cost model calls and ended the run.
- A gate that reports one line per rule (16 `rule-trace` warnings) handed the agent sixteen near-identical lines on every attempt.
- Only Node and Unity projects could be registered. Spring Boot, Angular and React repositories had no way in: the quality-command allow-list knew `node`, `npm`, `pnpm`, `yarn` and `unity`, and manifests for existing repositories were written by hand.

## Decision
1. **Heal before repair** (`src/activities.ts`, verify): when a check fails with `meta-missing:` in a Unity worktree, the activity runs one batch import through the Unity CLI (the same call dependency preparation uses) and repeats the check, before any result reaches the workflow. A failed import (licence, lock) keeps the original failure and adds a warning. At most one heal per verify call. No workflow change, so no `patched()`.
2. **Fold similar lines** (`src/log-compact.ts`): three or more consecutive lines that differ only by an item id (`R-001`..`R-016`, `T3-AC2`) become the first line plus `[+N similar, up to <last id>]`. A line that does not repeat in shape is never folded, so a failing test id stays visible.
3. **Stack profiles** `react-ts`, `angular` and `spring-boot` join `node-web` and `unity-mobile`. Allowed tools per profile: the web profiles use the package managers; `spring-boot` adds the system `mvn` and `gradle` (a wrapper script is a path, which a quality command may not be). The manifest schema accepts `mvn` and `gradle` as executables; a profile that does not list them rejects the command.
4. **Stack packs** (`src/stack-packs.ts`): per profile, how a repository is recognised (marker files and dependencies, with a priority so a Spring server beats its web client), and which quality gates it gets, derived from the repository itself: its `package.json` scripts (watch modes made one-shot: `ng test`, `vitest`, `jest`, `react-scripts`), the lock file's package manager, Maven or Gradle with the JUnit report path so failures reach the agent as a list of failing tests, the Unity gates and editor version. The test depth follows the tier.
5. **`npm run onboard -- <repo folder> --name <name> --tier <tier> [--write]`** builds a validated manifest for an existing repository: routing from the bootstrap defaults (Claude implements, Codex does the other stages), the chosen tier, the pack's gates, the stack profile. It refuses a repository no pack recognises or one with no derivable gate, with the reason. `--write` puts it in `projects/` (never overwriting).

## Consequences
- An existing Spring Boot, Angular, React, Node or Unity repository becomes a project in one command, at the tier the operator chooses, and its tasks use the lane stage lists of ADR 0015.
- A new stack is one entry in `PACKS`, one profile id and one fixture in `test/stack-packs.test.ts`.
- Not built: Spring Boot and Angular scaffold templates for new projects (the bootstrap still scaffolds Vite+React and Unity), a doctor check for `mvn`/`gradle`/JDK on the worker, wrapper-script support, and gating of several stacks in one repository (only the root is gated; the others are reported as a note).
- The Unity heal is covered by reading the code path and the fold by tests; it has not run against a real Editor.
