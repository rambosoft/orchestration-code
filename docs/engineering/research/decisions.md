# Decision matrix

| ID | Topic | Decision | Evidence | Validation |
|---|---|---|---|---|
| D-01 | Keep Temporal + Paperclip + OpenSpec stack | adopt (keep) | ADRs 0001-0004; no demonstrated benefit of replacing | n/a |
| D-02 | Heartbeats + cancel child process | adopt | source #1; FM-003 | B-004 test |
| D-03 | Non-retryable error classes | adopt | source #2; FM-004 | B-005 test |
| D-04 | Replay test in CI | adopt | source #4; FM-013 | B-011 |
| D-05 | Ponytail | adapt principles only | ponytail.md | prompt unit test; effect unverified |
| D-06 | Scoped env for child processes | adopt | FM-001, industry practice (opinion) | B-001 test |
| D-07 | Container/VM sandbox for untrusted code | defer | large (L); host worker needs provider auth locally (ADR 0003). Upgrade trigger: first multi-tenant or untrusted-repo use | |
| D-08 | Replace OpenSpec / add new spec tool | reject | no evidence of problem | |
| D-09 | Migrate to OpenHands / SWE-agent runtime | reject | not researched; migration risk high; no demonstrated benefit | |
| D-10 | Model routing, prompt caching, cost accounting | defer | needs real provider usage data (none available) | trigger: first authenticated real run |
| D-11 | Per-profile toolchains (python/go/...) | defer | L effort; one verified stack today. Trigger: second real project type needed | B-021 |
| D-12 | Eval harness with golden tasks | defer | needs real providers to be meaningful; fake provider gives only pipeline tests | B-020 |
| D-13 | Reference projects built through orchestrator | defer | cannot run real providers; fake-provider "projects" would be fabricated evidence | B-020 |
| D-14 | Refactor projectWorkflow monolith | defer | risk without replay tests; do after B-011 | |

D-15: workflow edits that change command sequence use patched(); see B-006 (approval-timeout). Pattern for future workflow changes.
