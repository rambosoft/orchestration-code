# Learnings from the first Unity game run (tile-merge-2048)

Analysis only, written 2026-10-26. Nothing in this note is implemented yet. Figures come from `data/artifacts/*/*/<stage>-<n>.json` and `npm run timing`; they are approximate (a timed-out attempt leaves a failure file, not a stage result).

## 1. What the run produced

16 tasks, 20 draft PRs, rule coverage 16/16, EditMode 141/141, PlayMode 213/213, AAB 21.1 MB. Not verified: any on-device behaviour (no phone enumerated), on-device performance, store requirements.

## 2. Where the time and tokens went (game tasks, 14 measured runs)

| Item | Approx. value | Reading |
| --- | --- | --- |
| Implement (Claude) agent time | ~360 min | 60% of all agent time; 20-43 min per task from task 6 on |
| Verify (orchestrator gate) time | ~155 min | runs the same suites the agent already ran |
| Review verdict `needs_changes` | 15 of 37 reviews (41%) | each costs a second implement + verify |
| Cache-read tokens | ~51 M | 1-9 M per task, grows with repo size |
| Output tokens | ~360 k | small; cost is context, not generation |
| Wall clock vs busy | tasks of 447 and 502 min wall for 56 and 33 min of work | waiting on humans, locks, restarts |

Task wall time grew with the project: 3-8 min for the early dino/bug flows, 20-30 min for tasks 4-9, 50-90 min for tasks 10-16. The suite grew from 63 s (task 5) to 6 min (task 11) and the agent re-ran it after each small fix (FM-052).

## 3. Root causes, grouped

A. Environment (not model) failures, FM-046..056: licence, long paths, open Editors, locks, noise, missing test framework. All were found by a failure, not by a preflight.
B. Gates that passed while the product was incomplete (FM-050): tests green, review found Continue not wired, blank screenshots, placeholder screens. Mitigated by criterion traceability; still no check that a task is reachable from the running app.
C. Control-plane coupling to Paperclip (FM-053, FM-054, FM-037): manual done, comments waking agents, execution locks, reconcile job that never ran.
D. Repeated work: last-stage failure repeats everything (FM-055, now resumable by hand), implement and verify run the same suite, each review round reloads the whole context.
E. Publishing hygiene: 757 build-temp files (`.utmp/`, 29.8 MB) reached `main` because `findPublishViolations` has no generated-output list per stack. Stacked draft PRs merged bottom-up left later tasks stuck.
F. Reuse: every game rebuilt app shell, save, settings, audio, screenshot capture from scratch (see the feature library direction in memory).

## 4. Principles that fit this system

1. Temporal is the source of truth; Paperclip is a projection that must converge by itself. No human step should be needed to keep state consistent.
2. Shift checks left and make them cheap first: static, then EditMode, then affected PlayMode, then full suite once, then LLM review last, on evidence.
3. Every failure gets a class (environment, transient, gate, model, plan) and each class has an automatic policy (heal, retry once, repair pass, escalate, replan).
4. Prove integration, not units: each task ends with a vertical-slice check that the feature is reachable from the real entry point.
5. Pay for context once: bounded context packs, stable prefixes (cache), diffs instead of whole files, reuse of vetted code instead of regeneration.
6. Humans approve decisions (scope, design, merge), never mechanics (status, locks, retries).

## 5. Recommendations, by value and effort

Tier 1, high value, small to medium:
1. Preflight gate before a project starts and per worker boot: licence, adb/device (optional), short worktree root, Android SDK/JDK, disk, orphan Editors; auto-fix what is safe (stop Editors, clear stale locks), block the rest with one clear message. Extends `doctor`.
2. Publish guard per stack profile: deny build output and caches (`.utmp/`, `Library/`, `Logs/`, `Builds/`, `*.aab`, `UserSettings/`) and verify `.gitignore` in the scaffold. Closes E.
3. Failure classifier + auto-resume: infra/transient failures resume automatically (once, then escalate); a failing final gate gets one bounded repair pass with the diagnostics instead of failing the run (needs `patched()` and a regenerated replay fixture).
4. Reconcile as a real service (worker-hosted loop or Windows scheduled task with a heartbeat shown in `doctor`), idempotent, plus the publication marker written by the adapter so dependents never see "done without marker".
5. Run each suite once per task: the implement agent iterates with filters, the verify gate runs the full suite and its result is reused by the review; skip duplicate runs when the tree hash is unchanged.

