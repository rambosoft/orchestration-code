# Characterization (migration parity)

Before a slice (a page, a store module, a service) is ported, record what the legacy code does in `docs/characterization/<slice>.json`. The port is then proven by tests that cite these cases. `npm run check:parity` validates the files and the migration map; set `REFERENCE_ROOT` to the legacy checkout to also verify every cited legacy path exists.

```json
{
  "schemaVersion": 1,
  "slice": "no-internet",
  "legacy": { "revision": "<legacy commit the cases were read from>" },
  "cases": [
    {
      "id": "C-001",
      "page": "no-internet",
      "behaviour": "Reconnect consumes the redirect cookie once and navigates to its path",
      "expected": "replaceRoute('/home') is called once; the cookie is cleared",
      "basis": "static",
      "sources": ["pages/no-internet.vue:40-62"]
    },
    {
      "id": "C-002",
      "page": "no-internet",
      "behaviour": "The retry button shows a spinner for the request duration",
      "expected": "spinner visible until the ping settles",
      "basis": "observed",
      "observation": "captured from the running legacy app on 2026-11-03, tests/fixtures/no-internet-retry.json",
      "sources": ["pages/no-internet.vue:12-30"]
    }
  ]
}
```

Rules:
- `basis: "static"` means the expectation is explicit in legacy code (routes, constants, mappings, pure functions). `basis: "observed"` means it depends on runtime behaviour and must name the capture or fixture in `observation`. Never invent an expected value the source cannot establish.
- Every `id` is also listed under `## Cases` in `docs/pages/<page>.md` (a slice that is not a route, such as the build, the shell, storage or input, uses `docs/areas/<name>.md` instead) and cited in a test name in `src/pages/<page>/` or in a shared e2e test. A characterized case without a test is a failing gate.
- `docs/migration/map.md` is the ledger: `| old file | new file | status | tests |` with status `planned`, `characterized`, `ported`, `verified` or `deferred`. A `ported` or `verified` row needs an existing new file and existing tests.
- Behaviour that would change visibly is not ported silently: record it in `docs/migration/findings.md`.
