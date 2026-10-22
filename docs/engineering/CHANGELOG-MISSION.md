# Mission changelog

One line per completed item: id, commit, evidence.

- baseline 99c5f00 (main): existing code committed; 70 tests / typecheck green (knowledge/metrics/baseline.json).
- B-001 4694e32: child env scrubbed (test/env.test.ts, 74 tests green).
- B-003: bridge hardening: timing-safe token, 1MB body cap, test flags gated (test/http-guard.test.ts, 79 tests green).
