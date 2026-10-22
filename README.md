# Paperclip + Temporal local orchestration

For the day-to-day project, task, run, output-inspection, and recovery workflow, see [the operator guide](docs/operator-guide.md).

This project connects Paperclip task management to durable Temporal workflows. Paperclip runs a small external adapter; Temporal owns retries, waits, cancellation and workflow identity. A Windows worker invokes provider CLIs, keeping their existing login state out of containers and workflow inputs.

## Requirements

- Windows 11 x64, Git, Node.js 22+, npm and Docker Desktop with Linux containers enabled.
- A provider CLI login for real agent execution. The deterministic `fake` provider needs no paid account.
- A clean, committed GitHub checkout with a configured target branch and `gh auth login` for implementation workflows. The owner must commit the baseline first; the orchestrator never stages the input checkout.

## Setup and start

```powershell
.\setup.ps1
npm run stack:up
npm run worker
```

To keep the local Windows worker available between sessions, register the hidden sign-in task once:

```powershell
npm run worker:install
```

It runs under the signed-in Windows account so provider CLI credentials remain available, restarts after unexpected exits, writes structured Activity events to `data/logs/worker-activity-events.jsonl`, and appends host process output to `data/logs/worker-console.log`. A worker already running in the current session is left alone; the scheduled task manages subsequent sign-ins. Set `ORCHESTRATOR_QUEUE_WAIT_ALERT_MS` in `.env` (default `60000`) to emit a structured warning when an activity waits that long for a worker.

Paperclip is at <http://localhost:3100>, the Temporal UI at <http://localhost:8233>, and the local orchestration bridge health endpoint at <http://localhost:3101/health> (requires its bearer token). The Paperclip and Temporal browser interfaces bind to localhost only.

Create a Paperclip account and organization at <http://localhost:3100/auth>. The adapter is loaded from the mounted path `/opt/paperclip-adapter`; if it is not listed, install that local directory from Settings → Adapters.

For task comments, completion status, and the Windows worker's dependency recheck, create a board API key scoped to the demo company and add it to `PAPERCLIP_API_TOKEN` in the ignored `.env` file. Set `PAPERCLIP_API_URL=http://127.0.0.1:3100`. Recreate Paperclip after changing `.env` with `docker compose up -d --force-recreate paperclip`, then restart the Windows worker. The Paperclip connection secret is not used as the worker credential.

Copy `.env.example` to `.env` and set `OPENROUTER_API_KEY` to your OpenRouter key (for example, `Copy-Item .env.example .env; notepad .env`). The Windows worker reads this setting from `.env`; it is not passed to Docker, Paperclip, Temporal workflow inputs, or artifacts. Restart the Windows worker after changing the key. Do not put the key in the Paperclip connection or agent configuration.

Create an agent using adapter type `temporal_orchestrator`, bridge URL `http://orchestrator:3101`, project ID `demo-typescript`, profile `research` or `implementation`, and heartbeat enabled. Provider/model selection comes from the project manifest: `plan`, `research`, `review`, and provider-assisted `verify` use OpenRouter `minimax/minimax-m3.1-flash:free`; `implement`, including review repair, uses the authenticated Codex CLI on the Windows host. Deterministic quality commands run locally before provider-assisted verification. Set `requireApproval` to `false` for the first smoke run. Assign a task to this agent; assignment triggers the Temporal workflow automatically. For implementation tasks, the manifest’s acceptance command is intentionally strict and can fail on the seeded demo until the requested feature is implemented. OpenRouter free-model requests can be rate-limited; the workflow retries within its configured Activity bound and then reports the error rather than falling back to fake. Codex login alone does not guarantee CLI execution; test your installed `codex exec` invocation before assigning real implementation work.

In a second PowerShell terminal:

```powershell
npm run demo
npm run runs
npm run dev -- inspect <workflow-id>
npm run dev -- cancel <workflow-id>
npm run dev -- approve <workflow-id>
npm run dev -- approve <workflow-id> reject
npm run dev -- resume project.example.json <task-id> <same-revision> "Repeat the task"
npm run dev -- restart project.example.json <task-id> <new-revision> "Retry with a fresh workflow"
npm run demo:validate
```

The direct CLI uses the same Temporal queue as Paperclip. For a new individual task: `npm run dev -- run project.example.json "Describe the task and its acceptance criteria"`. `resume` attaches to an open workflow or retries a failed execution using its task/revision identity; use a new revision with `restart` after a completed or cancelled workflow.

