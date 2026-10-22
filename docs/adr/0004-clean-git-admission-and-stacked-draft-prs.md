# ADR 0004: Clean Git admission and stacked draft PRs

## Status

Accepted

## Context

Paperclip tasks previously ran in worktrees created from committed `HEAD`. That omitted untracked project source, reviews could inspect an incomplete tree, and the adapter could report Done after saving a patch without publishing it. The Paperclip and bridge processes run in Docker while provider CLIs and Git worktrees run on the Windows host.

## Decision

- Require a clean Git checkout, GitHub remote, configured target branch, and configured source-presence paths before starting a code workflow. Never stage or commit changes in the project checkout.
- Resolve and record one base commit SHA. Use a Docker mount for bridge admission and the matching host path for Windows activities.
- Create one task branch/worktree from that SHA and keep every workflow stage on it.
- Gate publication on comprehensive review, any focused Codex repair review, and deterministic quality commands.
- Commit and push only the task worktree, then create or confirm a draft PR. Mark the Paperclip issue Done only after PR publication metadata is confirmed. Never merge automatically.
- Stack one dependent branch on its predecessor's published commit. For multiple blockers, require one configured integration branch containing each prerequisite commit. Stop for human resolution when a base moves or rebase conflicts.
- Keep duplicate active dispatches on one Temporal workflow identity; use a distinct attempt identity for explicit retries after terminal failure or cancellation.

## Consequences

Project owners must commit a clean baseline, configure `repository` and `containerRoot`, and bind-mount the project into both relevant containers. The worker needs `gh` authentication and a host Paperclip API token to recheck dependencies. A failed publish leaves the branch and evidence for recovery but does not mark the issue Done. Stacked PRs are merged bottom-up; a child must be rebased and retargeted after its parent merges.
