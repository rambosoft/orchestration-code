# Orchestration v2: analysis, root causes and redesign plan

Status: PROPOSAL, nothing implemented. Written 2026-10-30 after reviewing commits since the Tile Merge 2048 pause (B-056 .. B-087), the uncommitted working tree, the docs, and the live run evidence in `data/logs` and `data/artifacts`.

## 1. What I reviewed

- 60 commits (10-23 .. 10-26) and the 36 uncommitted modified files plus 4 untracked (`src/provider-policy.ts`, `src/resume-config.ts` and their tests).
- `STATUS.md`, `BACKLOG.md` (B-001..B-087), ADRs 0001..0014, `failure-modes.yaml` (65 entries), `git-history.md`.
- `src/workflows.ts`, `providers.ts`, `failure-class.ts`, `reconcile.ts`, `server.ts`, `client.ts`, `profiles.ts`.
- Activity log (3575 events), `npm run timing`, `npm run usage`, and the artifacts of the last live task (Cinderfield, task `00e09cd3`).

Not verified: I did not run the full 150+ test suite, did not read all 8.6k source lines, and no Minesweeper project exists yet (no manifest in `projects/`). Typecheck and the replay test pass on the current working tree.

## 2. Why it became unusable: root causes, with evidence

### RC-1. The global "force Codex" switch (B-087, uncommitted) broke implementation
- `ORCHESTRATOR_FORCE_CODEX=1` is the default in `docker-compose.yml`, `.env.example`, `server.ts` and `client.ts` (`enforceProviderPolicy`). It rewrites every stage of every manifest, including `implement`, which had been Claude.
- Cinderfield task `00e09cd3`: Codex implement ran three rounds and changed **zero files**. Its own summaries: "`openspec` is not available in this shell, no Unity CLI tool is exposed", "Unity exited 198 because no usable Editor entitlement". Claude has explicit `Bash(unity:*)` allow rules (`providers.ts:96`); Codex runs in a `workspace-write` sandbox that cannot reach the Unity licensing client.
- The review correctly said "implementation absent". The run then looped (resume1, resume2 ...) re-running the same failing stages.
- The trigger was one flaky free OpenRouter review model returning empty text. The response was a bridge-wide kill switch instead of a per-stage fallback. That is the wrong shape: policy was welded into code.
- It also contradicts your requirement (Claude implements, Codex does the rest).

### RC-2. Too many model stages before any code is written
Per task today: `openspec` (LLM) -> `spec_optimize` (LLM) -> `analyze` (LLM, optional) -> `plan` (LLM, up to 2 repairs) -> `brief` (LLM, up to 2 repairs) -> `implement` -> `verify` -> `review` (+ repair rounds) -> OpenSpec archive.
- Cinderfield produced `plan-1..3` and `brief-1..3` (repairs) and a 12 KB OpenSpec context, 11 KB analysis, 10 KB brief for "a first-launch screen" before the implementer saw anything.
- The implementer is then told to follow the OpenSpec *apply* workflow, which needs the `openspec` CLI. Codex did not have it on PATH, so the uncommitted diff adds a PATH hack in `cliProviderEnvironment`. Process overhead became a failure source.
- Measured (activity log): openspec 97 min, plan+brief+analyze+spec_optimize ~52 min, review 44 min, against implement 654 min. On small tasks the pre-implement chain costs as much as the implementation (already recorded in STATUS 10-25, B-058 was never built).
- Review runs on every task regardless of project maturity (your point about the prototype).

### RC-3. A workflow change without `patched()` (violates the hard rule in CLAUDE.md)
- Uncommitted `workflows.ts`: `verify` and `review` used to run concurrently (`Promise.all`); now sequential. No `patched()`. The command sequence changed, so any in-flight run paused at that point can fail replay with a non-determinism error. The replay fixture still passes, which means the fixture does not cover this path (a gap in the safety net).
- Side effect: every task now waits for the slow Unity verify before review even starts.
- The same diff also changes review-blocker handling (external prerequisite no longer masks code-fixable findings), also unguarded.

### RC-4. Gates that the agent cannot satisfy are treated as "repair the code"
- Cinderfield verify failed on `acceptance-trace` / hygiene: two `.meta` files missing. Only the Unity Editor can generate them; the agent (correctly) refused to hand-write GUIDs. The gate repair pass cannot succeed, so it burns a model call and the run fails again. The classifier labels this `gate -> repair` from regexes over message text.
- 16 `rule-trace` warnings are dumped into the gate output on every attempt (token noise).
- Failure classification is regex over free text (`failure-class.ts`). Any new message wording silently falls to `unknown -> escalate`.

