# ADR 0038: Facts-first code intelligence for agents

Status: Proposed (2026-11-02). Design only: no code yet. Extends ADR 0035 (decision 10, deterministic extraction before model reading) and ADR 0033 (reviewed, pinned third-party content).

## Context
- The operator asked whether a set of open-source code-intelligence tools would cut token use and raise quality: Graphify (repository knowledge graph), Serena (language-server navigation over MCP), dependency-cruiser, Knip, Context7 (version-matched library documentation), ts-morph, ast-grep, Aider's repo-map idea, CodeQL, SCIP, and third-party mapping skills.
- Already in place: Knip is a gate in the react-ts-vite pack (R-008); the survey builds a deterministic inventory before the model reads the code (`src/survey-inventory.ts`); Codex does read-only analysis; operator plugins and MCP servers are switched off in orchestrated runs because their tool definitions cost thousands of tokens on every turn.
- The new app uses very recent releases (Vite 8, React 19.3, TypeScript 6/7, Vitest 5, ESLint 9/10), newer than most models' training data, so wrong-API mistakes are a real quality risk.
- The proposal's own best idea matches ours: tools produce facts, models interpret them, and every finding carries a path, a line range and the commit, so the orchestrator can verify it before a model sees it. Several claims in the proposal (versions, dates, Vue support) are unverified.

## Decision
1. **Facts first.** Before a model stage, the orchestrator may run deterministic tools in an activity and inject a short, bounded result into the prompt (the pattern of `buildSurveyContext`). It works the same for Codex and Claude, costs tokens only once, and needs no MCP server in the run. MCP-based tools are for interactive sessions, not unattended runs, until measurement shows otherwise (`npm run usage`).
2. **Provenance on every fact.** A fact records source tool and version, file, start and end line, relationship, confidence (`verified` or `inferred`) and the commit it was computed on. Before use, the activity re-checks that the path exists and the range still matches the working tree; a stale fact is dropped, not trusted.
3. **A preparation package per task** (affected files, affected symbols, dependency impact, existing tests, missing tests, library documentation references), written under `.ai/preparation/<task>/` by a deterministic activity, bounded in size, with the model's interpretation (risks, plan) kept in separate files. This extends the reuse index (B-137) and the Vue extraction (B-138).
4. **Adoption order, by value over cost.**
   - *Now, as pack gates and scripts:* dependency-cruiser (no cycles; only `src/input` and `src/storage` own keys and storage; components do not import pages; also gives reverse dependencies for affected-test selection). Knip stays. ts-morph and ast-grep are libraries for our own scripts and codemods, not agents.
   - *Spike on Codex, read-only, decide from numbers:* Graphify on the old clone and the new repository, compared with our inventory; kept only if it adds facts we lack (call graph, communities) at a manageable size and handles `.vue` files. Pin the version; its `install --project` writes into the repository, so run it in a copy.
   - *Add with a cache:* Context7 as a pre-fetch of version-matched excerpts for the libraries a task names, stored in the repository (`docs/ai/libs/`) as reviewed, pinned content (ADR 0033). It sends library names and a question to an external service, never code; that is recorded as accepted.
   - *Defer:* Serena (try interactively once the repository has real size, check Vue support first), CodeQL (security-specific, for the Spring and Xtream credential flows later), SCIP, and third-party mapping skills (our maps are generated; any skill goes through the catalog import).
5. **Aider's repo-map idea, not Aider.** Rank symbols by the dependency graph and fit them to a token budget; implemented in our own reuse index.

## Consequences
- Fewer repeated repository explorations and fewer stale-API errors, at the price of a few deterministic activities and a cache to maintain.
- No new always-on dependency for runs; every tool is pinned and optional.
- Measuring comes first: the token effect of each addition is compared with the baseline before it becomes default.
- Not covered: running Serena or Graphify as long-lived services, code search across several repositories, embeddings.

## Open points
- Whether Graphify and Serena support `.vue` single-file components (needed for the old app).
- How much of Context7's output is stable enough to cache and review.
