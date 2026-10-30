# ADR 0021: The adapter writes a line every 20 seconds so Paperclip keeps the run's lease

Status: Accepted (2026-10-30). Found in the first live run of the v2 plan (Minesweeper, task LOC-116). Extends ADR 0018.

## Context
- The Paperclip adapter holds one Paperclip run for the whole Temporal workflow. Paperclip renews that run's controller lease only while the adapter produces output. Measured on the heartbeat runs: the lease ends about a minute after the last output line.
- A Unity task spends minutes in the `dependencies` stage (copying and importing the project) with no stage change, so the adapter wrote nothing for longer than the lease. Paperclip cancelled the run ("controller lease lost"), the adapter left the workflow running (correct), and the issue went on an execution-reconciliation hold: Paperclip then refuses every later wake for it ("Automatic recovery stopped"). The workflow finished and published a PR, the project stood still for an hour, and getting it moving again needed a manual attestation (`recover-tasks.md` section 8).

## Decision
- While the workflow is RUNNING and the adapter has written nothing for `keepaliveMs` (config, default 20 000, 0 = off), it logs `Temporal run still in progress: stage <name> (<n> min)`. A stage change counts as output too.

## Consequences
- A run of two hours writes about 360 short lines to the Paperclip run log.
- The lease no longer depends on how fast the stages change; a long silent step (Unity import, a 45 minute implement) cannot strand the task.
- Not solved here: a Paperclip server outage longer than the lease still ends the run and leaves a hold (the reconcile step and the worker-side report of ADR 0018 are the answer to that).
- Test: `test/adapter-resilience.test.ts` (a silent stage produces repeated lines).
