# Mission changelog

One line per completed item: id, commit, evidence.

- baseline 99c5f00 (main): existing code committed; 70 tests / typecheck green (knowledge/metrics/baseline.json).
- B-001 4694e32: child env scrubbed (test/env.test.ts, 74 tests green).
- B-003: bridge hardening: timing-safe token, 1MB body cap, test flags gated (test/http-guard.test.ts, 79 tests green).
- B-002: publish guard blocks credential paths, secret patterns, >5MB files, node_modules before commit/push (test/publish-guard.test.ts, 82 tests green). Caveat: regex heuristics can false-positive on fixtures; blocked runs need human review.
- B-009: untrusted-content notice in CLI and OpenRouter prompts (test/untrusted-notice.test.ts, 84 tests). Effect on model behaviour unverified.
- B-006: workflowExecutionTimeout (48h default, ORCHESTRATOR_WORKFLOW_TIMEOUT_MS) and 24h approval timeout via patched('approval-timeout') (test/timeouts.test.ts, 86 tests). Token/cost budgets remain B-016.
