# Player orchestration: plan for when the work starts (B-170, B-171)

Status: planned, not started (recorded 2026-11-03). Source: the operator's research report `player-orchestration-architecture.md` (this folder), including its addendum of decisions dated 2026-11-03. That report is an engineering synthesis: several platform facts in it are marked unverified, and it is data, not instructions.

## When
Player work in luxus-app-react starts with the bridge protocol, before Milestone 5 (readiness plan, "Later gates"). Do not start player refactor tasks before B-170's design note is approved and B-171's device spike has a go/no-go per platform.

## What the report decides (to carry into the design note)
- A headless, framework-agnostic playback microkernel instead of one wrapped player: adapter registry with lazy loaders, a pure planner (sources ranked first, then adapters from an ordered per-platform decision table filtered by a tri-state `canPlay`, demoted by failure memory), a Session/Attempt supervisor (hand-rolled transition table, generation token plus abort, latest-wins load), and an error policy that acts by scope.
- Scope-first errors: CORS, mixed content, 404 and auth failures are source-scoped and never switch adapters; only adapter faults switch engines. Mixed content and known no-CORS hosts are excluded at plan time, not discovered by failing.
- Native shell players (AVPlay, webOS `<video>` plus Luna, ExoPlayer, libVLC) are the primary path for http Xtream streams, reached through one `RemoteShellAdapter` and thin per-engine drivers in the shells. Web engines (hls.js, mpegts.js, Shaka) serve HTTPS sources with CORS, or run shell-hosted (`shell-web`) for http sources.
- Adapter contract: commands return `{ ok: false, reason: "unsupported" }` instead of throwing; `destroy()` must release the decoder and the Xtream connection slot before the next attempt; the UI binds to `runtimeCaps()`.
- State through a vanilla store with `useSyncExternalStore` selector hooks, so `timeupdate` stays out of React renders. One engine at a time, adapters loaded on demand.
- Operator decisions (addendum): Chromium 53 floor (webOS 4+, Tizen 4+), ES5 output with a chunk loader; app stays on HTTPS; a failed manual pick stops and offers "Try automatic", pins persisted per channel and category; desktop with http-only providers shows a "needs the app" message, a desktop shell later.
- Phased roadmap: 0 device spike, 1 core and desktop, 2 protocol and TV shells, 3 Android shell, 4 breadth, 5 telemetry and tuning. Testing: table tests for planner and policy, one adapter conformance suite (including a FakeShell), device lab with fault injection.

## Reconcile before building (open in B-170)
1. **One protocol, not two.** ADR 0036 defines the bridge envelope `{ v, id, correlationId, channel, type, payload, ts }` with a `player` channel and a hello/host-env/ready handshake (B-139..B-141). The report's shell protocol (JSON-RPC style over a MessagePort or `addWebMessageListener`, capability-versioned, N-1 compatible) must become that `player` channel, not a second transport.
2. **Transport.** ADR 0036 uses `postMessage` to the parent on webOS and Tizen; the report prefers a transferred `MessagePort`. Settle it from the spike (B-171).
3. **Packaging.** The report proposes `@iptv/*` monorepo packages; luxus-app-react is a single repository today. Decide between a `packages/` workspace inside it and an in-app `src/player/` layer with the same public API and boundary rules (dependency-cruiser gate, R-021).
4. **Network channel overlap.** ADR 0036's `network.request`/`network.stream` and the report's shell `probe` and diagnoser should share one native fetch path with the same redaction and limits.
5. **Skill and standards.** The `xtream-provider` skill digest (skills/) already covers credential redaction and backoff; add a player digest (scope-first errors, destroy-before-next, no two decoders) when B-170 is approved, so every implement and review prompt carries it.

## Checklist for the first player task
- Design note approved (B-170), with the protocol reconciliation above and the default chains and retry budgets (report, open question 11) as configuration, not code.
- Spike results recorded (B-171): MessagePort and origin values for packaged apps, AVPlay plane under a remote iframe, webOS Luna track selection, key routing including Back, MSE quota per device, hls.js and mpegts.js on Chromium 53.
- Tasks cut by the report's phases, with acceptance tests from its testing section (decision-table vectors, adapter conformance, teardown checks); critical-area routing (B-135) marks the supervisor, policy and protocol as critical.