Tier 2, high value, medium to large:
6. Vertical-slice gate: a template PlayMode test that boots the real scene, navigates from the entry screen to the task's feature through the UI, and fails on exceptions or a blank frame; tasks must register their entry path. Targets B.
7. Review that costs less and catches more: feed it the contract, the criteria table with the test that covers each, the diff and the screenshots; make the cheap deterministic prefilter (criteria mapped, rules covered, no placeholder strings/TODO, screens have non-trivial captures) fail before any LLM review.
8. Milestone integration branches and one PR per milestone from the tip (or top-down merge), so humans merge once and nothing is stranded.
9. Token budgets and accounting per task and per stage (B-035/B-026/B-016 in the backlog): soft limit with a warning, hard limit that pauses for a decision, cache-hit reporting in `timing`.

Tier 3, strategic:
10. Unity feature library per the agreed direction (own repo, copy-in with lock file, shared contract): first candidates from this project are app shell + navigation, save/load with versioning, settings, audio manager, screenshot capture, haptics, localisation scaffold. Biggest token saver for the next games.
11. Device track as an explicit optional stage: install the AAB through adb, launch, capture logcat and a perf snapshot when a device is attached; otherwise record device-only criteria as a checklist for the human. Do not block on it.
12. Eval harness (B-029): replay a recorded Unity run's inputs through the fake provider and the gates after every orchestrator change, so regressions in the gates show before a live run.

## 6. Suggested order

1 then 2 then 5 (quick wins, mostly in activities, no workflow change); 3 and 4 next (needs `patched()` and replay fixture); 6 and 7 together; 10 once the first feature set is chosen. Decide device handling (11) after the phone is detected.

## 7. Tier 1 plan (recommendations 1, 2, 5), no workflow change, replay fixture unchanged

All three live in activities and helpers, so no `patched()` and no new workflow step.

