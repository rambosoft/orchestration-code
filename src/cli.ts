import path from "node:path";
import { readFile } from "node:fs/promises";
import { ProjectManifestSchema } from "./contracts.js";
import { cancelRun, inspectRun, listRuns, signalApproval, startRun } from "./client.js";
import { syncMergedStack } from "./workspaces.js";
import { defaultDoctorDeps, formatDoctor, runDoctor } from "./doctor.js";
import { cleanupWorktrees } from "./cleanup.js";
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
    openSpec: resolveOpenSpecEnabled(project.openSpec.enabled, parsedPrompt.openSpec), analysis: parsedPrompt.analysis ?? project.analysis.enabled, analysisDocsDir: project.analysis.docsDir, uiUx: uiUx.config, uiUxFrameworks: uiUx.frameworks,
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
  throw new Error("usage: dev run [manifest] [prompt] | resume <manifest> <taskId> <revision> <prompt> | restart <manifest> <taskId> <newRevision> <prompt> | doctor | cleanup [--days N] [--all] [--dry-run] | runs | inspect <workflowId> | cancel <workflowId> | approve <workflowId> [reject] | sync-stack <worktree> <child-branch> <parent-pr-url> <target-branch> [remote]");
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
