import { createServer } from "node:http";
import { z } from "zod";
import { cancelRun, inspectRun, listRuns, signalApproval, startRun } from "./client.js";
import { ProjectManifestSchema } from "./contracts.js";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { profiles } from "./profiles.js";
import { admitRepository, resolveRemoteBranch, taskBranch } from "./workspaces.js";
import { parseTaskDirectives, resolveOpenSpecEnabled } from "./openspec.js";
import { resolveProjectUiUx } from "./uiux-config.js";
import { resolveProjectHostRoot } from "./project-roots.js";
import { assertNoTestFlags, readJsonBody, tokenMatches } from "./http-guard.js";
import { indexManifests } from "./manifest-index.js";

const token = process.env.ORCHESTRATOR_API_TOKEN;
if (!token) throw new Error("ORCHESTRATOR_API_TOKEN must be set");
const projectFile = process.env.ORCHESTRATOR_PROJECT_FILE ?? "project.example.json";
const defaultProject = ProjectManifestSchema.parse(JSON.parse(await readFile(projectFile, "utf8")));
const manifests = [defaultProject];
const projectDirectory = process.env.ORCHESTRATOR_PROJECTS_DIR ?? path.resolve("projects");
try {
  for (const entry of await readdir(projectDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const manifest = ProjectManifestSchema.parse(JSON.parse(await readFile(path.join(projectDirectory, entry.name), "utf8")));
    manifests.push(manifest);
  }
} catch (error) {
  if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const projects = indexManifests(manifests);
const startSchema = z.object({ taskId: z.string().min(1).max(180), projectId: z.string().min(1).optional(), revision: z.string().optional(), attempt: z.number().int().positive().optional(), profile: z.string().optional(), prompt: z.string().min(1).max(20_000), openSpec: z.boolean().optional(), analysis: z.boolean().optional(), taskTitle: z.string().optional(), approval: z.boolean().optional(), injectReviewFailure: z.boolean().optional(), repeatReviewFailure: z.boolean().optional(), injectActivityTimeout: z.boolean().optional(), blockers: z.array(z.object({ id: z.string(), status: z.string() })).default([]), parentPublications: z.array(z.object({ issueId: z.string(), branch: z.string(), headSha: z.string().regex(/^[0-9a-f]{40,64}$/i), prUrl: z.string().url() })).default([]) });
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (!tokenMatches(req.headers.authorization, token)) { res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized" })); return; }
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") { res.end(JSON.stringify({ ok: true, project: defaultProject.id, projects: [...projects.keys()] })); return; }
    if (req.method === "GET" && url.pathname === "/v1/runs") { res.end(JSON.stringify(await listRuns())); return; }
    if (req.method === "POST" && url.pathname === "/v1/runs") {
      const payload = startSchema.parse(await readJsonBody(req));
      assertNoTestFlags(payload);
      const project = projects.get(payload.projectId ?? defaultProject.id);
      if (!project) throw new Error(`project '${payload.projectId}' is not configured in the orchestrator`);
      const parsedPrompt = parseTaskDirectives(payload.prompt);
      if (parsedPrompt.error) throw new Error(parsedPrompt.error);
      if (payload.profile && payload.profile !== project.defaultProfile && !["implementation", "bugfix", "research", "refactor"].includes(payload.profile)) throw new Error("unknown profile");
      const profileId = payload.profile ?? project.defaultProfile;
      const unresolved = payload.blockers.filter(blocker => blocker.status !== "done");
      if (unresolved.length) throw new Error(`task is blocked by unresolved Paperclip dependencies: ${unresolved.map(item => item.id).join(", ")}`);
      const artifactsRoot = process.env.ORCHESTRATOR_HOST_DATA_DIR ?? path.resolve("data");
      const projectRoot = resolveProjectHostRoot(project, process.env, defaultProject.id);
      if (!projectRoot) throw new Error(`project root environment variable is not configured for '${project.id}'`);
      const uiUx = await resolveProjectUiUx(project, project.containerRoot ?? projectRoot);
      const codeWorkflow = profiles[profileId]?.stages.includes("implement") && project.providerRouting.implement?.provider !== "fake";
      if (codeWorkflow && (project.qualityCommandsByProfile[profileId] ?? project.qualityCommands).length === 0) throw new Error(`project '${project.id}' has no qualityCommands for profile '${profileId}'; code tasks need at least one deterministic check (for example npm test) so the result can be verified`);
      let repository;
      if (codeWorkflow) {
        if (!project.repository) throw new Error(`project '${project.id}' has no GitHub repository configuration (remote and targetBranch); refusing patch-only execution`);
        if (!project.containerRoot) throw new Error(`project '${project.id}' has no containerRoot bind mount configured for Git admission`);
        const gitRoot = path.resolve(project.containerRoot);
        const admitted = await admitRepository({ projectRoot: gitRoot, remote: project.repository.remote, targetBranch: project.repository.targetBranch });
        const branch = taskBranch(payload.taskId, payload.revision ?? "1", payload.attempt ?? 1);
        let baseSha = admitted.baseSha; let prBaseBranch = project.repository.targetBranch;
        if (payload.parentPublications.length === 1) {
          const parent = payload.parentPublications[0]!;
          const resolved = await resolveRemoteBranch(gitRoot, project.repository.remote, parent.branch);
          if (resolved !== parent.headSha) throw new Error(`dependency ${parent.issueId} branch moved since its published run; human stack recovery is required`);
          baseSha = parent.headSha; prBaseBranch = parent.branch;
        } else if (payload.parentPublications.length > 1) {
          const integrated = project.repository.integratedBaseBranch;
          if (!integrated) throw new Error("multiple blockers require repository.integratedBaseBranch containing every prerequisite commit");
          const integratedSha = await resolveRemoteBranch(gitRoot, project.repository.remote, integrated);
          const { runCommand } = await import("./workspaces.js");
          for (const parent of payload.parentPublications) {
            await runCommand("git", ["merge-base", "--is-ancestor", parent.headSha, integratedSha], gitRoot).catch(() => { throw new Error(`integrated base '${integrated}' does not contain blocker ${parent.issueId} commit ${parent.headSha}`); });
          }
          baseSha = integratedSha; prBaseBranch = integrated;
        } else if (payload.blockers.length) throw new Error("resolved dependency metadata is missing; refusing to start a dependent task on an unrelated base");
        repository = { remote: project.repository.remote, targetBranch: project.repository.targetBranch, branch, baseSha, prBaseBranch, taskTitle: payload.taskTitle ?? payload.taskId, requiredSourcePaths: project.repository.requiredSourcePaths };
      }
      const started = await startRun({ taskId: payload.taskId, taskRevision: payload.revision, attempt: payload.attempt, blockerIds: payload.blockers.map(item => item.id), parentPublications: payload.parentPublications, projectId: project.id, profile: profileId, prompt: parsedPrompt.prompt, openSpec: resolveOpenSpecEnabled(project.openSpec.enabled, payload.openSpec ?? parsedPrompt.openSpec), analysis: payload.analysis ?? parsedPrompt.analysis ?? project.analysis.enabled, analysisDocsDir: project.analysis.docsDir, uiUx: uiUx.config, uiUxFrameworks: uiUx.frameworks, visual: project.visual, provider: project.providers.default, providerRouting: project.providerRouting, providerTimeouts: project.providerTimeouts, projectRoot, repository, artifactsDir: path.join(artifactsRoot, "artifacts", payload.taskId), approval: payload.approval ?? (profiles[profileId]?.approvalBeforeMerge ?? project.policy.requireApprovalBeforeMerge), maxReviewRounds: project.policy.maxReviewRounds, maxRepairAttempts: project.policy.maxRepairAttempts, maxParallelism: project.policy.maxParallelism, injectReviewFailure: payload.injectReviewFailure ?? false, repeatReviewFailure: payload.repeatReviewFailure ?? false, injectActivityTimeout: payload.injectActivityTimeout ?? false, plugins: project.plugins, qualityCommands: project.qualityCommandsByProfile[profileId] ?? project.qualityCommands });
      res.writeHead(202); res.end(JSON.stringify(started)); return;
    }
    const match = url.pathname.match(/^\/v1\/runs\/([^/]+)(?:\/(cancel|approve|reject))?$/);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      if (req.method === "GET" && !match[2]) { res.end(JSON.stringify(await inspectRun(id))); return; }
      if (req.method === "POST" && match[2] === "cancel") { await cancelRun(id); res.end(JSON.stringify({ ok: true })); return; }
      if (req.method === "POST" && (match[2] === "approve" || match[2] === "reject")) { await signalApproval(id, match[2] === "approve"); res.end(JSON.stringify({ ok: true })); return; }
    }
    res.writeHead(404); res.end(JSON.stringify({ error: "not found" }));
  } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error instanceof Error ? error.message : "request failed" })); }
});
server.listen(Number(process.env.ORCHESTRATOR_PORT ?? 3101), "0.0.0.0", () => console.log(`orchestrator bridge listening on ${process.env.ORCHESTRATOR_PORT ?? 3101}`));
