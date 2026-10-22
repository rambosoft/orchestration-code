# Implementation plan and progress

## Goal

Validate a local-first Paperclip + Temporal workflow platform with a small TypeScript orchestration service, pluggable providers, repeatable demo tasks, and honest runtime evidence.

## Environment and constraints

- Windows 11 x64; workspace is empty at `C:\workspace\test-orch`, nested inside a parent Git checkout with unrelated uncommitted changes.
- Docker Desktop 28.5.1 was installed but stopped. Node.js 22.22.2, npm 10.9.7 and pnpm 10.34.5 are available.
- Paperclip source is cloned under `.runtime/paperclip` at the commit recorded in `docs/architecture.md`.
- Codex CLI config had `service_tier = "default"`, which this installed CLI rejected. Before correcting it to `fast`, a backup was created at `%USERPROFILE%\.codex\config.toml.codex-temporal-backup`. Codex reported a ChatGPT login during discovery, but provider execution was not verified. Final `claude auth status` reported `loggedIn: false`, so no real provider run was attempted. Gemini CLI was absent.

## Milestones

1. Build typed orchestration contracts, workflow profiles, provider adapters, plugin checks, CLI, worker and bridge.
2. Add the Paperclip external adapter and local Compose stack with persistent, isolated data.
3. Add demo fixtures and automated tests for policy, profile, recovery, approval and failure behavior.
4. Start the documented stack, execute scenarios, inspect evidence, and record every outcome in `docs/validation-results.md`.

## Completion evidence

- TypeScript build, typecheck, 24 unit tests, and the deterministic Temporal scenario suite pass.
- The pinned Paperclip image builds through Compose with the private-eval-corpus limitation documented; a post-rebuild Paperclip issue completed through Temporal and was marked done with stage summaries and artifact references.
- Fake-provider orchestration scenarios are validated. Provider-authored code changes, real provider runs, force-restart recovery testing, and a standalone formatter/linter remain unverified; see the scenario matrix in `docs/validation-results.md`.

## Safety decisions

- Keep all tracked changes and disposable runtime data under this directory.
- Keep credentials out of source, run inputs and logs; CLIs run on the Windows worker.
- Provider writes are limited to isolated worktrees; do not execute model-generated commands outside provider sandbox controls.
- Do not claim a scenario passed unless it ran and its result was observed.

## Real Git project safety addendum (2026-10-21)

The Calculator failure analysis showed that task worktrees created from committed `HEAD` omitted its untracked HTML/CSS/app source, while the adapter could still mark the issue Done after only saving a patch. The bridge now fails code-task admission for dirty trees (including untracked files), missing GitHub configuration, or missing required source files. It records a fetched base SHA. Because Paperclip and the bridge run in Docker while the provider worker runs on Windows, each project declares both `containerRoot` for bridge Git admission and a host root environment variable for worker activities; Compose mounts both paths to the same checkout.

One Temporal workflow owns one named task branch/worktree across plan, implementation, repair, review, and deterministic checks. Blocked Paperclip issues do not dispatch. The worker rechecks blocker statuses before branch creation. A single prerequisite stacks from its exact published commit; several prerequisites require a configured integrated branch containing every prerequisite SHA. Review repairs use Codex and focused follow-up review. Deterministic command results and output are saved as evidence and are required to pass.

Only after review and deterministic checks pass does the workflow commit and push the task branch and create or confirm a GitHub draft PR with authenticated `gh`. The Paperclip task becomes Done only after publication metadata is present. Done means gates passed and the draft PR exists; it does not mean merged. A `sync-stack` command rebases and retargets a child after its parent merges, and stops on conflicts. Explicit retries use a distinct attempt identity; duplicate active dispatches attach to the existing Temporal workflow.

This addendum was validated with 24 unit tests, including a real push to a disposable local bare remote and mocked GitHub CLI calls. Compose rebuilt the bridge with Git, its health endpoint listed both project manifests, and a direct Calculator bridge preflight returned HTTP 400 due to tracked and untracked changes before Temporal start. No Calculator files were changed. A real GitHub PR and Paperclip-to-Temporal code-task publish remain unverified: the Calculator checkout is still dirty and has no remote; see `docs/validation-results.md`.
