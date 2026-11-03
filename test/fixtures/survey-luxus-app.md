# Survey: Survey luxus-app

Mode: migrate. Produced read-only by the orchestrator survey stage from a deterministic inventory; nothing was changed.

## Summary
Survey of the Nuxt 2 / Vue 2 smart-TV app as a client-side React 19, TypeScript, and Vite rebuild for Chrome 53+ and all screen sizes. The repo’s compatibility roadmap currently documents Chrome 38+ and Nuxt differential serving, so the new browser floor and build direction need to be reconciled before implementation. The pilot can start with the independent no-internet and blocked routes plus small shared components.

## Stack
Nuxt 2, Vue 2, JavaScript, client-side plugins and stores with SSR and Nuxt modern/legacy output; npm; existing browser compatibility helpers under common/legacy/. The requested target is React 19, TypeScript, Vite, and a legacy bundle for Chrome 53+.

## Architecture
- Pages and layouts compose route-specific views; plugins initialize shared runtime, authentication, device, cache, and host integrations.
- Feature state and data fetching are split across store modules, plugins, and the customer REST client in api/iptv.js.
- The repo has parallel live page generations and separate legacy and V2 player implementations; migrate each deliberately.
- TV input, focus movement, back handling, and recovery flows are part of the UI contract.
- Current compatibility architecture centers on common/legacy/ and Nuxt differential serving; Vite replaces that build boundary in the proposed rebuild.

## Modules
- **Pilot: offline and blocked routes** (small, low): Show offline and blocked states, preserve reconnect redirect behavior, and provide a small independent pilot for routing, localization, and responsive layout. [pages/no-internet/index.vue, pages/blocked/index.vue, layouts/offline.vue, layouts/error-message.vue]
- **Shared UI and TV controls** (medium, medium): Port reusable UI, icons, semantic styling, and remote-button hints used by multiple routes. [components/ui/, components/common/TvButtonsLegend.vue, common/utils/svgIconRegistry.js, assets/vars/]
- **Application shell, authentication, and bootstrap** (large, high): Initialize the client app, session, route guards, shell, and startup or registration flows. [layouts/, middleware/, plugins/auth-session.client.js, plugins/axios.js, plugins/store-init.js, pages/splash/index.vue]
- **Xtream API, playlists, and account data** (large, high): Fetch and normalize Xtream data, manage playlists and credentials, and preserve request cancellation, pagination, and error behavior. [api/iptv.js, store/xtream.js, store/xtream2.js, pages/playlists/, tests/xtream2/run-xtream2-tests.cjs]
- **Content cache and local persistence** (large, high): Manage cached catalog data and persisted favorites/recent items, including cache lookup, updates, and invalidation. [plugins/content-cache-manager/, plugins/vod-cache-manager.client.js, plugins/favourites-manager.client.js, plugins/recently-manager.client.js, tests/cache/run-cache-tests.cjs]
- **Catalog browsing and detail** (large, high): Browse movie and series catalogs, navigate details, and connect catalog state to shared browsing components. [pages/movies/, pages/series/, store/movies-page.js, store/series-page.js, components/carousel/]
- **Search and sorting** (large, high): Provide search and sort interactions across search and live views, including focus and result states. [pages/search/index.vue, pages/live_v3/index.vue, components/AdvancedSearchComponent.vue, components/AdvancedSortingComponent.vue, plugins/vod-search-manager.client.js, store/search-page.js]
- **Live TV and guide** (large, high): Migrate live channel browsing and guide behavior while preserving the distinctions between existing page generations. [pages/live/index.vue, pages/live_v2/index.vue, pages/live_v3/index.vue, pages/guide/, store/]
- **Hand-built carousel** (large, high): Rebuild the custom carousel’s focus, movement, preview, and TV navigation behavior for React and varying screen sizes. [components/carousel/CarouselComponent.vue, components/VerticalCarouselComponent.vue, mixins/, tests/carousel/run-carousel-tests.cjs]
- **Player and native-host integration** (large, high): Resolve media sources, run player adapters, handle native-host messaging, and preserve playback lifecycle and recovery. [pages/player/index.vue, components/player/, components/player-core/, store/player.js, store/smart-player.js, plugins/webos-runtime.client.js]
- **Settings, profiles, and remaining account domains** (large, medium): Port user preferences and profile workflows, including persistence, access restrictions, and TV interaction. [pages/settings/, pages/profiles/, store/settings.js, store/user.js]
- **Build, browser compatibility, and release** (large, high): Replace Nuxt build and differential-serving assumptions with Vite and a measured Chrome 53+ legacy output while keeping modern output efficient. [nuxt.config.js, package.json, plugins/polyfills.client.js, common/legacy/, scripts/legacy-compat/]

