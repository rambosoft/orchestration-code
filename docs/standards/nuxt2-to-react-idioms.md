<!-- Produced by Codex (gpt-6-luna, read-only) on 2026-11-02 from a clean clone of rambosoft/luxus-app at fb1f17a7 (GitHub main), as analysis for B-114. Counts come from commands Codex ran; they are not re-checked. Verify a number before a task depends on it. -->

# Nuxt/Vue Idiom Map for a React 19 + TypeScript + Vite Migration

Counts below are distinct files matching the stated source patterns under `pages`, `components`, `layouts`, `plugins`, `store`, `middleware`, `mixins`, `common`, and `api`. Examples are representative, not a full inventory. A combined count means files matching at least one of the listed patterns; an idiom’s implementation may span several files.

## State, routing, and data

### Vuex modules and `mapState` / `mapGetters` / `mapActions` / `mapMutations`

- **Measure:** 2 files match `mapState|mapGetters|mapActions|mapMutations|namespaced:`; 5 matches.
- **Examples:** `components/features/system/DebugLogPanel.vue`; `store/xtream2.js`
- **Use here:** Vuex state is organized into store modules, and components use Vuex helpers to bind state and actions.
- **React replacement:** Use one small store library for shared client state, with typed selectors and actions. Keep server data in the query cache and local interaction state in components or hooks.
- **Pitfall:** There are parallel `store/xtream.js` and `store/xtream2.js` implementations; don’t combine or migrate them as if they were one path without checking which pages use each.

### `asyncData` and `fetch` hooks

- **Measure:** `asyncData(` occurs in 4 files (4 matches); `fetch(` occurs in 6 files (7 matches), but that pattern also matches ordinary fetch functions and is not a reliable count of Nuxt fetch hooks.
- **Examples:** `pages/live_v2/index.vue`; `pages/live_v3/index.vue`; `pages/playlists/index.vue`
- **Use here:** Page-level async loading is mixed with client-driven loading and request functions; most behavior is not SSR-driven.
- **React replacement:** Put request definitions in a query layer and invoke them through hooks from pages or feature hooks. Model loading, errors, retries, and cache invalidation in that layer.
- **Pitfall:** Don’t infer that a page’s data is available before mount just because it uses a Nuxt data hook; verify its runtime path, since much of the app’s behavior is client/plugin/store driven.

### Vue mixins

- **Measure:** 24 files contain a `mixins:` declaration (24 matches).
- **Examples:** `pages/index.vue`; `pages/live_v2/index.vue`; `pages/live_v3/index.vue`
- **Use here:** Mixins share lifecycle methods, state, and behavior across pages and components.
- **React replacement:** Move reusable behavior into focused hooks; move pure transformations and shared constants into utilities.
- **Pitfall:** Mixin behavior can depend on implicit component properties and lifecycle order. Preserve page-specific navigation, player, and cleanup behavior when extracting it.

### Nuxt middleware and route guards

- **Measure:** 11 files match `middleware:` or `beforeRouteEnter|beforeRouteLeave|beforeRouteUpdate`; the more specific check finds 7 middleware declarations and 3 route guards.
- **Examples:** `pages/dev/player-test.vue`; `pages/error/index.vue`; `pages/live_v3/index.vue`
- **Use here:** Middleware and guards gate page access and manage route transitions.
- **React replacement:** Use a client router with route loaders or wrappers for access checks, and keep authorization decisions in explicit utilities or hooks.
- **Pitfall:** Auth and bootstrap behavior spans plugins, pages, and middleware. Preserve its ordering and recovery paths instead of treating each guard as an independent redirect.

### Client-only plugins and injected `$` helpers

- **Measure:** 16 files match the combined search for client-plugin references and `inject(` (20 matches); `inject(` alone occurs in 10 files (14 matches).
- **Examples:** `plugins/axios.js`; `plugins/auth-session.client.js`; `plugins/global-shell-components.js`
- **Use here:** Nuxt plugins initialize client services, register global components, and inject helpers for use by pages and components.
- **React replacement:** Initialize browser-only services at the app boundary and expose them through typed modules or narrowly scoped context providers. Keep browser access out of code that can run during module initialization in unsupported environments.
- **Pitfall:** Plugin order is part of the app’s bootstrap behavior, especially for Axios, auth/session, and device collection; reproduce required sequencing explicitly.

