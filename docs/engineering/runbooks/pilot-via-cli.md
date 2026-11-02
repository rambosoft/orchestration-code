# Runbook: run the existing-project pilot from the command line (no Paperclip)

Status: written 2026-11-02 for ADR 0032 to 0036 and `docs/engineering/research/existing-projects-roadmap.md`. The commands below use only things that exist today (`doctor`, `inspect-folder`, `onboard`, `e2e`, `timing`); steps that need unbuilt features are marked NOT BUILT.

## When to use this path, and when not
Use it for Phases 0 to 3 of the roadmap: the survey of `luxus-app`, the first tasks, the pilot of two pages and five components. It needs no Paperclip project, no wizard and no board issues, so nothing outside this repository and the target repositories can break the pilot.

Do not use it for Phase 4 (scale) or for production work: it has no board, no blocker re-check by Paperclip (blockers are the stacked branches you give it), and no approval gate. Switch to Paperclip once B-107 (wizard wiring) and B-109 (report to plan) are done and the pilot passed its go or no-go.

## Where things must live
The bridge container mounts only `ORCHESTRATOR_PROJECTS_ROOT` (currently `C:\workspace\orchestration-projects`) at `/workspace/projects`, and a manifest root must stay inside it. So:
- survey source: a clone at `C:\workspace\orchestration-projects\luxus-app` (your original `C:\workspace\luxus-app` stays untouched);
- new app: `C:\workspace\orchestration-projects\luxus-app-react`, local only until the pilot is judged good.
Set `ORCHESTRATOR_BROWSE_ROOTS` to the projects root for `inspect-folder`.

## 1. Preflight (every session)
1. `npm run build`, then restart the host worker (`scripts/run-worker.ps1`); restart the bridge if `src/server.ts`, `src/contracts.ts` or a manifest changed (`docker compose up -d --build orchestrator`). A stale worker silently runs old code. Details: `operate-and-e2e.md` section 2.
2. `node dist/src/cli.js doctor` (needs `ORCHESTRATOR_API_TOKEN` in the shell). Fix every error before going on.
3. Note the starting point: `node dist/src/cli.js timing --since <date of today>` (see "Watching consumption").

## 2. Put the source repository where the bridge can see it
1. `luxus-app` is committed locally (`858b4c22`) and clean. Push `main` yourself if you want the survey pull request to be based on it (the orchestrator never pushes `main`); otherwise the draft PR will include that commit.
2. Clone: `git clone C:\workspace\luxus-app C:\workspace\orchestration-projects\luxus-app`, then point `origin` at GitHub: `git -C C:\workspace\orchestration-projects\luxus-app remote set-url origin https://github.com/rambosoft/luxus-app`.
3. Windows clones of `luxus-app` show 37 image and video files as modified, because its `.gitattributes` (`* text eol=lf`) has no binary exclusions (B-148). In the pilot clone only, append binary rules to `.git/info/attributes` (`*.png binary`, `*.jpg binary`, `*.mp4 binary` and the other media types), then restore the working files from the clone's own repository (`git checkout -- .` run inside the clone). This does not touch the operator's repository.
4. Check admission: `ORCHESTRATOR_BROWSE_ROOTS=C:\workspace\orchestration-projects node dist/src/cli.js inspect-folder C:\workspace\orchestration-projects\luxus-app`. It must print `"ok": true`; it lists every problem otherwise (not a repository root, uncommitted changes, no `origin`).

## 3. Register the project
`node dist/src/cli.js onboard C:\workspace\orchestration-projects\luxus-app --name "Luxus App" --tier mvp` prints the manifest and notes; add `--write` to save `projects/luxus-app.json`. Read the notes: the stack is detected as a Node project and its quality commands come from the repository's scripts; a code task needs at least one. For the survey (read-only) the gates are not used. Restart the bridge so it loads the manifest (`docker compose up -d --build orchestrator`).

## 4. Run the survey
Write `survey.tasks.json` (any folder you like):
```json
{ "projectId": "luxus-app", "tasks": [ { "taskId": "LUX-SURVEY-1", "title": "Survey luxus-app", "prompt": "Type: survey\nMode: migrate\nSurvey this Nuxt 2 / Vue 2 TV app for a rebuild as a client-side React 19 + TypeScript + Vite app. Read AGENTS.md and the docs/ compatibility files first: they define the supported devices." } ] }
```
Run it through the e2e runner: `ORCHESTRATOR_API_TOKEN=... node dist/src/e2e.js survey.tasks.json --record docs/engineering/knowledge/metrics/runs/<date>-survey-luxus-app.json`.
- `Type: survey` (also `audit`) selects the read-only survey type; `Mode:` is `audit`, `maintain`, `refactor` or `migrate` and defaults to `audit`. Both lines are read from the prompt.
- The result is a draft pull request with `docs/survey/LUX-SURVEY-1.md`: modules, hotspots, duplicated logic, constraints from the repository's own docs, risks, a sized refactor backlog and a list of items that need a decision. Read it before anything else happens.
- The route-and-store inventory in the report is exact (counted from the files); the interpretation is the model's and must be reviewed.
- If the survey is unreadable twice, the report falls back to one backlog item per route and says so.

## 5. Turn the survey into pilot tasks (by hand until B-109 exists)
From the approved survey, write `pilot.tasks.json` for the new repository: first the scaffold task (Vite + React + TypeScript from the template; engineering standards, `AGENTS.md`, test and lint scripts), then one task per page or component, chained so each takes the previous published branch as its parent (the same format as `examples/dino-runner.tasks.json`). Pilot scope: pages `no-internet` and `blocked`; components `SettingsChevronRow`, `SettingsTextDisplay`, `SettingsSectionHeader`, `OverlayCloseButton`, `ProgressBarComponent`. Each task prompt states: the old file paths to read, the behaviour cases to keep (from the page document and the survey), the target structure, the rules it must follow, and the tests that must pass. NOT BUILT yet: the characterize stage, the parity gate, the migration gates and the standards pack (B-110, B-111, B-121, B-122); until then these requirements travel in the task text and the repository's `AGENTS.md`, and a person checks parity.

## 6. Reading results and failures
`GET /v1/runs/<workflowId>` gives `result.message` and `result.metadata`. Failure causes and first actions are in `operate-and-e2e.md` section 4. A survey that ends `exploration_failed` names the stage that failed.

## 7. Watching consumption (subscription use)
Cost in money is not the concern; large consumption by one task is. Until B-146 builds automatic highlighting:
1. After each batch run `node dist/src/cli.js timing --since <time>` and read the per-stage busy minutes, failures and the slowest tasks.
2. Flag a task by hand when any of these holds: busy time above three times the median of its kind, more than two repair rounds, a provider pause for usage limits (ADR 0016), or a stage that failed and was retried more than once.
3. For a flagged task record why in the run record's notes, and decide: shrink the task, add a recipe, tighten the prompt, or route it to a cheaper model. The first batch is the baseline; the second batch should be at least 30% lower in busy time (roadmap Q3).

## 8. Stop conditions
Stop the pilot and fix the orchestration when a run fails twice for the same orchestrator reason, a gate passes without evidence, a published branch contains files outside the task's area, or consumption of one task is far outside the pattern. Record the finding in `failure-modes.yaml` and the backlog before retrying.

## 9. Housekeeping
`node dist/src/cli.js cleanup --dry-run`, then `cleanup --days 7`. Never run `cleanup --all` while a run is active.
