# ADR 0019: A stage route can list fallback providers for a usage limit

Status: Accepted (2026-10-30). Part of the v2 plan, section 3.5 (docs/engineering/research/orchestration-v2-redesign.md). Extends ADR 0016.

## Context
- ADR 0016 makes a usage limit a durable pause: the stage waits for the reset and runs again on the same provider. That is right for the Unity implement stage (only Claude can build it, ADR 0014) and wrong for a stage that another provider can do, e.g. a Codex review while the free tier is spent.

## Decision
1. A route in `providerRouting` (project manifest and `bootstrap.global.json`) may carry `fallback`: up to three routes (`provider`, `model`, `reasoningEffort`) tried in order.
2. When a stage hits a **quota** pause and its route has a fallback left, the stage runs again at once on the next route, with a warning in the final message ("... continues on codex"). A lost connection never falls back: it is not the provider's fault, so the stage waits for the network as before.
3. A provider that hit its limit in this run is skipped first by the later stages of the same run (no second failed call per stage).
4. A route without `fallback`, a stage whose caller chose its own provider, and the Unity implement route in the shipped manifests keep waiting. Nothing is configured by default: a fallback spends the other provider's quota, so the operator opts in per stage.
5. Replay safety: the switch is under `patched("provider-fallback")` and only on the pause path; recorded runs replay unchanged.

## Consequences
- With Claude Pro and Codex free, `review: { provider: "codex", fallback: [{ provider: "claude" }] }` keeps a run moving past an exhausted Codex tier; `implement` stays on Claude and waits.
- The fallback provider may produce a different style of answer; structured stages still go through validation and repair.
- Not built: session resume after a pause or repair (the CLIs run `--ephemeral` today; resuming needs captured session ids and a worktree-state check), and a fallback after a quota pause is exceeded.