### `this.$store`, `this.$route`, `this.$router`, `this.$nuxt`, and `this.$t`

- **Measure:** `$store`: 80 files / 2,329 matches; `$route`: 55 / 228; `$router`: 32 / 80; `$nuxt`: 47 / 425; `$t`: 28 / 169.
- **Examples:** `pages/index.vue`; `pages/authenticate/index.vue`; `pages/live_v3/index.vue`
- **Use here:** Components access shared state, route information, navigation, Nuxt events, and translations through injected instance properties.
- **React replacement:** Use typed store selectors/actions, router hooks, an explicit app event mechanism where needed, and a translation hook. Pass dependencies through clear interfaces instead of relying on a global component instance.
- **Pitfall:** The high `$nuxt` count includes event-bus usage. Replacing it with router calls alone will lose non-navigation events.

### Event bus and `$emit` / `$on`

- **Measure:** 116 files match `$emit(` or `$on(` (613 matches).
- **Examples:** `pages/guide/index.vue`; `pages/live_v2/index.vue`; `pages/expired/index.vue`
- **Use here:** Components emit events to parents, and `$nuxt` is also used as an event bus.
- **React replacement:** Prefer callback props for direct parent-child communication; use a small typed event utility or store actions for cross-tree events that genuinely need global delivery.
- **Pitfall:** Vue `$emit` and `$nuxt.$emit` have different ownership and lifetimes. Inventory event names and subscribers before replacing them with a single mechanism.

## Component behavior and UI

### Watchers and computed properties with side effects

- **Measure:** 138 files match `watch:` or `computed:` (199 matches).
- **Examples:** `pages/index.vue`; `pages/authenticate/index.vue`; `pages/dev/player-test.vue`
- **Use here:** Vue watchers react to changes and computed properties derive values; the broad count does not distinguish pure derivation from side effects.
- **React replacement:** Use render-time expressions or memoization for pure derived values, and effects for synchronization with external systems. Keep effects in hooks with explicit dependencies and cleanup.
- **Pitfall:** Some watchers may trigger requests, navigation, or focus changes. Replacing them with render-time calculations can change when those effects occur.

### Lifecycle hooks and manual listener cleanup

- **Measure:** `mounted(` and `beforeDestroy(` occur in 90 and 89 files, respectively; together the patterns match 112 files / 179 matches. `addEventListener` or `removeEventListener` occurs in 88 files.
- **Examples:** `components/ui/RadioGroupComponent.vue`; `components/ui/ProgressComponent.vue`; `components/features/system/TimetableComponent.vue`
- **Use here:** Components initialize browser behavior in lifecycle hooks and manually remove listeners during teardown.
- **React replacement:** Put each external subscription or timer in an effect that returns its cleanup function.
- **Pitfall:** Listener cleanup must use the same target, event name, and handler identity as registration; TV input handling can be attached globally and survive route changes if cleanup is missed.

### Direct DOM access and `$refs`

- **Measure:** 163 files match `$refs`, `document.`, or `window.` (1,373 matches).
- **Examples:** `pages/index.vue`; `pages/authenticate/index.vue`; `pages/close/index.vue`
- **Use here:** Code reaches DOM nodes and browser globals for focus, layout, media, and other imperative behavior.
- **React replacement:** Use refs for specific DOM nodes and isolate browser APIs in hooks or utilities. Provide guarded fallbacks for APIs unavailable in older TV browsers.
- **Pitfall:** Focus and scrolling are core TV-navigation behavior. Preserve the app’s focus recovery and legacy fallbacks rather than translating DOM calls mechanically.

### Custom directives and filters

