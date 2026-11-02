# Assessment: google/elephant-goldfish-model (EGM) for the orchestration (2026-11-02)

Source: the repository's file tree and the text of its `egm-drift-report`, `egm-bootstrap` and `egm-review` skills, read through a summarising fetch tool (not verbatim, not the whole repository). Not read: `AI_POLICY.md`, the agent prompts, the document-standard files, the other skills. License Apache-2.0; the repository states it is not an officially supported Google product. Anything adopted must be re-read verbatim and reviewed first (ADR 0033, decision 5).

## What it is
A plugin for Claude Code, Codex and Antigravity that adds a design-then-review workflow. An "elephant" agent with full context drafts a design; "goldfish" reviewers, spawned as subagents with no conversation history, challenge it; a human approves before implementation. Seven skills: brainstorm, draft, review, review-loop, resolve, bootstrap, drift-report. Safety signals from the file tree: no hooks, no executable files, scripts only for packaging and the project's website.

## What each relevant skill does
| Skill | What it does | Cost and constraints |
|---|---|---|
| drift-report | For each design or README in a directory: finds the source files it describes, reads them, lists differences (missing features, missing fields, hardcoded values where logic was planned, different patterns or libraries, code not covered by any document) and appends them to a dated report file. Edits no documents or code | No subagents; one pass per document. Interactive prompts (asks for the directory and for missing links); reads files liberally (secrets not addressed); repeated runs append duplicates |
| bootstrap | Writes a contract file per source directory (Interface, Invariants, Side Effects) and a parent index that rolls up the children; discovers the toolchain; stops and asks above 15 directories; spawns parallel workers above 5; merges existing README content; offers a drift review at the end | Reads every source file; unbounded parallel workers once approved; rewrites READMEs unless a different `target_filename` is set; needs user answers |
| review | Five stages over a design document (zoom out, comprehension test, critics for design, structure and style, an intermediate zoom out, implementation readiness with a codebase-details check) with fresh-context subagents and one re-audit per stage | About 9 reviewer runs, up to about 13 with synthesizer and loop runs, each re-reading the document; needs a host that can spawn subagents (the protocol stops without one); interactive checkpoints |

## Verdict for this orchestration
- **Not for orchestrated runs.** Plugins are switched off in every Claude run (tokens), Codex cannot use them, the skills are interactive, and a five-stage review per task is far too heavy for hundreds of small tasks. The repository itself says it is for features that need design decisions.
- **Useful at design time, by a person or a milestone task.** Our highest-risk areas (native bridge, storage and cache, input and focus, carousel, player, Xtream fetch) are designed once and implemented many times; a fresh-context review of that design before the strongest model implements it is where better design decisions and fewer rewrites come from.
- **Ideas worth taking, without the plugin:**
  1. *Design gate for critical areas*: an `architecture` task (it exists, ADR 0008) produces the design; fresh-context reviewers on a different model (Codex) check comprehension, structure and implementation readiness; the approved design becomes protected constraints for the implement tasks.
  2. *Component contracts*: Interface, Invariants and Side Effects per module as the format of the per-module README in the AI map (ADR 0034 decision 8, B-112); small, checkable, and what a later agent needs to change a module safely.
  3. *Drift reports to a human*: the drift method fits B-123; the check that a page document still matches the code is a report for review, never an automatic rewrite, which agrees with ADR 0034.
  4. *Comprehension test*: a reviewer with no context paraphrases a section; if the paraphrase is wrong, the section is unclear. A cheap test for page documents.
  5. *Fresh context is the point*: our reviews already see only the diff, the rules and the gate results; the design gate extends that to designs.

## How code quality improves (the operator's goal)
Quality comes from layers that do not depend on one model remembering: design first for critical areas (above); standards and patterns as reviewed data in the prompt and in the repository (ADR 0033, 0034); gates for everything a tool can check (strict types, hooks and accessibility lint, duplication, dead code, boundaries, tests, budgets); the strongest model on critical implementation (ADR 0035); focused fresh-context review where the risk is; and recorded lessons so the next task starts better. Skills are one layer; the gates and the design gate are what make "complete and future-proof" checkable.

## Unverified, to settle before adopting anything
Whether `claude -p` runs and Codex runs can spawn the fresh subagents these reviews need; the content of the agent prompts and document standards; the AI policy of the repository; whether the per-directory contract format suits a React/TypeScript tree better than a hand-written module README.

## Proposed backlog
B-159 design gate for critical areas (architecture task, fresh-context review on another model, approved design carried as protected constraints); B-160 evaluate the EGM drift-report and bootstrap skills as pinned catalog sources (read verbatim, import digests, ADR 0033); B-161 component contract format (Interface, Invariants, Side Effects) for the AI map.
