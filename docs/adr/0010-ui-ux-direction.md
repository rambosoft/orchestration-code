# ADR 0010: UI/UX direction for generated projects

## Status

Accepted and implemented (2026-10-23). Verified with unit tests (`test/design-direction.test.ts`); a live project built with it is not yet recorded.

## Context

The Aurora Store project built through the bootstrap flow worked but looked like the default styling of its component library. Three causes: the project charter carried at most a few free-form design rules; the UI/UX skill guidance was only attached to a task whose wording matched a UI keyword ("Add the cart" did not); and nothing tied the visual quality to the chosen maturity, so a prototype, an MVP and a production project were held to the same, low bar.

## Decision

- `src/design-direction.ts` defines a visual bar for every client-facing project: a base bar for all maturities (tokens, a deliberate type pair, hierarchy, loading/empty/error/success states, responsive from 360px, no stock library look) plus a tier. Prototype must still look designed end to end; MVP adds a reusable component set, micro-interactions that respect reduced motion, form validation, 404 and contrast AA; production adds a documented design system, WCAG 2.2 AA with evidence at four widths, optimised media, branded error pages and a screenshot review per page. The chosen visual direction and accessibility level add lines.
- The charter now also carries `design_system` and `page_directions` (one entry per page). Both are optional and tolerant, so a charter without them still validates; the deterministic fallback charter carries the bar.
- Every building task of a user-interface project gets a binding "UI/UX direction" block in its description (bar, project rules, page directions); the last task additionally reviews the whole product. Read-only task types and products without a UI get nothing.
- The generated repository gets `docs/DESIGN_DIRECTION.md`, referenced from `CLAUDE.md`, `AGENTS.md` and the README.
- The generated manifest lists the UI/UX skills in `uiUx.include`, so they apply to every task of the project regardless of wording.

## Consequences

- Workflow impact: `buildIssuePlan` gains an optional `charter` argument and the charter parse gains defaulted fields. No activity or command is added or reordered, so in-flight runs and the replay fixture are unaffected.
- Existing projects keep their manifests; add `"include": ["ui-ux-pro-max", "frontend-design"]` under `uiUx` and a `docs/DESIGN_DIRECTION.md` by hand to get the same effect.
- The bar is guidance for the agent and reviewer, not a gate: whether a page looks good is still judged by the review (with screenshots when `visual` is configured).