### 1. Preflight with safe auto-fix (`src/preflight.ts`)
- `unityPreflight(projectRoot)` runs at the start of `prepareProjectDependencies` for a Unity worktree, before the import: stops Editors that hold the worktree, waits for `Temp/UnityLockfile` and removes it when nothing holds it, fails closed (non-retryable) when the worktree path is too long for an Android IL2CPP build (FM-047, limit 90 characters) or the disk has less than 15 GB free. Returns what it fixed and the problems; the summary of the activity lists the fixes.
- `doctor` gains `unity:disk`, `unity:worktree-path`, `unity:editors` (warn: Editors running that are not a task's), `unity:adb` (warn: no adb, device stage unavailable).
- Tests: path-length boundary, disk threshold, stale lock removed, lock that cannot be removed is reported, Editors stopped are listed as fixes, no fix needed returns empty, doctor checks for each branch, `prepareProjectDependencies` fails with the preflight message and passes the fixes through.

### 2. Publish guard per stack (`src/stack-profiles.ts`, `src/workspaces.ts`)
- `isGeneratedPath(profile, path)`: for `unity-mobile`, Library, Temp, Obj, Logs, UserSettings, Builds, MemoryCaptures, Recordings, `.utmp`, `.gradle` at any depth, `*.apk|aab|keystore`, `*.csproj|sln`. `node-web` has none (no behaviour change).
- `publishWorktree` detects the Unity project from the worktree (as `detectUnityProject` does), and after `git add --all` removes from the index every generated path that this run ADDED (diff filter A against the base; paths already tracked in the base are never touched). It forces the commit when it changed the index, and reports `excludedGenerated` (count and sample) on the result and in the PR body. Nothing fails the run: dropping is cheaper than a failed publish at the very end.
- Tests: pattern table (matches and non-matches such as `Assets/Library.cs`, `Assets/Builds.md`), agent-committed generated files are removed from the branch, a tracked base file is left alone, node project unchanged, PR body mentions the exclusion.

### 5. Run the suite once per unchanged tree (`src/quality-cache.ts`, verify in `src/activities.ts`)
- Fingerprint of the working tree = hash of every non-ignored file (`git ls-files --cached --others --exclude-standard` plus content hash). A passing quality run stores its checks, the command key and the fingerprints before and after the run in `quality-pass.json` of the run folder (survives `resume-run`, which reuses the run id).
- The verify activity reuses a stored pass when command key and fingerprint match: the check loop is skipped, results are reported with duration 0 and a warning "reused". The acceptance trace still runs. Failures are never cached. `ORCHESTRATOR_QUALITY_REUSE=0` turns it off.
- Honest scope: the repair round changes files, so it still re-runs; the saving is activity retries, resumes, no-op repair rounds and a re-verify after a timeout. The bigger lever on suite time (the agent re-running everything) is guidance and the affected-tests strategy that already exist.
- Tests: same tree reuses, changed file / changed command / failed run does not, after-run fingerprint matches (generated `.meta`), ignored files do not change the fingerprint, switch off, corrupt cache file ignored.

## 8. Status of the recommendations (2026-10-26)

| # | Recommendation | State |
| --- | --- | --- |
| 1 | Preflight with auto-fix, doctor disk/path/Editor/adb | done (B-062) |
| 2 | Publish guard for generated output per stack | done (B-062) |
| 3 | Failure classifier, auto-resume, gate repair pass | done (B-057, B-063): `src/failure-class.ts`, `repairGate` in the workflow behind `patched("gate-repair")`, resume by the reconcile service |
| 4 | Reconcile as a service | done (B-063): runs in the worker, heartbeat checked by doctor |
| 5 | Run a suite once for an unchanged tree | done (B-062) |
| 6 | Vertical-slice gate | done (B-064): standing criterion, `sliceProblem`, template `SliceHarness.Boot()` compiled and run in a real Editor |
| 7 | Cheaper, sharper review | done (B-065): prefilter in verify, criteria coverage table in the review prompt. Not done: a cheaper review model tier |
| 8 | One PR per milestone | done (B-066) as `npm run stack-pr` (retarget the tip, optional close of intermediates); an integration branch per milestone was not built |
| 9 | Token budgets and accounting | done (B-079): `npm run usage`, manifest `budget`, `resume-run --budget` |
| 10 | Unity feature library | design only (ADR 0014, another session) |
| 11 | Device stage | not started; adb detection in doctor only (the phone is still not visible to Windows) |
| 12 | Eval harness | not started |

Not verified live: none of 3 to 9 has run on a real Unity task yet; each is covered by unit and workflow tests, the slice harness by a real PlayMode run on a copy of the finished game, and the reconcile service by its first real cycle in the worker.

## 9. Input and output trimming (2026-10-26)

Measured from the stored artifacts of the first game, not assumed:

- **The review saw build output, not code.** The 16 task patches average 904 000 characters; 44% is object files, 17% PNG, 4.7% C#. The review diff was the first 60 000 characters of `git diff --binary`, sorted by path, so `.utmp/` filled it. 13 of 16 diffs were over the cap. Fixed by the review digest (B-080).
- **Stage outputs were already small** (1 to 3 thousand characters per stage); output terseness is not where the tokens go. Cost units split: cache read 57%, cache write 22%, output 20%.
- **A failing check kept the first 5 000 characters** of its output, where a runner prints its failures last. Gate output is now captured whole and compacted (B-081), and a test report leads with the failing tests (B-082).
- **Tools:** Graphify (code knowledge graph) is not adopted: our cost is the context an agent re-reads, not searching a 200-file game, and a controlled study reports more tokens with a structural graph. rtk is already installed and now used through `rtk err`; `rtk test` is not (it dropped a FAIL line on an unknown runner). Everything new is stack-agnostic: one table in `src/stack-traits.ts`.
