# Recipe: a service

Use for data access and domain logic: remote requests, caches, transformations. Services never import UI (R-021).

1. Put it in `src/services/<name>/` with a `README.md` contract (R-022). Exported functions have a doc comment: what, inputs, failure behaviour (R-002).
2. Remote calls are typed, validated at runtime, and have a timeout and cancellation. Handle expected failures explicitly; never an empty catch (R-007).
3. Storage goes through `src/storage` only (R-006). A cache states its size limit and its eviction (R-017).
4. Heavy transformation of a large list runs in a worker, not on the main thread (R-018).
5. A new third-party package needs the allow-list or a decision note first (R-014, `npm run check:deps`).
6. Tests are table-driven: success, each failure, cancellation, and the limits (R-010).
7. For a critical area (storage, input, the Xtream adapter) a design must be approved first and the task carries `Design:` (R-024).
