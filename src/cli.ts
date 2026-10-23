import path from "node:path";
import { readFile } from "node:fs/promises";
import { ProjectManifestSchema } from "./contracts.js";
import { cancelRun, inspectRun, listRuns, signalApproval, startRun } from "./client.js";
import { syncMergedStack } from "./workspaces.js";
import { defaultDoctorDeps, formatDoctor, runDoctor } from "./doctor.js";
import { cleanupWorktrees } from "./cleanup.js";
import { formatFindings, reconcile, type RunDetail, type RunRow } from "./reconcile.js";
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
      paperclip: async <T>(method: "GET" | "POST" | "PATCH", route: string, body?: unknown) => {
        const response = await fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Paperclip ${method} ${route} returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
        return await response.json() as T;
      },
      listRuns: async () => await listRuns() as RunRow[],
      inspect: async workflowId => await inspectRun(workflowId) as RunDetail,
    }, { apply, ...(days !== undefined ? { days } : {}), ...(only ? { only } : {}) });
    console.log(formatFindings(findings, apply));
    return;
  }
  if (command === "cleanup") {
    const daysIndex = args.indexOf("--days");
    const result = await cleanupWorktrees({ dataDir: data, olderThanDays: daysIndex >= 0 ? Number(args[daysIndex + 1]) : 7, all: args.includes("--all"), dryRun: args.includes("--dry-run") });
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length) process.exitCode = 1;
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
  if (command === "resume" || command === "restart") {
    const [projectFile, taskId, revision, ...promptParts] = args;
    if (!projectFile || !taskId || !revision || promptParts.length === 0) {
      throw new Error(`usage: dev ${command} <manifest> <taskId> <revision> <prompt>`);
    }
    const started = await startProjectRun(projectFile, taskId, revision, promptParts.join(" "));
    console.log(JSON.stringify({ ...started, mode: command }));
    return;
  }
  throw new Error("usage: dev run [manifest] [prompt] | resume <manifest> <taskId> <revision> <prompt> | restart <manifest> <taskId> <newRevision> <prompt> | doctor | reconcile [--apply] | drain [--wait-minutes N] | cleanup [--days N] [--all] [--dry-run] | runs | inspect <workflowId> | cancel <workflowId> | approve <workflowId> [reject] | sync-stack <worktree> <child-branch> <parent-pr-url> <target-branch> [remote]");
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
