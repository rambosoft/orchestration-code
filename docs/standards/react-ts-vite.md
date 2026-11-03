# Engineering standards: React + TypeScript + Vite (draft)

Status: draft for ADR 0034. This becomes the `ENGINEERING_STANDARDS.md` that the `react-ts-vite` pack writes into a project; the `media-tv-app` pack adds the platform sections (marked PLATFORM). Applies to every developer, implementation agent and reviewer.

**Principle.** Performance, backward compatibility and maintainability are part of "done". A change that works on a fast desktop but strains memory, slows navigation or breaks remote control on the lowest supported device does not pass review.

Gate column: **G** = enforced by an automated check, **R** = enforced in review (prose only).

## 1. Clean code
| Rule | Gate |
|---|---|
| One clear responsibility per function or method; split when it helps, do not shatter three lines into three functions | R |
| Names state intent, not mechanics | R |
| Short doc comment on every public service method, non-obvious API and heavy logic (what, inputs, failure behaviour); none on trivial code | G (lint: exported service functions need a doc comment) |
| Expected failures are handled explicitly; errors are never swallowed silently | G (`no-empty`, no empty `catch`) |
| Side effects (network, storage, subscriptions, timers) are explicit and live in services or effects, never in render | R |
| No deep nesting, long functions or duplicated business rules; no abstraction without two real uses | G (complexity limit, `jscpd`) |
| Strict TypeScript, no `any` without a reason comment | G |

## 2. Components
- Extract a component when it is reused, has its own behaviour, needs separate tests or is a meaningful UI boundary. Do not extract every repeated fragment. (R)
- Components have a clear responsibility, typed and documented props, sensible defaults, and documented variants instead of one-off overrides. (R)
- Logic that is not view code moves to hooks or utilities; shared UI lives in one shared folder. (R-021; boundaries G with `dependency-cruiser`: `no-circular`, `components-not-import-pages`, `hooks-not-import-pages`, `services-not-import-ui`, `storage-through-index`, `input-through-index`, `no-prod-imports-test-files`, `not-to-unresolvable`)
- Custom CSS is the exception: use design tokens and variants. (G: lint forbids raw colours, raw pixel sizes and raw `vh` values outside the token files)

## 3. Dependencies
- Latest stable compatible releases at project start; lockfile committed; Node and package manager pinned. (G)
- Every significant dependency has a recorded reason; no abandoned library; check bundle size, memory, device support, licence. (G allow-list, R reason)
- Renovate: grouped minor and patch updates, major updates reviewed alone against the compatibility matrix, auto-merge only for chosen low-risk updates. (G)

## 4. Documentation
- `docs/pages/<page>.md`: purpose, what is visible and when, the actions each kind of user can take, supported inputs, data dependencies, performance notes, known limits. Short, human-readable, same PR as the behaviour change. (G: every route has a page doc, links resolve)
- `docs/architecture/` for data flow, caching, input, component contracts, decisions; `docs/ai/INDEX.md` is a generated map into those documents, never a copy. (G)
- A scheduled workflow reports drift as an issue or a proposed PR for human review. It never rewrites behaviour descriptions. (G)

## 5. Refactoring, dead code, deprecated code
- Remove confirmed dead code (components, hooks, services, styles, assets, dependencies). Before deleting, check dynamic imports, routes, configuration and external entry points, not just a text search. (G `knip`, R)
- Merge duplicated code only after checking that the copies behave the same. (G `jscpd`, R)
- Keep cleanup, architecture change and feature work in separate, reviewable, reversible changes. (R)
- Deferred or deprecated code carries `@deprecated` with the replacement or `TODO(debt:ID)`, and a ledger entry in `docs/technical-debt/` with ID, reason, risk, next action, owner, tracking issue and review date. (G: tag without entry, entry without tracking, or an expired review date fails)

