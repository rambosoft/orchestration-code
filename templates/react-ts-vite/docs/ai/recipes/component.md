# Recipe: a shared component or hook

Use when two pages need the same piece, or a piece has its own behaviour and tests (R-009). Check the reuse index first: it may already exist.

1. Put a component in `src/components/<Name>/`, a hook in `src/hooks/`. Components never import pages (R-021).
2. Give the folder a `README.md` contract: one purpose line, then `## Interface`, `## Invariants`, `## Side Effects` (R-022, template in `docs/ai/MODULE_README_TEMPLATE.md`). The first line becomes the purpose shown in the reuse index, so make it say what the piece is for.
3. Write a doc comment above each export that other code uses.
4. Interactive elements have roles, labels and visible focus (R-004). Focus is registered with the input layer, never handled with key listeners (R-005).
5. Every timer, listener, observer and request has an owner and a cleanup (R-016). No unbounded list in the DOM: page it and virtualise it (R-018).
6. Tests are table-driven and cover each variant and edge case (R-010).
7. Use `variants` before custom styling (R-015).
8. Add a row to `docs/ai/PATTERNS.md` when the piece sets a pattern others should follow.
