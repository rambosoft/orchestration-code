import path from "node:path";
import { readFile } from "node:fs/promises";
import { ProjectManifestSchema } from "./contracts.js";
import { cancelRun, inspectRun, listRuns, signalApproval, resumeRun, startRun } from "./client.js";
import { syncMergedStack } from "./workspaces.js";
import { defaultDoctorDeps, formatDoctor, runDoctor } from "./doctor.js";
import { cleanupWorktrees } from "./cleanup.js";
import { formatTiming, parseEvents, summarizeTiming } from "./timing.js";
import { formatFindings, reconcile, type RunDetail, type RunRow } from "./reconcile.js";
import { paperclipClient, startReconcileService } from "./reconcile-service.js";
import { stackPr } from "./stack-pr.js";
import { formatDrain, waitForDrain } from "./drain.js";
import { admitRepository, taskBranch } from "./workspaces.js";
import { profiles } from "./profiles.js";
import { parseTaskDirectives, resolveOpenSpecEnabled } from "./openspec.js";
import { resolveProjectUiUx } from "./uiux-config.js";

const [command, ...args] = process.argv.slice(2);
const data = path.resolve(process.env.ORCHESTRATOR_DATA_DIR ?? "data");
async function loadProject(file = "project.example.json") { return ProjectManifestSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
async function startProjectRun(projectFile: string, taskId: string, revision: string, prompt: string) {
  const project = await loadProject(projectFile);
  const parsedPrompt = parseTaskDirectives(prompt);
  if (parsedPrompt.error) throw new Error(parsedPrompt.error);
  const projectRoot = path.resolve(project.rootEnv ? process.env[project.rootEnv] ?? project.root : project.root);
  const uiUx = await resolveProjectUiUx(project, projectRoot);
  const isCode = profiles[project.defaultProfile]?.stages.includes("implement") && project.providerRouting.implement?.provider !== "fake";
  let repository;
  if (isCode) {
    if (!project.repository) throw new Error(`project '${project.id}' needs repository.remote and repository.targetBranch before code tasks can run`);
    const admitted = await admitRepository({ projectRoot, remote: project.repository.remote, targetBranch: project.repository.targetBranch });
    repository = { remote: project.repository.remote, targetBranch: project.repository.targetBranch, branch: taskBranch(taskId, revision), baseSha: admitted.baseSha, prBaseBranch: project.repository.targetBranch, taskTitle: taskId };
  }
  return startRun({ taskId, taskRevision: revision, projectId: project.id, profile: project.defaultProfile, prompt: parsedPrompt.prompt,
    openSpec: resolveOpenSpecEnabled(project.openSpec.enabled, parsedPrompt.openSpec), analysis: parsedPrompt.analysis ?? project.analysis.enabled, analysisDocsDir: project.analysis.docsDir, uiUx: uiUx.config, uiUxFrameworks: uiUx.frameworks, visual: project.visual,
    projectRoot, repository, artifactsDir: path.join(data, "artifacts", taskId),
    provider: project.providers.default, providerRouting: project.providerRouting, providerTimeouts: project.providerTimeouts, plugins: project.plugins,
    qualityCommands: project.qualityCommandsByProfile[project.defaultProfile] ?? project.qualityCommands,
    maxReviewRounds: project.policy.maxReviewRounds, maxRepairAttempts: project.policy.maxRepairAttempts, maxParallelism: project.policy.maxParallelism,
    approval: project.policy.requireApprovalBeforeMerge });
}
async function main() {
  if (command === "run") {
    const prompt = args.slice(1).join(" ") || "Run the configured project workflow";
    const started = await startProjectRun(args[0] ?? "project.example.json", `local-${Date.now()}`, String(Date.now()), prompt);
    console.log(JSON.stringify(started)); return;
  }
  if (command === "doctor") {
    const checks = await runDoctor(defaultDoctorDeps());
    console.log(formatDoctor(checks));
    if (checks.some(check => !check.ok && check.severity === "error")) process.exitCode = 1;
    return;
  }
  if (command === "drain") {
    const waitIndex = args.indexOf("--wait-minutes");
    const waitMinutes = waitIndex >= 0 ? Number(args[waitIndex + 1]) : 0;
    if (!Number.isFinite(waitMinutes) || waitMinutes < 0) throw new Error("usage: dev drain [--wait-minutes N]");
    const result = await waitForDrain({ activeRuns: async () => (await listRuns() as Array<{ workflowId: string; status: string }>).filter(run => run.status === "RUNNING").map(run => run.workflowId), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now }, { waitMs: waitMinutes * 60_000 });
    console.log(formatDrain(result));
    if (!result.drained) process.exitCode = 1;
    return;
  }
  if (command === "reconcile") {
    // Reports to Paperclip what Temporal finished while the adapter was gone (machine off or asleep). Dry run unless --apply.
    const token = process.env.PAPERCLIP_API_TOKEN;
    if (!token) throw new Error("PAPERCLIP_API_TOKEN must be set");
    const base = (process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
    const apply = args.includes("--apply");
    const daysIndex = args.indexOf("--days");
    const days = daysIndex >= 0 ? Number(args[daysIndex + 1]) : undefined;
    const onlyIndex = args.indexOf("--issue");
    const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;
    if ((days !== undefined && !(days > 0)) || (onlyIndex >= 0 && !only)) throw new Error("usage: dev reconcile [--apply] [--days N] [--issue LOC-65]");
    const findings = await reconcile({
      paperclip: paperclipClient(base, token),
      listRuns: async () => await listRuns() as RunRow[],
      inspect: async workflowId => await inspectRun(workflowId) as RunDetail,
      resume: async workflowId => (await resumeRun(workflowId)).workflowId,
    }, { apply, autoResume: args.includes("--auto-resume"), ...(days !== undefined ? { days } : {}), ...(only ? { only } : {}) });
    console.log(formatFindings(findings, apply));
    return;
  }
  if (command === "reconcile-watch") {
    // The same service the worker runs, in the foreground (a terminal, or a machine without the worker): `npm run reconcile:watch`. The worker already runs it, so use this only to watch it work.
    const stop = await startReconcileService();
    if (!stop) throw new Error("PAPERCLIP_API_TOKEN must be set (and ORCHESTRATOR_RECONCILE must not be 0)");
    process.once("SIGINT", () => { stop(); process.exit(0); });
    await new Promise<never>(() => undefined);
  }
  if (command === "stack-pr") {
    // One merge for a stack of task PRs (src/stack-pr.ts): retargets the tip onto the real base. Dry run unless --apply; never merges.
    const repoIndex = args.indexOf("--repo"); const throughIndex = args.indexOf("--through");
    if ((repoIndex >= 0 && !args[repoIndex + 1]) || (throughIndex >= 0 && !args[throughIndex + 1])) throw new Error("usage: dev stack-pr [--repo <project clone>] [--through <PR number|task id|branch>] [--apply] [--close-stacked]");
    const result = await stackPr({ cwd: repoIndex >= 0 ? args[repoIndex + 1]! : process.cwd(), ...(throughIndex >= 0 ? { through: args[throughIndex + 1]! } : {}), apply: args.includes("--apply"), closeStacked: args.includes("--close-stacked") });
    console.log(result.lines.join("\n"));
    return;
  }
  if (command === "cleanup") {
    const daysIndex = args.indexOf("--days");
    const result = await cleanupWorktrees({ dataDir: data, olderThanDays: daysIndex >= 0 ? Number(args[daysIndex + 1]) : 7, all: args.includes("--all"), dryRun: args.includes("--dry-run") });
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length) process.exitCode = 1;
    return;
  }
  if (command === "timing") {
    const sinceIndex = args.indexOf("--since");
    const fileIndex = args.indexOf("--file");
    const file = fileIndex >= 0 ? args[fileIndex + 1]! : path.join(data, "logs", "worker-activity-events.jsonl");
    const summary = summarizeTiming(parseEvents(await readFile(file, "utf8")), { includeFake: args.includes("--include-fake"), ...(sinceIndex >= 0 ? { since: args[sinceIndex + 1]! } : {}) });
    console.log(args.includes("--json") ? JSON.stringify(summary, null, 2) : formatTiming(summary));
    return;
  }
  if (command === "runs") return console.log(JSON.stringify(await listRuns(), null, 2));
  if (command === "inspect") return console.log(JSON.stringify(await inspectRun(args[0]!), null, 2));
  if (command === "cancel") return cancelRun(args[0]!);
  if (command === "approve") return signalApproval(args[0]!, args[1] !== "reject");
  if (command === "sync-stack") {
    const [worktree, childBranch, parentPrUrl, targetBranch, remote = "origin"] = args;
    if (!worktree || !childBranch || !parentPrUrl || !targetBranch) throw new Error("usage: dev sync-stack <worktree> <child-branch> <parent-pr-url> <target-branch> [remote]");
    return console.log(JSON.stringify(await syncMergedStack({ worktree, childBranch, parentPrUrl, targetBranch, remote }), null, 2));
  }
  if (command === "resume-run") {
    if (!args[0]) throw new Error("usage: dev resume-run <workflowId of the failed run>");
    return console.log(JSON.stringify(await resumeRun(args[0]), null, 2));
  }
  if (command === "resume" || command === "restart") {
    const [projectFile, taskId, revision, ...promptParts] = args;
    if (!projectFile || !taskId || !revision || promptParts.length === 0) {
      throw new Error(`usage: dev ${command} <manifest> <taskId> <revision> <prompt>`);
    }
    const started = await startProjectRun(projectFile, taskId, revision, promptParts.join(" "));
    console.log(JSON.stringify({ ...started, mode: command }));
    return;
  }
  throw new Error("usage: dev run [manifest] [prompt] | resume-run <failed workflowId> | resume <manifest> <taskId> <revision> <prompt> | restart <manifest> <taskId> <newRevision> <prompt> | doctor | reconcile [--apply] [--auto-resume] | reconcile-watch | stack-pr [--repo <clone>] [--through <PR|task|branch>] [--apply] [--close-stacked] | drain [--wait-minutes N] | cleanup [--days N] [--all] [--dry-run] | timing [--since ISO] [--file path] [--include-fake] [--json] | runs | inspect <workflowId> | cancel <workflowId> | approve <workflowId> [reject] | sync-stack <worktree> <child-branch> <parent-pr-url> <target-branch> [remote]");
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
