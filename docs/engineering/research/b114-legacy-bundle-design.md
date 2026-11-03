# B-114 legacy bundle and device tiers: design and verified facts (2026-11-03)

Status: built (B-114). The design below is the Codex note; the facts below it were verified live and override its "unverified" marks.

## Verified live (scratch Vite 8.3.5 react-ts project)
- `@vitejs/plugin-legacy@8.2.3` installs and builds with Vite 8.3.5 for `legacy({ targets: ["Chrome >= 53"] })`; terser and acorn arrive transitively.
- The build emits `index-legacy-*.js` and `polyfills-legacy-*.js`; both parse as classic ES2015 scripts (acorn) and `dist/index.html` carries the `nomodule` entries; the modern chunk uses newer syntax, as expected.
- A fresh `npm create vite` project onboarded with `dev onboard --pack react-ts-vite --write --install` passes `npm run verify` (including the legacy gates) with exit 0.
- Found by the gates: the pack tokens used `:focus-visible` (Chrome 86), so old TVs would show no focus ring; it is now a plain `:focus` rule.

## Not done
- No smoke test on an old engine: Chromium 53 is not obtainable here, and a Playwright Chromium is not proof for Chrome 53. A real webOS 4+ / Tizen 4+ check stays a milestone acceptance step for the operator; the automated substitute belongs with the host simulator (B-143).

---

## Design note as written by Codex

# B-114 design note

**Recommendation:** keep the matrix as a small data file in the React pack, build Vite’s official legacy plugin for Chrome 53, and gate the emitted legacy chunks, source APIs, and bundle size. Treat the first successful React build as the start of a **new** size baseline. No files were changed.

## 1. Device-tier data

Add a proposed `device-tiers.json` to the copied files in [templates/react-ts-vite/pack.json](C:/workspace/test-orch/templates/react-ts-vite/pack.json). The existing pack applier, [scripts/apply-react-pack.mjs](C:/workspace/test-orch/scripts/apply-react-pack.mjs), copies pack files into the app. Add a checker script to the same copy list; it reads the copied matrix and validates required fields and target values.

```json
{
  "schemaVersion": 1,
  "tiers": [
    { "id": "modern", "browserFloor": null, "status": "operator-data-pending" },
    {
      "id": "legacy",
      "browser": "Chromium",
      "minimum": 53,
      "devices": { "webOS": "4+", "Tizen": "4+" },
      "bundle": "vite-legacy"
    },
    { "id": "below-legacy", "action": "vue2-or-light-build" }
  ]
}
```

`null` is deliberate: the modern tier’s device floor awaits operator exports. `check-device-tiers.mjs` should reject an enabled shipping tier with no floor. The new React app’s Chrome 53 floor does not change the legacy Vue app’s Chrome 38 contract.

## 2. Legacy build recipe