## 6. Lifecycle, memory and CPU
- Every subscription, timer, observer, listener, request and media resource has an owner and a cleanup. (G lint for effects without cleanup where detectable; heap test)
- No unbounded cache, queue, prefetch or background task: each has a limit or a lifecycle. (R, G for registered caches)
- No heavy transformation on the main thread; use a worker. No duplicated copies of large data. (R)
- A change that raises memory, bundle size, renders or requests is compared with the baseline. No optimisation is accepted without what was measured, what changed and the result. (G budgets, R)

## 7. Backward compatibility
- The project keeps a compatibility matrix (browser engines per device family, JS and CSS features, storage limits, codecs, key maps, network behaviour) and builds one bundle per tier. Vite defaults and the legacy plugin are not proof: each tier has a build check and a smoke test. (G)
- Every feature answers: can the oldest supported device run it, what are its memory and CPU needs, what is the fallback, does it change existing behaviour, does it invalidate saved data, does it fail without breaking the rest. (R)
- Stored data has a schema version and migrations; an update never destroys user data. (G migration test)

## 8. Styling and responsive design
- One design system of tokens (colour, type, spacing, radius, shadow, sizes, breakpoints, focus, motion). One root scale unit for sizing. (G)
- Different layouts per size class, tested from 320 px to 4K and on real TVs; no hover-only function; visible focus; reduced motion honoured; pointer targets sized per WCAG 2.2; text scaling and zoom respected. (G Playwright viewports, R)

## 9. Testing and review
- Vitest for units and integration, Playwright for interactions, viewports and heap tests; real devices for TVs. (G)
- Bug fixes get a regression test. Behaviour-preserving refactors keep the parity tests green. (G)
- Critical subsystems (see the registry) get a specialist review per task; other tasks get the cheap gates per task and one model review per milestone. (R)
- No new dependency without a recorded justification; no architectural shortcut without an audit record. (R)

## PLATFORM (media-tv-app pack)
### P1. Input
One input manager turns remote, keyboard, mouse and touch into intents; a spatial navigation engine owns focus (registry, zones, restoration, modal containment). Pages and components register focusable regions; they do not listen for keys. Text fields and native controls keep their keys. Gate: lint forbids key listeners outside the input layer. Candidate library: Norigin Spatial Navigation, to be verified on the target TVs and the carousel.

### P2. Storage and cache (four levels)
L1 hot memory (visible now), L2 warm memory (nearby, bounded), L3 IndexedDB (catalogue, indexes, preferences), L4 remote source. Required: bounds and eviction, TTL per data class, indexed queries, schema migrations, deduplicated requests, cancellation, quota and storage-error recovery, metrics and diagnostics, targeted invalidation, defined offline behaviour, isolation by provider, account and profile, incomplete imports never treated as complete, a failed refresh never destroying usable data. No `localStorage` for catalogue or frequently written data.

### P3. Large catalogues (1,000,000 items)
Never all items in memory or the DOM: paging or category fetch where the provider allows, virtualised lists with bounded overscan, normalised metadata and indexes in IndexedDB, indexed search, prefetch by navigation pattern, stale-request cancellation, de-duplication, back-pressure under rapid input. The guarantee is conditional on the provider (a whole-list response cannot be avoided on the client); a discovery task decides whether an indexing proxy is needed.

### P4. Xtream providers
Central adapter with typed requests and runtime-validated, normalised responses; capability detection per provider; timeouts, cancellation, controlled concurrency, de-duplication, exponential backoff with jitter, no retry on authentication failures; large responses parsed in a worker in chunks and persisted per batch; malformed records skipped without losing the catalogue; live, movies, series, episodes and EPG are separate domains; time zones handled in one place. Credentials appear in URLs: never log them, never send them to analytics or error reports, isolate cached data by account.

### P5. Protected components
A performance registry lists critical components (carousel first), their constraints and test scenarios. They are not replaced by a generic library to shorten code. Before changing one, record how it mounts, prefetches, releases images, preserves focus, cleans up and behaves under rapid navigation and remount; measure the change on a low-spec profile.