### RC-5. No real handling of provider limits and connectivity loss
- Activity retry policy: `maximumAttempts: 2`, 1-15 s backoff (`workflows.ts:23`). A Claude/Codex usage-limit message ("limit reached, resets at ...") or a dropped connection is classified only by `429`/`ECONNRESET` regexes. Otherwise it is a `provider_error`.
- Auto-resume: at most **one** resume per run, only within 360 minutes. A five-hour quota window or a long outage exhausts that and the task needs a human.
- No pause state, no wake-at-reset time, no connectivity probe, no progress watchdog (a hung CLI is only caught by the full stage timeout, 30-120 min).
- CLI sessions are `--ephemeral` and every repair round is a cold start with the whole prompt. Measured cache hit on earlier runs: 3-9% for most tasks.

### RC-6. Paperclip is both the board and a stateful execution hop
- Most "recovery" machinery exists because a multi-hour run is held by an adapter lease: lost adapter, "execution reconciliation hold", `executionBlocker`, `recovery_needed`, dependency-wake races. `reconcile.ts` now encodes Paperclip internals (`legacy_execution_requires_reconciliation`, publication markers, blocker edge re-assertion).
- Live symptom now: the worker console log is flooded every 3 minutes with `dependency_ready_recovery_required` for LOC-12 and LOC-93 (nobody acts on it), and the log file is UTF-16 so it is hard to grep.
- Temporal is the source of truth for run state; Paperclip should be a projection of it, not a co-owner.

### RC-7. Observability and tests are polluted
- Unit tests write into the live `data/logs/worker-activity-events.jsonl` (`runId: "r"`, `"t"`, `"quality-failure"`). `npm run timing` shows `verify` 213 failures of 563, and phantom tasks with a "wall time of 4266 minutes". The reports that drive tuning decisions are wrong.
- Usage reports cannot yet be compared run to run because stages do not record a stable "pipeline version".

### RC-8. Accretion and documentation drift
- 13 `patched()` flags, a 708-line workflow with one giant function, 17 stage names, 65 failure modes, 87 backlog items, 14 dated STATUS sections. The decision logic is spread across `workflows.ts`, `activities.ts`, `failure-class.ts`, `reconcile.ts`, `server.ts`, `bootstrap-options.ts`.
- Docs disagree: `git-history.md` still opens with the original baseline snapshot, STATUS says B-087 "temporary", config docs say Codex for all, CLAUDE.md says Claude implements. No single "how a task flows today" page.
- Working tree has ~670 uncommitted lines mixing good fixes with the bad ones above; `Logs/`, `build-paperclip.log`, `stack-up.log`, `landing-page-review.png` sit in the repo root.

### What is good and should be kept
Temporal as lifecycle owner, per-run git worktrees, clean-git admission, deterministic gates, draft PRs, structured-stage validate/repair/fallback, stage result reuse on resume (measured working), publish guard, `childEnv` secret isolation, token accounting, review digest, log compactor, stack-traits table, the resume-config idea (re-read manifest on resume), the `prepareWorktree` ancestor check, adapter-resilience tests.

## 3. Target architecture

### 3.1 Principles
1. **Policy is data, execution is generic.** One deterministic workflow interpreter runs a pipeline *spec*; no stage logic hard-coded per task type.
2. **Capabilities, not names.** Stages declare what they need (`write-files`, `host-tools:unity`, `read-only`, `vision`). Providers declare what they offer. Routing = ordered fallback chain filtered by capability. A provider that cannot do the job is never selected (Codex cannot be picked for Unity implement).
3. **Pay for a stage only when it earns its keep.** Lane x tier decides the stage list, with deterministic escalation.
4. **Every failure has a class and a durable response.** Wait, resume, heal, repair, fall back, or ask a human. No regex-on-prose as the only signal.
5. **Temporal is truth, Paperclip is a projection.**
6. **Change safety is automated**: determinism guard + golden stage sequences, so a future edit cannot silently change behaviour.

### 3.2 Pipeline as data (replaces ad-hoc stage lists and profile table)
```
pipelines/<version>.json (bundled, versioned; the version is stored in the workflow input)
 lane:  light | standard | heavy | bug | research | architecture | bootstrap | onboard
 stage: { id, when(expr over task/stack/tier/risk), provider chain, model tier, reasoning effort,
          timeout, token budget, retry class, on_fail }
```
- `pipelineVersion` is recorded at start. In-flight runs finish on their version; new runs get the new one. This replaces the growing `patched()` list: one `patched("pipeline-v2")` at the entry, the old path frozen as `legacyWorkflow`.
- Adding a stack, a stage or a lane = data plus a golden test, not a workflow edit.

### 3.3 Lanes and tiers (answers "too many stages", "no review per task on a prototype")

