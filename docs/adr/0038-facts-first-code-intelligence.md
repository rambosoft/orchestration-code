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

## Addendum (2026-11-02): optional by design, the intelligence registry
The mechanism already exists: the manifest `plugins` array (`id`, `version`, `enabled`, `required`, `config`) and the capability registry in `src/plugins.ts`, used today by the RTK hook. Each code-intelligence or context tool is registered the same way and gets a **mode**:
- **off**: never runs.
- **advisory**: runs in an activity before the stage; its bounded, provenance-checked facts go into the prompt; any failure, timeout or stale fact is dropped and recorded as a warning, never failing the task.
- **gate**: its verdict can fail the task (dependency-cruiser, knip, jscpd, the pack checks).
Rules: a pinned version and a size budget per tool; a timeout; results cached by commit; a project's manifest overrides the pack's default; one environment switch (`ORCHESTRATOR_INTELLIGENCE=off`) turns every advisory tool off at once; a tool becomes default-on only after its token and time effect has been measured against the baseline (`npm run usage`, `timing`). Registering a new tool is a new entry and an adapter, not a change to the workflow. Tracked as B-167; proved together by the integration rehearsal B-168 (`docs/engineering/research/orchestration-readiness-plan.md`).


## Addendum (2026-11-03): built (B-163, B-167)
- Code: `src/intelligence.ts` (Fact with provenance, validation against the working tree, package, prompt block), `src/intelligence-registry.ts` (modes, kill switch, timeout, size budget, cache by working-tree fingerprint), `src/intelligence-adapters.ts` (ts-imports, affected-tests, pkg-deps, depcruise gate), `src/intelligence-stage.ts` (the glue in `executeStageInner`). Manifest block `intelligence` (`enabled`, `budgetChars`, `tools.<id>.mode|timeoutMs|sizeBudgetChars`).
- No workflow command changed: the block is added to the prompt inside the activity, and the manifest block rides as optional data on `RunInput` and `StageInput` (absent when unset, so in-flight runs and the replay fixture are unchanged; the replay test passes).
- Every tool is **off by default**. A project switches a tool on in its manifest; it becomes a default only after its token and time effect is measured against the baseline (`npm run usage`, `timing`). `luxus-app-react` runs the three advisory tools as the measurement canary (B-168). `ORCHESTRATOR_INTELLIGENCE=off` turns every advisory tool off at once; a gate stays.
- The package lives in `.ai/preparation/<task>/` (`package.json`, `summary.md`) and is kept out of git status through the repository's `info/exclude`, so it is never committed and never reaches `{changed}`.
- Limits, stated plainly: the import scan is line based (no tsconfig path aliases, no re-export chains, dynamic specifiers invisible); test association is by file name only (a test under another name reads as missing, marked inferred); `pkg-deps` is offline. Not built: any model stage, MCP servers, Context7 (B-165), ts-morph.
- Design drafted by Antigravity from a read-only pass over the repository, reviewed and changed by Claude: the design's `createdAt`-in-workflow idea was dropped (the activity stamps it), gate commands were deduplicated against the manifest, the cache key uses a working-tree fingerprint, and `.ai/preparation` is excluded through `info/exclude` instead of the publish guard alone.

## Addendum (2026-11-03): the library notes cache is built (B-165)
- **Cache and fetch are separate.** `dev libs-fetch <package...> [--root dir] [--force] [--version v]` (`src/lib-docs.ts`) fills `docs/ai/libs/<package>.md` from Context7 (`/api/v2/libs/search`, then `/api/v2/context` for the declared version, verified live on 2026-11-03). It refuses any name the project's `package.json` does not declare, skips a note already cached (no network), and sends only the library name, the version and one generic overview question; no code leaves the machine (the privacy decision above). `CONTEXT7_API_KEY` raises the rate limit; a 429, 404 or 5xx becomes a plain message.
- **Reviewed content only.** A fetched note starts `Status: unreviewed`. A person reads it and sets `Status: reviewed`. The `lib-docs` intelligence tool (off by default, on for `luxus-app-react`) then adds a pointer, with the note's one-line summary, to the preparation block for a declared library that the task's prompt names or its affected files import, and only when the note's major version equals the project's declared major (a stale note is left out). Stages read the cache and never the network.
- Not built: automatic refresh of notes on a dependency bump (the major-version check makes a stale note fall out of the prompt, and `libs-fetch --force` renews it); excerpts inside the prompt (the pointer keeps the block small, the model reads the file when it needs it).