- **Measure:** No files matched the checked custom-directive declaration or usage patterns. The check for `filters:` found 11 files / 24 matches.
- **Examples:** `components/common/TvButtonsLegend.vue`; `components/ui/GeneralInputComponent.vue`; `pages/live_v3/index.vue`
- **Use here:** Vue filter declarations provide display transformations; the checked custom-directive patterns did not reveal a clear custom directive inventory.
- **React replacement:** Move display transformations into pure formatting utilities or small components. Implement imperative DOM behavior in hooks attached to refs.
- **Pitfall:** Vue template directives are not all custom directives. Don’t interpret a count of `v-*` template syntax as a count of custom behavior.

### Global components and layouts

- **Measure:** 108 files match component or layout declarations (143 matches).
- **Examples:** `layouts/default.vue`; `layouts/splash.vue`; `plugins/global-shell-components.js`
- **Use here:** Nuxt layouts provide page shells, while a plugin registers six shell-wide global components.
- **React replacement:** Build explicit app shells and route layouts; import shared components where used or expose only a small set through a shell boundary.
- **Pitfall:** `nuxt.config.js` sets `components: false`, so most components are explicitly registered rather than auto-imported. Don’t assume every referenced component is globally available.

### `v-model` on custom components and `.sync`

- **Measure:** 49 files match `v-model` or `.sync` (271 matches).
- **Examples:** `pages/dev/player-test.vue`; `pages/guide/index.vue`; `pages/live_v2/index.vue`
- **Use here:** Two-way bindings connect component props and emitted updates to page state.
- **React replacement:** Use controlled props with explicit `onChange` callbacks and typed value contracts. For reusable inputs, document whether the callback returns an event, a value, or a richer result.
- **Pitfall:** Some bindings coordinate multiple pieces of page state or custom event names; preserve those contracts rather than assuming every `v-model` is a simple text input.

## Input, storage, and runtime

### Keyboard and remote key handling

- **Measure:** `keydown` occurs in 85 files (725 matches); `keyCode` occurs in 73 files (161 matches). The combined broad search for `keydown|keyCode` finds 88 files / 626 matches.
- **Examples:** `components/ui/GeneralInputComponent.vue`; `components/ui/RadioGroupComponent.vue`; `components/features/system/QrCodeComponent.vue`
- **Use here:** Handlers listen for key events, often using numeric key codes and component-specific switches; one legacy fallback reads `e.which || e.keyCode`.
- **React replacement:** Centralize browser event handling in one input layer that normalizes keys to app actions and dispatches to the active screen or focused control.
- **Pitfall:** Many components currently own key handlers. A centralized layer must preserve focus context and action precedence so global navigation does not conflict with control-level input.

### `localStorage`, `sessionStorage`, and IndexedDB

- **Measure:** `localStorage` occurs in 33 files / 201 matches; `sessionStorage` in 4 / 8; `indexedDB` in 3 / 6. Combined: 38 files / 215 matches.
- **Examples:** `store/settings-dev.js`; `store/movies-list-page.js`; `common/utils/catalog-session-cache.js`
- **Use here:** Browser storage is used for settings and page/session data, with separate IndexedDB access.
- **React replacement:** Put persistence behind a typed storage interface that distinguishes durable preferences, session state, and transient query data. Keep catalogue data in the query layer and its cache, not localStorage.
- **Pitfall:** Existing storage calls are spread across store and utility code. Catalogue-like data may have caching paths, so classify each persisted value before choosing its replacement.

### Web Workers

- **Measure:** 7 files match `Worker(` (16 matches).
- **Examples:** `pages/guide/guide-epg-provider.js`; `plugins/content-cache-manager/catalog-query.js`; `plugins/content-cache-manager/catalog-worker-runner.js`
- **Use here:** Workers run guide or catalogue-related work, with shared worker creation support in the legacy compatibility helpers.
- **React replacement:** Keep worker creation behind a typed utility that handles browser support, message types, and teardown; call it from hooks or the query layer.
- **Pitfall:** Worker availability and bundling behavior vary in the target legacy browsers. Preserve the existing guarded creation path and verify how Vite emits worker assets for the legacy bundle.

### Timers and cleanup