## Hotspots
- plugins/content-cache-manager/: The cache manager is a multi-file domain with a focused test runner; migrating its persistence and lookup behavior risks data loss, stale content, or startup regressions. (package.json:47; package.json:50; plugins/content-cache-manager/cache-utils.js:1)
- components/player-core/: Player adapters and host-specific runtime integrations form a critical boundary where message formats, source selection, teardown, and recovery must remain compatible. (pages/player/index.vue:27; components/player-core/adapters/AdapterContract.js:1; plugins/webos-runtime.client.js:1)
- components/carousel/CarouselComponent.vue: The hand-built carousel is a shared interaction component whose focus and movement behavior must work with remote input and responsive layouts. (components/carousel/CarouselComponent.vue:1; package.json:63; tests/carousel/run-carousel-tests.cjs:1)
- pages/live_v3/index.vue: The live page combines advanced search and sorting controls with page state, making interaction and focus regressions likely during the rewrite. (pages/live_v3/index.vue:32; pages/live_v3/index.vue:47)
- api/iptv.js: Xtream fetching is a shared data boundary; request behavior and response handling need to remain aligned with store and playlist expectations. (api/iptv.js:1; store/xtream2.js:1; tests/xtream2/run-xtream2-tests.cjs:1)
- nuxt.config.js: The current build config defines Nuxt SSR and dual-serving behavior, which does not directly carry over to a client-only Vite app. (nuxt.config.js:1; docs/legacy-modern-support-master-roadmap.md:5; docs/legacy-modern-support-master-roadmap.md:10)

## Duplicated logic
- Three live page generations coexist at pages/live/index.vue, pages/live_v2/index.vue, and pages/live_v3/index.vue; determine which behaviors remain in scope before consolidating.
- Player code is split between components/ and components/player/ plus components/player-core/; retain required adapter behavior while selecting one React-facing contract.
- Catalog cache, VOD cache, search, favorites, and recently viewed behavior is spread across separate plugins and stores; define ownership and shared data contracts during migration.
- The app has existing common/legacy helpers for browser gaps; avoid reimplementing equivalent fallbacks inside React components.