## Tests and shutdown

```powershell
npm test
npm run demo:validate
npm run stack:down
```

`stack:down` stops containers but retains `data/`. `npm run reset:demo` resets only the disposable demo project data; it never removes Paperclip or Temporal state.

## Providers and ECC

Configure `providerRouting` per stage in the project manifest. Supported routes are `fake`, `claude`, `codex`, `gemini`, and `openrouter`; OpenRouter routes require a model ID. Provider keys are resolved inside the host worker and are never workflow parameters. Implementation stages use one isolated Git worktree from a recorded base commit; after review and deterministic checks pass, the worker commits, pushes, and creates a draft PR with `gh`. It never merges automatically. `Done` means the gates passed and a draft PR was confirmed. OpenRouter receives only the stage prompt and model selection. Provider output is untrusted; only the selected stage provider receives the task prompt.

Install ECC once per harness using its supported installation method. Claude Code and Codex have different plugin lifecycle and scope semantics; see [ECC guidance](https://github.com/affaan-m/ECC). Record installed and discovered capabilities in `docs/validation-results.md`.

RTK command-output filtering is an optional project plugin for Codex implementation and repair stages. It is disabled in the example manifest. To enable it for a project, install RTK on the Windows worker, add and commit the project-scoped Codex hook with `rtk init --codex`, then set that project's `plugins` entry to `enabled: true`; see the [operator guide](docs/operator-guide.md#enable-rtk-command-output-filtering-for-one-project). This filters agent-visible shell output only; deterministic quality commands remain the acceptance gate.

## Recovery and troubleshooting

- Temporal server state is persisted at `data/temporal/temporal.db`; this local development server is not a production service.
- Paperclip PostgreSQL and local secrets are in `data/paperclip`; never commit this directory or `.env`.
- The bridge is reachable only inside Compose networking and listens on a localhost-published port for diagnostics. All bridge API calls require bearer auth.
- If the worker cannot connect, check `docker compose ps`, `TEMPORAL_ADDRESS=127.0.0.1:7233`, and the Temporal UI.
- If an agent task fails, verify that its CLI is on `PATH` and authenticated with the provider's official login command. Missing or unauthenticated providers are failures, not fake successes.
- Before assigning code work, configure `repository` in the project manifest (`remote`, `targetBranch`) and ensure the project checkout has no tracked or untracked changes. Admission fails before Temporal starts if the tree is dirty, the GitHub remote or branch is missing, or the manifest is incomplete. Existing untracked files are never copied or staged automatically.
- A dependent task stays undispatched while any Paperclip blocker is not `done`. Its predecessor must have a publication comment containing branch, head SHA, and draft PR. One blocker stacks from that exact published commit. Several blockers require `integratedBaseBranch` to contain every prerequisite commit; divergent branches are never merged silently.
- If the parent PR merges after a child draft PR exists, run `npm run dev -- sync-stack <worktree> <child-branch> <parent-pr-url> <target-branch> [remote]`. It checks the parent state, rebases the child and retargets its PR. A rebase conflict is left for human resolution.
- A retry uses a new Paperclip task revision or attempt identity; duplicate dispatches for the same identity attach to the existing workflow. Publishing failures leave the branch and evidence available but do not mark the issue Done.
- If an OpenRouter stage reports a missing key, set `OPENROUTER_API_KEY` in the ignored project `.env` and restart `npm run worker`. HTTP 401/403 indicates a key/account issue; HTTP 429 indicates OpenRouter rate limiting. The configured bounded Temporal retry runs before a terminal failure is reported.
- If Paperclip rejects the adapter's internal API call with an untrusted-host error, keep `PAPERCLIP_ALLOWED_HOSTNAMES: paperclip` in the Paperclip service environment and recreate that service.
- A failed or interrupted implementation worktree remains under `data/worktrees` for inspection. Do not auto-merge its patch.

## Extending the platform

Add project types as validated manifests and profiles. Add a provider by implementing `AgentProvider` in `src/providers.ts` with a documented, bounded CLI protocol and read/write permission distinction. Add an optional capability in `src/plugins.ts` with version, capabilities and health check; mark mandatory gates required in the project manifest. Keep domain-specific integrations outside the central Temporal workflow.
