# ADR 0023: An auto-approved project releases every milestone

Status: Accepted (2026-10-30). Found in the first live run of the v2 plan (Minesweeper). Extends ADR 0009 and ADR 0018.

## Context
- The wizard option `autostart` defaults to `first_milestone`: only the first milestone's tasks leave the backlog when the plan is approved. The later milestones wait for a person to move them to ready.
- Minesweeper ran its first milestone (four tasks) to the end and then stopped with nothing running and 17 tasks in the backlog. A project approved with `approval: auto` has no person to release the next milestone, so it stalled at every milestone boundary.
- Every task already waits on its predecessor through a first-class blocker (milestone check tasks included, ADR 0018), so releasing all tasks changes no order.

## Decision
- `resolveOptions` derives `autostart: all` when `approval` is `auto` and a repository is created, unless the user chose `autostart` themselves. `approval: required` keeps `first_milestone`; no repository keeps `none`.

## Consequences
- An auto-approved project runs from the first task to the last without a hand. A person who wants a gate per milestone sets `autostart` explicitly.
- Tasks in the backlog show as ready or blocked in Paperclip from the start; the blockers, not the status, order the work.
- Test: `test/bootstrap.test.ts`.
