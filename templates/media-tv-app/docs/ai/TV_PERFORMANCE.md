# TV performance rules

Added by the `media-tv-app` pack on top of the react-ts-vite rules. The target is a smart TV with little memory and a slow CPU, so these are checked, not hoped for.

- T-001 The heap must not grow across repeated navigation. `npm run test:heap` visits the routes of `e2e/heap-routes.json` again and again without reloading, forces a collection after each pass, and fails when the heap keeps growing past `docs/ai/performance-budgets.json`. Add every page to the route list when it is added. The budgets are provisional until measured on the real devices; changing one is a reviewed change with its reason in `docs/decisions/`.
- T-002 Components listed in `docs/ai/component-registry.json` (the carousel first) are protected: once the folder exists it needs an approved design (R-024), a README contract (R-022) and a specialist review of every change (`npm run check:registry`).
- T-003 Bundle size is held by `check:legacy-budget`; do not add a dependency for what a few lines do (R-014).
- T-004 Long tasks over the budgeted duration are reported by the heap run. Move heavy work to a worker and page long lists (R-018).
- T-005 State the memory and CPU effect of a feature in its page document (R-019). A real TV check stays a milestone acceptance step.
