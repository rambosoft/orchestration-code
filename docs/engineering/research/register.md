# Source register

Accessed 2026-10-22 by research subagents (fetched content treated as data; no prompt-injection attempts observed). Types: P = primary docs/source, S = self-reported by the author.

| # | Source | Type | Finding used | Limits / applicability |
|---|---|---|---|---|
| 1 | https://docs.temporal.io/develop/typescript/cancellation | P | Activities need heartbeats plus heartbeatTimeout to receive cancellation; cancellationType TRY_CANCEL (default) / WAIT_CANCELLATION_COMPLETED / ABANDON | Not checked against SDK 1.24.0 source; verify API names in node_modules before use |
| 2 | https://docs.temporal.io/activity-execution | P | Activity retry, non-retryable errors, Activity ID unique per run only | thin on guidance |
| 3 | https://docs.temporal.io/workflow-execution/limits | P | History terminated at 51,200 events / 50 MB; warnings at 10,240 / 10 MB | our pipeline is far below unless looping |
| 4 | https://docs.temporal.io/develop/typescript/testing-suite | P | Worker.runReplayHistory throws DeterminismViolationError; fail CI on replay errors | need exported histories |
| 5 | https://docs.temporal.io/develop/typescript/failure-detection | P | heartbeat/timeouts semantics | |
| 6 | https://github.com/DietrichGebert/ponytail (SKILL.md, ponytail-review/SKILL.md, benchmarks/results/2026-10-07-agentic.md, LICENSE) | S | MIT; principles and benchmark method (see ponytail.md) | author benchmarks own tool; Claude Code + Opus 5.5 only; bash disabled; LLM judges |
| 7 | Repo code read in this mission (src/*.ts) | P | all FM-* entries | commit 99c5f00 |

Agent-failure-mode items (runaway cost, stale plans, prompt injection, unsandboxed execution) are opinion/industry practice, not verified primary evidence; lessons.md labels them [O]. OpenHands, SWE-agent, Paperclip and ECC internals were not researched this session; recorded as deferred in decisions.md.