The new app declares Vite `^8.3.5`, React `^19.3.1`, TypeScript `~6.0.3`, and `@vitejs/plugin-react` `^6.1.2`; locally installed Vite is **8.3.4**. `@vitejs/plugin-legacy` is not installed in the app. The official legacy plugin’s 8.x line supports Vite 8 and emits legacy chunks with required polyfills. [Plugin README](https://github.com/vitejs/vite/blob/main/packages/plugin-legacy/README.md), [plugin changelog](https://github.com/vitejs/vite/blob/main/packages/plugin-legacy/CHANGELOG.md).

**Proposed; install/build not verified locally:** add `@vitejs/plugin-legacy@^8` (exact resolved version and peer compatibility must be verified by install), then configure:

```ts
import legacy from '@vitejs/plugin-legacy'

plugins: [
  react(),
  legacy({ targets: ['Chrome >= 53'] })
]
```

Keep the existing `build` command (`tsc -b && vite build`). The plugin’s default legacy chunk and polyfill behavior is intended here; do not set `polyfills: false`. Vite 8.3.4 plus plugin 8.x compatibility, emitted chunk naming, target enforcement, and polyfill output must be confirmed with an actual build before pinning. The locally installed Vite version differs from the package range’s latest eligible version.

## 3. Deterministic gates

Add scripts to the template’s `scripts/` directory, following its existing `.mjs` script style. All names below are proposed additions.

- **`check-legacy-syntax.mjs`** — input: emitted legacy `.js` chunks, including the legacy polyfill chunk. Parse as ES2015 and fail with the file and parser error, e.g. `Legacy syntax check failed: <file>: <parse error>`. Add a direct parser dependency such as `acorn@^8`; the exact version and install are unverified. Do not use the current Node parser as proof of Chrome 53 syntax.
- **`check-legacy-apis.mjs`** — input: app source files. Fail on banned APIs with file, line, and rule, e.g. `Legacy API check failed: fetch is not allowed; use the supported adapter`. Base the rule inventory on the old audit, but scope it to React app files and use explicit documented wrapper/allowlist exceptions. A TypeScript-aware AST implementation needs a parser dependency; the template’s existing TypeScript/ESLint dependencies can be evaluated before adding one.
- **`check-legacy-budget.mjs`** — input: emitted legacy chunks and a new React baseline. Measure total legacy JavaScript bytes and largest JavaScript file; fail with measured/allowed values. Reuse the old project’s relative growth method as a starting policy (**+10% total, +5% largest file**), but establish the React baseline from its first accepted build. Do not reuse the Vue app’s byte totals.
- **Polyfill policy:** Babel/plugin polyfills may cover JavaScript built-ins; they do not supply missing browser DOM APIs. Keep source API restrictions and documented fallbacks for those APIs. The plugin’s precise polyfill chunk content is build-dependent and must be inspected in the first build.

The old app’s Chrome 38 audit checks syntax such as spread, optional chaining, nullish coalescing, async/await, generators, and `for-of`; its API inventory includes `fetch`, observers, `Proxy`, `structuredClone`, and selected array/object/number methods. Reuse that inventory as a review checklist, not as proof that a Chrome 53 build passes.

## 4. Pack wiring and rules

Add the matrix, checker, and gates to the pack’s copied files. Add package scripts for `check:device-tiers`, `check:legacy-syntax`, `check:legacy-apis`, and `check:legacy-budget`. Run the build before emitted-chunk checks. Include the complete sequence in `verify`, so it can run outside the pack manifest too.

Add manifest gates for the device-tier check and legacy API check as task gates; add the build before syntax and budget gates, which also run at task scope. Keep the broader `test` gate at milestone scope. The physical TV smoke check belongs to milestone/release acceptance, not a per-task gate.

Update R-019 in [templates/react-ts-vite/AGENTS.md](C:/workspace/test-orch/templates/react-ts-vite/AGENTS.md): require the Chrome 53 legacy target from the matrix; prohibit unsupported APIs unless a documented fallback or compatibility check covers them; require the legacy gates to pass; retain the requirement to state memory and CPU effects. R-015 already governs token-based styling; retain it and document legacy-tier CSS support in the matrix/check rather than loosening it.

## 5. Smoke test and limits

This Windows environment has no Chrome/Chromium executable on `PATH`, no Chrome 53 binary, and no installed legacy plugin. Playwright’s browser downloads are tied to its supported browser revisions; pinning Playwright does not provide an arbitrary Chromium 53 build. [Playwright browser documentation](https://playwright.dev/docs/browsers).

Use a pinned Playwright-managed Chromium available to CI as the nearest automated smoke substitute: serve the production build, verify the legacy entry is selected, and exercise app startup and critical interactions. This is **not** a Chrome 53 compatibility proof. The operator must still test on actual webOS 4+ and Tizen 4+ devices; rendering, input, startup, and performance remain device checks. The roadmap’s operator version export is also needed to resolve the modern tier floor.

## 6. Reusable legacy artifacts

Verified in `C:/workspace/orchestration-projects/luxus-app`:

- `scripts/legacy-compat/audit-chrome38.js`, `chrome38-audit-baseline.json`, `scan-legacy-apis.cjs`, and `validate-legacy-build-syntax.cjs`: reuse the API inventory, audit categories, and ideas for rule reporting.
- `scripts/check-client-bundle-budget.cjs` and `scripts/report-client-bundle-size.cjs`: reuse metric definitions and relative-growth approach.
- `scripts/client-bundle-budget-baseline.json`: **do not reuse its values**. They are Vue-app-specific: total 16,701,981 bytes; modern 7,239,691; legacy 9,462,290; largest JS 813,901. Its thresholds are total/modern/legacy +10%, largest JS +5%.
- Do not reuse the Chrome 38 syntax floor, project-specific scan roots, old baseline, or its dual-target release workflow. The old project remains unchanged.

## 7. Implementation slices

1. Add a failing fixture test for matrix validation; add matrix data and checker; pass valid and invalid fixtures.
2. Add a failing config/build assertion for the Chrome 53 target; install and resolve the plugin; produce and inspect dual-target build output.
3. Add failing syntax fixtures containing a post-ES2015 construct; implement emitted-legacy parsing; pass on produced legacy chunks.
4. Add failing source fixtures for banned APIs and documented exceptions; implement source scan and reporting.
5. Add failing budget fixtures for over-limit total and largest file; implement the new React baseline and growth checks.
6. Wire scripts into `verify` and manifest gates; prove each gate fails independently and the ordered build-and-gate path passes.
7. Add the Playwright smoke and record its engine version and limits; complete operator device checks before release acceptance.

## Risks and scope

The exact legacy plugin resolution, peer dependencies, output paths, polyfill contents, parser dependency, and a working build are unverified until installation/build. The Chrome 38 audit and budgets are not evidence for Chrome 53. This item covers the React pack and new React app only; it does not migrate the old app or establish a modern device floor.

**Inspection basis:** requested ADRs, backlog row, standards, roadmap, template pack/rules, both app manifests, installed package directories, and old audit/budget scripts were checked with repository file searches, file reads, and package/runtime queries.