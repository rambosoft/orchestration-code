# Architecture

## Ownership

- Paperclip owns user interaction, agent/task assignment, budgets and management history.
- The external Paperclip adapter forwards one assigned task to the local authenticated bridge and waits for its result. It does not directly execute agents.
- The bridge validates input and submits an idempotent Temporal workflow. Temporal owns stage ordering, retry policy, signals, cancellation and durable execution state.
- A Windows Temporal worker performs external activities and invokes local provider CLIs or calls OpenRouter directly. OpenRouter credentials are read only from the worker process environment; route/model IDs, never credentials, are in Temporal inputs.
- The orchestration core owns project manifests, profile selection, stage contracts, plugin requirements and quality-gate policy.
- UI/UX guidance is selected from an orchestrator-managed, attributed catalog using global defaults, project overrides, task intent and detected project frameworks. The selected summaries travel in stage prompts so CLI and API-routed providers receive the same portable context.
- Project Git repositories own code history. Artifacts and unmerged patches are stored beneath the local `data/` directory.

## Data flow

Paperclip task → blocker and issue validation → authenticated bridge (`/v1/runs`) → Temporal workflow (`pc-{taskId}-{revision}-a{attempt}`) → one task branch/worktree → OpenSpec proposal and validation (when enabled) → semantic OpenSpec optimization with coverage validation → planning → execution brief → implementation, review, and deterministic gates → OpenSpec archive → idempotent commit/push/draft PR → adapter logs and Paperclip status.

The stable workflow ID prevents duplicate Paperclip dispatch from creating a second active run. Revision is explicit and required from the current Paperclip issue; attempt defaults to `1`. A new revision or explicit attempt gets a distinct identity. Temporal activity retries are bounded; final errors are terminal. Human approval waits on a Temporal signal and can be sent via the authenticated bridge or CLI.

## Git admission and stacked work

Before starting Temporal for code work, the bridge verifies the configured Git repository, a clean status including untracked files, a GitHub remote, and a resolvable target branch. It records the resolved commit SHA. No changes in the original checkout are staged or committed. The first workflow Activity rechecks Paperclip blocker statuses on the Windows worker and creates one named branch/worktree from the recorded SHA. OpenSpec initialization, proposal, planning, implementation, repairs, review, archive, and quality commands all use that worktree. A source-presence gate prevents empty worktrees from being treated as successful.

One completed blocker must have a published result comment with its branch, commit SHA, and draft PR URL. The dependent branch starts at that exact SHA and targets the predecessor branch. Multiple blockers require `integratedBaseBranch` in the project manifest and the bridge verifies every prerequisite SHA is an ancestor of that branch. A moved parent branch or missing metadata stops admission. After a parent PR merges, `sync-stack` rebases the child to the target branch and retargets its draft PR; conflicts remain for a human to resolve. Stacked PRs should be merged bottom-up.

Review is bounded to two rounds total: one comprehensive pass and, only when blocking findings require repair, one focused verification pass. The repair path runs deterministic project checks before the focused review and supplies their results. Critical/high code-fixable findings block; low-severity polish is recorded as a non-blocking note, while environment/approval prerequisites stop for operator action without entering the repair loop. The final deterministic quality gate remains authoritative; a provider response cannot override a failed command. Run results include effective review limits, rounds, repairs, notes, unresolved findings, and stop reason. Only after these gates pass does the workflow make an idempotent commit, push the task branch, and create or confirm a GitHub draft PR. Paperclip is marked Done only after publication succeeds. Done means gates passed and the draft PR exists; it does not mean merged.

## Integration boundary evidence

Paperclip is checked out at the stable release tag `v2026.916.1` (commit `d554c4789ed3930f8a53ac9fdf6503b3187097da`). Its external adapter contract loads `createServerAdapter()` from a package root with `type`, `execute`, `testEnvironment`, `models`, and `agentConfigurationDoc`. Local adapter installation is supported by its adapter API. The implementation uses this extension boundary and does not alter Paperclip core. For each run, Paperclip's own adapter execution is the single entry point; the adapter awaits the Temporal result and does not separately invoke an agent.

The platform uses Paperclip's official Dockerfile and a local Compose definition with a persistent bind mount. `scripts/prepare-paperclip.ps1` checks out the exact release and prepares its source for Docker builds. One capability inventory generator requires Paperclip's separate private `paperclip-evals` corpus, so the build keeps the schema-checked inventory shipped with the pinned release and runs the other release generators; this constraint is documented rather than fetching or fabricating private test inputs. The Temporal development image is pinned to `temporalio/temporal:1.9.1`, its SQLite database is file-backed, and its UI/API ports are exposed only on `127.0.0.1`. This setup validates workflow replay/recovery locally; it is not a production Temporal deployment.

The adapter was exercised end-to-end on the running Paperclip release. LOC-8 completed before the rebuild; LOC-9 completed after the fresh image build, and Paperclip marked it done with stage summaries and artifact paths in a result comment. Paperclip uses embedded PostgreSQL in its persistent bind mount. After an interrupted container restart, its stale `postmaster.pid` marker was removed only after stopping the container; the database itself was retained and recovered.

## Failure and security model

- Workflow IDs are task-and-revision scoped; duplicate starts return the existing workflow identity.
- Activity retry attempts are bounded to two and have a four-minute timeout. Provider processes have a three-minute timeout, bounded output capture and are killed on timeout/cancellation.
- Code workflows require clean-tree admission and a configured GitHub remote. Stage artifacts preserve command output, and the task branch is published as a draft PR only after all gates pass.
- The project manifest routes plan, research, review and provider-assisted verify to MiniMax through OpenRouter, and implementation/repair to Codex. Deterministic quality commands execute locally. Provider credentials stay in the Windows worker environment.
  - OpenSpec is pinned to `@fission-ai/openspec` 1.14.3 and requires Node.js 20.19 or newer. `openSpec.enabled` defaults to `true`; a Paperclip task can override it with an `OpenSpec: on` or `OpenSpec: off` line. Fresh task worktrees install locked npm dependencies before proposal generation. Enabled implementation tasks run the Codex proposal stage and strict CLI validation before planning. A dedicated optimizer turns validated requirements, scenarios, constraints, and relevant decisions into a compact planning digest; schema and exact coverage validation reject missing or duplicated source items. The original validated artifact remains available for traceability and authoritative hard-constraint/acceptance checks. Implementation receives the execution brief, and review receives its checklist plus implementation summary and diff. The change is archived only after quality gates pass; archive or spec validation failure blocks publication.
- Required missing or unhealthy plugins fail the Activity; optional missing plugins do not turn into success claims.
- RTK is an optional project manifest capability. On enabled Codex implementation/repair stages, the worker requires both the host `rtk` CLI and the project's `.codex/hooks.json` registration before marking command-output filtering active. An optional missing setup uses normal Codex behavior and records the inactive reason in the stage artifact; a required setup fails with a diagnostic. RTK does not wrap the orchestrator's deterministic quality commands.
- External requests require a random bearer token. Environment variables and provider credentials are excluded from structured artifacts and output logs.
- Model output is treated as untrusted text. Commands are not separately executed by the orchestrator.

## Limitations to validate

Native Paperclip approval-to-Temporal signaling is not assumed; the authenticated bridge fallback is provided. Provider model and billing metadata are recorded only when the CLI emits a supported structured receipt. Workflow concurrency currently uses Temporal task-queue controls and project policy limits. The system never auto-merges, and rebase conflicts require a human. A Paperclip API token in the ignored host `.env` is required for worker-side dependency rechecks; it is not sent to Temporal.
