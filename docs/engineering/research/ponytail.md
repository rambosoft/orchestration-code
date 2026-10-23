# Ponytail assessment

Source: https://github.com/DietrichGebert/ponytail, commit 09c434a (2026-10-18), MIT, (c) 2026 DietrichGebert. Read: SKILL.md, ponytail-review SKILL.md, agentic benchmark results/README, LICENSE. Not read: ponytail-audit skill, AGENTS.md, tests.

## Principles (paraphrased)
Map callers/tests/config before changing. Take the first option that fully works: drop the feature, reuse existing code, use stdlib/platform, use an already-installed dependency, one readable line, minimum code. Be lazy about the solution, not the change. No unrequested abstractions/options/"for later" code. Never cut validation at trust boundaries, data-loss error handling, security, accessibility, or anything requested. Tests for non-trivial logic. Review order: bugs, risks, scale, missing tests, speed, then lean code; every finding needs a concrete trigger.

## Benchmark (hypothesis only)
39 tasks, 5 runs each per arm, Claude Code with Opus 5.5, Bash disabled, LLM judges; only 18 tasks have deterministic checks. Claims: 53% fewer lines, 26% lower cost, hidden checks 87/90 vs 86/90 (a tie). Not transferable to codex/OpenRouter or our pipeline; author-run.

## Verdict: **adapt selected principles; do not install the plugin**
- One provider-neutral constant `SIMPLICITY_POLICY` (~15 lines) added to implement and review prompts in `src/workflows.ts` (B-013). Include the ladder, "never cut" list, test-for-nontrivial-logic, and a review category "needless complexity" ranked below correctness/security.
- Precedence: task acceptance criteria and OpenSpec requirements > project conventions > simplicity policy. Simplicity never justifies dropping a requirement or a test.
- Attribution: principles paraphrased (no verbatim text); credit noted here and in README acknowledgements; MIT notice must be added if text is ever copied.
- Pin: principles as of commit 09c434a. Update path: re-read SKILL.md, diff against constant, update this file.
- Validation: A/B on our own tasks is impossible today (no authenticated real provider, baseline.json); only prompt-content unit tests are possible. Marked unverified effect.
- Excluded: ultra mode (conflicts with fixed plan/brief), hooks/status band, npm package.