## Constraints found in the repository's documents
- The compatibility roadmap documents Chrome 38+ support and modern browser support; the requested Chrome 53+ floor requires an explicit support-contract update.
- The roadmap’s target architecture is one deployment artifact using Nuxt differential serving with modern: 'client'.
- Customer/backend REST client code belongs in api/iptv.js; Nuxt internal proxy handlers live in server/api/* under /nxt/api/.
- Preserve TV navigation behavior, including focus movement, back handling, and recovery flows.
- Compatibility helpers are centralized under common/legacy/; the docs reject blanket polyfills and relying on Babel alone for runtime API support.
- Visible UI text uses i18n keys and supported locales EN, FR, DE, and ES.
- Production UI uses shared semantic color and typography tokens.
- Parallel implementations should remain separate unless the task explicitly migrates them.

## Risks
- The requested Chrome 53 floor and Vite legacy output may not match the current Chrome 38 compatibility audit or roadmap; verify actual device browser capabilities against the chosen bundle.
- React 19 and dependent packages may emit syntax or use runtime APIs unavailable on target TVs; audit emitted code and runtime APIs, not only TypeScript output.
- Changing storage keys, formats, or cache initialization can invalidate existing user data or cause cold-start and stale-data failures.
- Native player and host messaging can vary by TV platform; browser-only test coverage may miss protocol or lifecycle issues.
- Carousel timing, focus restoration, and D-pad behavior can regress even when mouse and touch interactions appear correct.
- Responsive layouts may alter text sizing, focus visibility, and remote navigation on small screens or TV resolutions.
- Moving Xtream requests can change cancellation, authentication, pagination, or error handling across domain stores.

## Test coverage
The repo includes focused Node runners for cache, player, carousel, and Xtream (`tests/cache/run-cache-tests.cjs`, `tests/player/run-player-tests.cjs`, `tests/carousel/run-carousel-tests.cjs`, `tests/xtream2/run-xtream2-tests.cjs`) and Playwright coverage for several feature domains. This was a rea…

## Refactor backlog
| id | title | kind | size | old paths | target | depends on | changes behaviour |
|---|---|---|---|---|---|---|---|
| R1 | Pilot offline and blocked routes | route | S | pages/no-internet/index.vue<br>pages/blocked/index.vue<br>layouts/offline.vue<br>layouts/error-message.vue | Implement these as independent React routes using the new router and shared shell primitives; preserve offline reconnect redirect and localized blocked content. | - | no |
| R2 | Pilot small shared UI and TV legend | component | M | components/ui/<br>components/common/TvButtonsLegend.vue<br>common/utils/svgIconRegistry.js | Create reusable React UI and icon primitives, retaining TV legend action identifiers and the shared design tokens. | - | no |
| R3 | Build the client shell and authentication bootstrap | infra | L | layouts/<br>middleware/<br>plugins/auth-session.client.js<br>plugins/axios.js<br>plugins/store-init.js<br>pages/splash/index.vue<br>pages/register/index.vue | Implement the React app entry, route guards, session bootstrap, API setup, and shared shell lifecycle. | R2 | no |
| R4 | Migrate Xtream fetching and playlist data | data | L | api/iptv.js<br>store/xtream.js<br>store/xtream2.js<br>pages/playlists/<br>tests/xtream2/run-xtream2-tests.cjs | Create typed API and domain data modules for Xtream requests, playlist state, cancellation, pagination, and errors. | R3 | no |
| R5 | Migrate content cache and local persistence | data | L | plugins/content-cache-manager/<br>plugins/vod-cache-manager.client.js<br>plugins/favourites-manager.client.js<br>plugins/recently-manager.client.js<br>tests/cache/run-cache-tests.cjs | Define typed storage schemas and cache services with explicit initialization, lookup, update, and invalidation behavior. | R4 | no |
| R6 | Migrate catalog browsing and detail routes | route | L | pages/movies/<br>pages/series/<br>store/movies-page.js<br>store/series-page.js<br>components/carousel/ | Implement movie and series browsing and detail flows over the typed catalog and cache services. | R2, R4, R5 | no |
| R7 | Migrate search and sorting flows | logic | L | pages/search/index.vue<br>pages/live_v3/index.vue<br>components/AdvancedSearchComponent.vue<br>components/AdvancedSortingComponent.vue<br>plugins/vod-search-manager.client.js<br>store/search-page.js | Create shared typed search and sort behavior with route-level adapters for search and live views. | R3, R4, R5 | no |
| R8 | Rebuild the hand-built carousel | component | L | components/carousel/CarouselComponent.vue<br>components/VerticalCarouselComponent.vue<br>mixins/<br>tests/carousel/run-carousel-tests.cjs | Implement a typed carousel with explicit focus, scroll, preview, and TV navigation contracts, adaptable to viewport sizes. | R2 | no |
| R9 | Migrate live TV and guide | route | L | pages/live/index.vue<br>pages/live_v2/index.vue<br>pages/live_v3/index.vue<br>pages/guide/<br>store/ | Port the chosen live and guide flows, preserving required behavior from each existing page generation. | R4, R7, R8 | no |
| R10 | Migrate player and native-host messaging | component | L | pages/player/index.vue<br>components/player/<br>components/player-core/<br>store/player.js<br>store/smart-player.js<br>plugins/webos-runtime.client.js<br>plugins/webapis.client.js<br>tests/player/run-player-tests.cjs | Create a typed player boundary and React-facing adapter while preserving source resolution, host messages, lifecycle, and recovery behavior. | R3, R4 | no |
| R11 | Migrate settings, profiles, and account domains | route | L | pages/settings/<br>pages/profiles/<br>store/settings.js<br>store/user.js | Implement account and preference routes over shared session, data, and persistence services. | R3, R5 | no |
| R12 | Replace Nuxt build with Vite and validate browser targets | infra | L | nuxt.config.js<br>package.json<br>plugins/polyfills.client.js<br>common/legacy/<br>scripts/legacy-compat/<br>docs/legacy-modern-support-master-roadmap.md<br>docs/open-questions-before-implementation.md | Establish client-only Vite output with a modern path and a tested Chrome 53+ legacy bundle; update the compatibility contract and release guidance. | R3 | no |

## Needs a decision (architecture or behaviour would change)
- none

## Open questions
- Is Chrome 53 the verified minimum across every supported TV device, and which device/browser combinations must be in release validation?
- Should React 19 be fixed for both modern and legacy outputs, or does the chosen legacy strategy require a constrained runtime or alternate entry?
- Which of the three live page generations and two player trees represent required production behavior?
- What existing local storage keys and schemas must remain readable across upgrade?
- Which native-host messaging protocols and TV platforms are mandatory for the first migration release?
- Which routes, layouts, or behaviors can be retired during migration?

## TODO (not done)
- Record the supplied prior status note as the survey scope: narrow evidence to route composition, persistence/player boundaries, and focused tests.
- Reconcile the requested Chrome 53+ contract with the repository roadmap’s Chrome 38+ contract and proposed Vite build.
- Inventory current storage keys, payload shapes, cache lifecycle, and migration requirements before implementing the persistence slice.
- Capture native-host message contracts and required TV test devices for the player slice.
- Define a shared React route, state, styling, localization, and TV focus foundation before broad page migration.
- Port and extend the existing focused runners as each vertical slice is rebuilt.

## Context consulted
- README.md
- AGENTS.md
- CLAUDE.md