| | prototype | standard | production |
|---|---|---|---|
| light task | implement -> verify(build+smoke) -> publish | same + review only if escalated | + review |
| standard task | task prompt as brief -> implement -> verify -> publish; one **milestone review** | plan(+brief merged) -> implement -> verify -> review | + analyze when touching shared contracts |
| heavy task | plan -> implement -> verify -> review | + analyze | + spec per milestone, security preset, CI feedback |

- **Spec/OpenSpec**: per milestone/feature at most, production tier only (or on demand). Never per light task. The implementer is never required to run a spec CLI.
- **plan+brief**: one call; the "brief" is produced deterministically from the plan (the compaction code already exists). Blueprint tasks already carry numbered acceptance criteria, so for prototype/light the *task text is the brief*.
- **Deterministic escalation**: after implement, if the diff touches > N files, touches auth/data/migration paths, a gate needed a repair, or tests were removed -> add `review` for this task even on prototype.
- **Milestone review** (prototype): one Codex review of the milestone's integrated diff digest instead of one per task.
- Lane is chosen by the blueprint (size/risk per task, already generated) with a manifest override.

### 3.4 Provider routing and defaults (your requirement)
- `implement`: Claude. `plan, brief, analyze, spec, review, verify-assist, diagnose, reproduce, scope, explore, stack, charter, blueprint, design`: Codex.
- Fallback chain per stage, declared in the manifest, e.g. review: `codex -> claude(low effort) -> deterministic-only + flag`. Free OpenRouter models are removed from defaults (kept as an opt-in provider).
- Implement fallback is per stack: `unity` = **none** (wait for Claude), `node/spring/angular/react` = optional Codex after a configurable wait.
- Model tiers: light lane and repair rounds on a cheaper Claude tier, heavy lane on the strongest; structured stages on low reasoning effort.
- Delete `ORCHESTRATOR_FORCE_CODEX`; nothing global overrides manifests. A *policy file* (data, versioned) can override per environment and is logged on every run.

### 3.5 Resilience layer ("ProviderGate")
Classify provider/CLI outcome into: `quota(resetAt?)`, `network`, `auth`, `environment`, `content`, `timeout/stall`, `crash`. Use exit code and structured CLI error events (Codex `--json` error items, Claude JSON `is_error`/`subtype`) first, regex second.
- **quota / network**: the activity returns a non-failing `PAUSE` result; the workflow sleeps on a durable Temporal timer (until `resetAt`, else exponential backoff 1 -> 30 min with jitter), a cheap connectivity probe activity gates the wake-up, then **retries the same stage without consuming retry attempts**. State is visible as `paused: waiting for network/quota until HH:MM`. Optional fallback to the next provider after a configured wait.
- **stall watchdog**: heartbeat carries last-output time; no output for N minutes (per stage, default 10) -> kill tree and retry once from the checkpoint.
- **checkpoints**: stage results (already persisted) + implement WIP commit in the worktree at each agent turn boundary; on retry the agent continues with `claude --resume <session>` / `codex exec resume` and a 3-line "continue" prompt instead of the full cold prompt (also the main token saver for repair rounds).
- **auth**: stop with a clear "log in again" status; resumes when the operator signals.
- The single `MAX_AUTO_RESUMES = 1` rule becomes a per-class budget (quota/network unlimited within a max total wait, environment 2, gate repair 1, model 1).

### 3.6 Gates
- Each gate declares `kind`: `blocking | advisory | auto-fix`, and an owner: `agent-fixable | orchestrator-fixable | human`.
- Missing Unity `.meta` files, stale locks, missing generated files = **orchestrator-fixable** (run the Editor import deterministically, then re-check). They are never sent to the agent.
- Rule-trace/hygiene warnings collapse to one summary line.
- Gate order is cheap-first, fail-fast (lint/hygiene -> unit -> build -> UI/Play). Reuse of an unchanged passing result stays.
- Verify and review stay concurrent where they do not contend (non-Unity); serialized only for stacks whose profile says `exclusiveHost: true`.

### 3.7 Stack packs (Unity, Spring Boot, Angular, React first; easy to add more)
A stack is a folder `stacks/<id>/` with `stack.json`: detection rules, install/build/test commands, report parsers, command allow-list, capability needs (`host-tools`), gate preset, digest globs, review checklist, scaffold template, agent guide snippet, default lane overrides. Today the same knowledge is spread over `stack-profiles.ts`, `stack-traits.ts`, `game.ts`, `unity.ts`, `bootstrap-*.ts`. Consolidate behind one schema + conformance test.

Project start modes, all on the same engine: `bootstrap` (from scratch), `onboard` (existing repo: detect stack, record baseline test status, write the contract), `single-task` (light lane against an existing repo, no bootstrap), `continue` (resume the milestone chain).