- **Measure:** `setInterval` occurs in 22 files / 46 matches; `setTimeout` in 102 / 337; combined: 105 files / 383.
- **Examples:** `pages/live_v3/index.vue`; `plugins/content-cache-manager/`; `components/features/system/TimetableComponent.vue`
- **Use here:** Timers schedule delayed work and recurring refreshes, with cleanup implemented across component and plugin lifecycles.
- **React replacement:** Wrap timers in hooks or utilities that return cleanup and make ownership explicit. Use shared timing helpers for legacy-sensitive kickoff work.
- **Pitfall:** Chrome 38-class timer functions may not support `.bind`; the repo’s compatibility guidance specifically requires wrapping host timers instead of binding them.

### CSS units and scale

- **Measure:** In the scoped source roots, `vh` appears in 161 files / 5,117 occurrences; `vw` in 55 / 235; `px` in 26 / 90; `rem` in 7 / 154.
- **Examples:** `assets/vars/_breakpoints.scss`; `assets/vars/_tokens.scss`; `nuxt.config.js`
- **Use here:** Styling mixes viewport-relative dimensions with fixed pixel and rem values; the mobile breakpoint variables use `vh`.
- **React replacement:** Preserve the existing design tokens and layout intent in shared CSS, then validate representative TV, tablet, and phone sizes. Keep responsive rules in styles rather than duplicating scale calculations in components.
- **Pitfall:** The scoped count excludes the `assets` directory, so it measures unit use in the requested source roots, not the complete stylesheet inventory. The checked files expose breakpoint variables and viewport metadata, but no single global scale factor.

## No direct equivalent or high risk

- **Nuxt plugin injection:** Requires an explicit app initialization and service ownership design.
- **`$nuxt` event bus:** Its events may combine navigation, application status, and component communication; inventory subscribers before migration.
- **TV remote key handling:** Numeric key-code behavior, focus ownership, and handler precedence need a single input model with compatibility coverage.
- **Focus, scrolling, and imperative DOM behavior:** React refs replace access syntax, not the focus recovery policy.
- **Workers and old-browser support:** Vite worker output and the legacy bundle need validation against the actual target browser floor.
- **Storage semantics:** Existing persistent values need classification before moving them behind the storage interface; catalogue data belongs in the query layer.
- **Bootstrap and auth order:** Behavior crosses Axios, auth/session plugins, splash/register pages, and middleware.
- **Parallel implementations:** `store/xtream.js` and `store/xtream2.js`, three live pages, and legacy versus V2 player code must remain distinct until usage and migration scope are clear.

## Suggested migration order of idioms

1. Define the TypeScript domain types, compatibility helpers, and browser capability guards for the target TV browser floor.
2. Build the storage interface and query layer; classify existing persisted data and keep catalogue data out of localStorage.
3. Build the single input layer and focus/navigation contracts before migrating interactive pages.
4. Establish the small shared store and typed app services, replacing Vuex and injected helpers with explicit interfaces.
5. Add the client router, route access checks, and app shell/layout structure; preserve auth/bootstrap ordering.
6. Extract mixins into hooks and utilities, then migrate lifecycle behavior, watchers, listeners, and timers with explicit cleanup.
7. Migrate reusable controls and page-level bindings, including `v-model` and `.sync`, to controlled React contracts.
8. Migrate pages in dependency order, keeping parallel page/player implementations separate until their consumers are identified.
9. Validate responsive styling and legacy behavior against production-like Vite output on representative TV and non-TV screen sizes.

## Facts that contradict assumptions

- Nuxt component auto-import is disabled: `nuxt.config.js` sets `components: false`; global registration happens in `plugins/global-shell-components.js`.
- The source is not purely SSR-driven: user-facing behavior is substantially client/plugin/store driven, despite SSR being enabled.
- Vuex helper usage is much narrower than direct store access: 2 files match the `map*`/`namespaced` search, while `this.$store` appears in 80 files.
- Storage is not limited to catalogue caching: `localStorage` occurs in 33 files, while `common/utils/catalog-session-cache.js` is a distinct session-cache path.
- The checked custom-directive patterns found no direct usages or declarations; template `v-*` syntax should not be mistaken for custom directives.
- The app’s compatibility guidance calls out timer-host quirks, guarded browser APIs, and production-like legacy validation; transpilation alone does not establish old-browser runtime support.