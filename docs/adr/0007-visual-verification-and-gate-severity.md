# ADR 0007: Visual verification of UI work and warn/fail severity for quality gates

## Status

Accepted and implemented 2026-10-23 (B-038). Extends ADR 0006; supersedes nothing. Live evidence: a real capture of dino-runner and a Codex read of the screenshot; a full Paperclip run with the gate is still to be observed.

## Context

Every gate in the pipeline is textual: types, unit tests, build, and a model reading a diff. Two real runs (LOC-38, LOC-39) passed all gates first time, yet the pixel-art dinosaur still needed polish, because nothing ever looked at the rendered result. Separately, hygiene tools (unused code, duplication) cannot be adopted as quality commands today: a command either fails the run or does not exist, so a noisy first report would block work.

UI/UX *guidance* (frontend-design, ui-ux-pro-max, composition patterns) is already injected into the plan, implement and review prompts by `src/uiux.ts`. It is not part of this change.

## Decision

1. **Gate severity.** A quality command gets `severity: "fail" | "warn"` (default `fail`, so every existing manifest behaves as before). A failing `warn` command is recorded in `metadata.warnings` and the final message, and does not stop the run. This makes knip and jscpd adoptable per project without blocking.
2. **Visual verification inside the review activity.** Optional manifest block `visual`: a start command (node/npm/pnpm/yarn only, like quality commands), the URL to open, viewports, and declarative `steps` (`press`, `wait`, `click`, `shot`). After deterministic checks pass, the review activity starts the app in the worktree, captures PNG screenshots with `playwright-core` driving an already installed Chromium (no browser download), stops the app, and attaches the images to the review prompt together with a rubric derived from the execution brief. Codex receives them with `--image`; for providers without image input the screenshot paths are listed and the capture is recorded as skipped.
3. **Runs inside an existing activity, not a new workflow step**, so the command sequence is unchanged: no `patched()` marker and no replay-fixture regeneration are needed.
4. **Capture problems warn, they do not fail.** A missing browser, a server that does not start, or a timeout produces a warning and the review continues on text alone. A reviewer verdict of `needs_changes` about the visuals is a normal blocking finding through the existing review gate. Projects may opt in to `visual.required: true` to fail closed.
5. **Safety.** The start command runs through the same `childEnv()` sanitised environment; the page is localhost only; screenshots are stored under the run artifacts and are never committed; model output about images is treated as untrusted data like all review output.

## New dependency

`playwright-core` (Apache-2.0), runtime dependency of the worker. Reason: scripted, deterministic screenshots of a locally served page; no alternative in the standard library. Browser binaries are not downloaded; a Chromium already present is used (`ORCHESTRATOR_BROWSER_PATH` overrides discovery).

## Testing plan

- Unit: severity schema default and behaviour (warn collects, fail stops); step parsing and rejection of bad steps; image discovery and prompt attachment; every failure path of the capture degrades to a warning.
- Chaos table: capture timeout, server never ready, browser missing, zero screenshots.
- Integration (manual, evidence recorded): capture against the dino-runner dev server on the host, screenshots viewed.
- Acceptance: re-run a comparable UI task (pixel-tree obstacles) end to end through Paperclip and compare against LOC-39.

## Consequences

- UI regressions that compile and pass tests can now be caught or at least seen.
- A little more review latency and cost for projects that enable `visual`; default off.
- Model-judged visuals are advisory evidence, not a replacement for human review of the PR.