### 3.8 State and Paperclip
- The workflow's last step is an idempotent `reportResult` activity (retries, outbox record) that posts the comment/status to Paperclip. The adapter starts runs asynchronously and does not hold a lease for hours.
- `reconcile.ts` shrinks to a small backstop: compare Temporal vs Paperclip, repair drift. Its Paperclip-internal heuristics are retired once the outbox exists. Findings that need a human are deduplicated (once per state change, not every 3 minutes).
- Worker log becomes UTF-8 JSON lines with rotation.

### 3.9 Token optimization (beyond what is already built)
1. Skip stages (3.3): removes 3-5 model calls on light/standard tasks.
2. Session resume for repair rounds and "continue after pause".
3. Stable prompt prefix (project contract + stack guide first, task last) so provider caches hit; drop `--ephemeral` where resume is used.
4. Cheaper model tier for light/repair/structured stages; reasoning effort per stage.
5. Review sees the digest, not the diff (exists); milestone review for prototypes.
6. One answer-shape/size rule per structured stage (exists); deterministic fallback preferred over a second repair call when diagnostics are mechanical.
7. Per-stage and per-task budgets with a warning at 70% and a durable pause at 100% (not a hard failure) in prototype tier.
8. Graph/code-index tooling only as a measured pilot on large brownfield repos.

## 4. Test strategy: few, deliberate, change-catching (about 25 tests, not hundreds)

Keep unit tests that protect pure logic with real defects behind them (schemas, publish guard, log compactor, worktree git). Add/curate these cross-cutting ones:
1. **Golden stage sequences**: for each lane x tier x stack, the exact stage list produced from a manifest (table test). Any change shows as a diff in review.
2. **Determinism guard**: replay fixtures per `pipelineVersion` (light, standard, heavy, bug, bootstrap). A hash of each golden command sequence must change only together with a version bump.
3. **Routing conformance**: for every manifest in `projects/` and every stack pack, `implement` resolves to a provider that has the required capabilities; no stage resolves to a provider without credentials; no global override path exists.
4. **Failure matrix** (fake provider injections): quota with resetAt, quota without, network loss mid-implement, CLI stall, auth failure, malformed structured output, empty review, gate failure agent-fixable, gate failure orchestrator-fixable, environment (licence/lock). Expected: pause/resume/fallback/repair/escalate and **no work repeated** (stage reuse asserted).
5. **Crash/restart**: worker killed between stages and mid-activity; resumes without duplicate PR or lost worktree.
6. **Real-git integration**: admission, worktree, integration base, publish, stacked branches.
7. **Pipeline smoke per stack pack** with the fake provider against a tiny fixture repo (build/test command wiring, report parsing).
8. **Pause/budget semantics**: budget at 100% pauses, resume with new budget continues.
9. **Projection**: outbox posts exactly once, survives Paperclip downtime.
10. **Test isolation**: tests run with `ORCHESTRATOR_DATA_DIR` in a temp dir; a guard test fails if a test writes to the live log.

Rule change proposal (needs your approval): CLAUDE.md says "never delete tests". Consolidating duplicates (72 files) is only done with coverage preserved and listed in a mapping table; nothing is dropped silently.

## 5. Roadmap (each item ends with tests, build, doc update)

- **P0 Stabilize (first, small)**: remove the `ORCHESTRATOR_FORCE_CODEX` default and restore implement=Claude in `bootstrap.global.json`/manifests; triage the uncommitted diff (keep: resume-config, workspace ancestor check, adapter-resilience, OpenRouter image support; rework: serial verify/review behind `patched()` or revert; external-blocker change behind `patched()`); redirect test logging to temp; dedupe reconcile spam; clean root stray files; cancel stale runs (LOC-12, LOC-93, Cinderfield) or resume them on the legacy path.
- **P1 Resilience layer** (3.5) with the failure matrix tests.
- **P2 Pipeline interpreter + lanes/tiers** (3.2-3.4), `pipelineVersion`, replay fixtures, golden tables.
- **P3 Gates and stack packs** (3.6-3.7): Unity `.meta` auto-fix first, then Spring Boot, Angular, React packs.
- **P4 Projection/outbox** (3.8), reconcile reduction.
- **P5 Docs and test curation**: one `docs/architecture.md` "how a task flows", ADR 0015 (v2), ADR 0016 (resilience), archive old STATUS history, update CLAUDE.md, failure modes merged by class.
- **P6 Acceptance**: build Minesweeper end to end unattended; record stage count, tokens, wall time, failures; compare with the Cinderfield/2048 baselines (about 640k units per task).

## 6. Risks
- The pipeline interpreter is a large refactor of the most fragile file. Mitigation: legacy workflow frozen, new one behind one patch marker, golden/replay tests first.
- Session resume behaviour differs per CLI version; needs a spike with the pinned Claude and Codex versions.
- Quota messages are not a stable API; keep structured detection first and add a generic "provider said wait" path with backoff.
- Removing Paperclip lease dependence needs an adapter change in a third-party system; spike required.
