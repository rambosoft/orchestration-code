# ADR 0016: A usage limit or a lost connection pauses a stage instead of failing the task

Status: Accepted (2026-10-30). Part of the v2 plan, section 3.5 (docs/engineering/research/orchestration-v2-redesign.md).

## Context
The operator runs on Claude Pro and the free Codex tier. Both stop at a usage limit (Claude per five-hour window, Codex per longer window), and a laptop can lose its connection mid-run. Until now such a failure was an ordinary activity error: two attempts one to fifteen seconds apart, then a failed run, and at most one automatic resume within six hours. A limit that resets in two hours therefore cost a person a manual resume.

## Decision
1. **Detect** (`src/provider-gate.ts`, in the activity): a provider failure is a *pause* when it is a usage limit (wordings of the Claude and Codex CLIs, HTTP 429, credit exhausted; the reset time is read when the message gives one) or a lost connection (DNS, reset, refused, stream disconnected, and a provider timeout while a connectivity probe fails). Authentication problems never pause. The CLI provider surfaces Codex error events and Claude `is_error` results as errors, because both report limits with exit code 0.
2. **Signal**: the activity throws a non-retryable `ApplicationFailure` of type `ProviderPause` with `{ kind, waitMs?, reason }`. It does not use up activity retry attempts.
3. **Wait** (`src/workflows.ts`, `src/pause-policy.ts`): the workflow sleeps on a Temporal timer (the provider's own wait plus one minute, otherwise 15/30/60 minutes for a quota and 1..30 minutes for the network), asks the `probeConnectivity` activity until the network answers, and runs the same stage again. The total wait per stage is capped at 24 hours (the workflow is bounded at 48); past the cap the run fails with `provider quota pause exceeded` (classified `external`, a person decides) or `provider network pause exceeded` (classified `transient`, resumed automatically).
4. **Visible**: the `progress` query returns `paused: { kind, stage, waitMs, count, reason }` while a stage waits, and the worker log gets an `activity.paused` event.
5. **Stall watchdog**: a streaming CLI (Codex) with no output for 15 minutes (45 for stages that run builds, `ORCHESTRATOR_STALL_MINUTES`, 0 = off) is killed; the activity retry starts it again.
6. **Replay safety**: the wait path is behind `patched("provider-pause")`; runs recorded earlier keep treating the failure as an ordinary error.

## Consequences
- A quota or an outage costs wall-clock time, not a run. Stage results already saved are reused, so nothing before the paused stage repeats.
- Detection is pattern based. The tests hold real wordings; a new wording is one pattern plus one test line.
- Not done here (next in the v2 plan): continuing the same CLI session after a pause instead of a cold start, and falling back to another provider after a configured wait (routing chains).
