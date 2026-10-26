import { createServer } from "node:http";
import { z } from "zod";
import { cancelRun, inspectRun, listRuns, signalApproval, startRun } from "./client.js";
import { ProjectManifestSchema } from "./contracts.js";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { profiles } from "./profiles.js";
import { admitRepository, resolveStackBase, taskBranch } from "./workspaces.js";
import { projectContractBlock } from "./contract.js";
import { parseTaskDirectives, resolveOpenSpecEnabled } from "./openspec.js";
import { resolveProjectUiUx } from "./uiux-config.js";
import { resolveProjectHostRoot } from "./project-roots.js";
import { assertNoTestFlags, readJsonBody, tokenMatches } from "./http-guard.js";
import { indexManifests } from "./manifest-index.js";
import { resolveTaskType, taskTypes } from "./task-types.js";
import { catalogPayload, resolveOptions } from "./bootstrap-options.js";
import { templateSummaries } from "./bootstrap-templates.js";
import { prepareBootstrapRun } from "./bootstrap-start.js";
import { loadBootstrapConfig } from "./bootstrap-config.js";

const token = process.env.ORCHESTRATOR_API_TOKEN;
if (!token) throw new Error("ORCHESTRATOR_API_TOKEN must be set");
const projectFile = process.env.ORCHESTRATOR_PROJECT_FILE ?? "project.example.json";
const defaultProject = ProjectManifestSchema.parse(JSON.parse(await readFile(projectFile, "utf8")));
const projectDirectory = process.env.ORCHESTRATOR_PROJECTS_DIR ?? path.resolve("projects");
// Hand-written manifests live in projects/, manifests written by a project bootstrap (ADR 0009) in projects/generated/.
async function loadManifests() {
  const manifests = [defaultProject];
  for (const directory of [projectDirectory, path.join(projectDirectory, "generated")]) {
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        manifests.push(ProjectManifestSchema.parse(JSON.parse(await readFile(path.join(directory, entry.name), "utf8"))));
      }
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return indexManifests(manifests);
}
let projects = await loadManifests();
/** A project created after startup (by a bootstrap) is picked up by re-reading the manifests once, so no bridge restart is needed. */
async function findProject(id: string) {
  const known = projects.get(id);
  if (known) return known;
  projects = await loadManifests();
  return projects.get(id);
}
const startSchema = z.object({ taskId: z.string().min(1).max(180), projectId: z.string().min(1).optional(), revision: z.string().optional(), attempt: z.number().int().positive().optional(), profile: z.string().optional(), taskType: z.string().optional(), labels: z.array(z.string().max(120)).max(50).default([]), prompt: z.string().min(1).max(20_000), openSpec: z.boolean().optional(), analysis: z.boolean().optional(), taskTitle: z.string().optional(), approval: z.boolean().optional(), injectReviewFailure: z.boolean().optional(), repeatReviewFailure: z.boolean().optional(), injectActivityTimeout: z.boolean().optional(), blockers: z.array(z.object({ id: z.string(), status: z.string() })).default([]), parentPublications: z.array(z.object({ issueId: z.string(), branch: z.string(), headSha: z.string().regex(/^[0-9a-f]{40,64}$/i), prUrl: z.string().url() })).default([]) });
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (!tokenMatches(req.headers.authorization, token)) { res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized" })); return; }
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") { res.end(JSON.stringify({ ok: true, project: defaultProject.id, projects: [...projects.keys()] })); return; }
    if (req.method === "GET" && url.pathname === "/v1/runs") { res.end(JSON.stringify(await listRuns())); return; }
    // The wizard in Paperclip renders its form from this catalog, so options and presets have one definition (ADR 0009).
    if (req.method === "GET" && url.pathname === "/v1/bootstrap/catalog") { res.end(JSON.stringify({ ...catalogPayload(), templates: templateSummaries() })); return; }
    if (req.method === "POST" && url.pathname === "/v1/bootstrap/resolve") { const body = z.object({ options: z.record(z.string(), z.unknown()).default({}) }).parse(await readJsonBody(req)); res.end(JSON.stringify(resolveOptions(body.options))); return; }
    if (req.method === "POST" && url.pathname === "/v1/runs") {
      const payload = startSchema.parse(await readJsonBody(req));
      assertNoTestFlags(payload);
      // A bootstrap task (ADR 0009) creates the project, so there is no manifest to look up yet.
      const early = resolveTaskType({ ...(payload.taskType !== undefined ? { apiType: payload.taskType } : {}), labels: payload.labels, ...(parseTaskDirectives(payload.prompt).taskType ? { directive: parseTaskDirectives(payload.prompt).taskType! } : {}), ...(payload.profile ? { profile: payload.profile } : {}) });
      if (early.type === "bootstrap") {
        const runInput = await prepareBootstrapRun(payload, { isProjectKnown: async id => (await findProject(id)) !== undefined, config: await loadBootstrapConfig(), dataRoot: process.env.ORCHESTRATOR_HOST_DATA_DIR ?? path.resolve("data"), ...(process.env.ORCHESTRATOR_PROJECTS_ROOT ? { projectsRoot: process.env.ORCHESTRATOR_PROJECTS_ROOT } : {}) });
        res.writeHead(202); res.end(JSON.stringify(await startRun(runInput))); return;
      }
      const project = await findProject(payload.projectId ?? defaultProject.id);
      if (!project) throw new Error(`project '${payload.projectId}' is not configured in the orchestrator`);
      const parsedPrompt = parseTaskDirectives(payload.prompt);
      if (parsedPrompt.error) throw new Error(parsedPrompt.error);
      if (payload.profile && payload.profile !== project.defaultProfile && !["implementation", "bugfix", "research", "refactor"].includes(payload.profile)) throw new Error("unknown profile");
      // Task type (ADR 0008): API field > Paperclip labels > "Type:" line > agent profile. Without one the original pipeline for the profile runs.
      const requestedProfile = payload.profile ?? project.defaultProfile;
      const resolved = resolveTaskType({ ...(payload.taskType !== undefined ? { apiType: payload.taskType } : {}), labels: payload.labels, ...(parsedPrompt.taskType ? { directive: parsedPrompt.taskType } : {}), profile: requestedProfile });
      if (resolved.error) throw new Error(resolved.error);
      const taskType = resolved.type ? taskTypes[resolved.type] : undefined;
      const profileId = taskType?.profile ?? requestedProfile;
      const unresolved = payload.blockers.filter(blocker => blocker.status !== "done");
      if (unresolved.length) throw new Error(`task is blocked by unresolved Paperclip dependencies: ${unresolved.map(item => item.id).join(", ")}`);
      const artifactsRoot = process.env.ORCHESTRATOR_HOST_DATA_DIR ?? path.resolve("data");
      const projectRoot = resolveProjectHostRoot(project, process.env, defaultProject.id);
      if (!projectRoot) throw new Error(`project root environment variable is not configured for '${project.id}'`);
      const uiUx = await resolveProjectUiUx(project, project.containerRoot ?? projectRoot);
      const codeWorkflow = profiles[profileId]?.stages.includes("implement") && project.providerRouting.implement?.provider !== "fake";
      // Quality commands are looked up by task type, then delivery profile, then the agent's profile name (older manifests key by "bugfix").
      const qualityCommands = [taskType?.id, profileId, requestedProfile].map(key => key === undefined ? undefined : project.qualityCommandsByProfile[key]).find(commands => commands !== undefined) ?? project.qualityCommands;
      if (codeWorkflow && qualityCommands.length === 0) throw new Error(`project '${project.id}' has no qualityCommands for profile '${profileId}'; code tasks need at least one deterministic check (for example npm test) so the result can be verified`);
      // Research and architecture only read the repository, but they commit a report as a draft PR, so they need the same admitted checkout.
      const readsRepository = taskType?.flow === "investigation" && (project.providerRouting.explore?.provider ?? project.providers.default ?? "fake") !== "fake";
      let repository; let projectContract: string | undefined;
      if (codeWorkflow || readsRepository) {
        if (!project.repository) throw new Error(`project '${project.id}' has no GitHub repository configuration (remote and targetBranch); refusing patch-only execution`);
        if (!project.containerRoot) throw new Error(`project '${project.id}' has no containerRoot bind mount configured for Git admission`);
        const gitRoot = path.resolve(project.containerRoot);
        const admitted = await admitRepository({ projectRoot: gitRoot, remote: project.repository.remote, targetBranch: project.repository.targetBranch });
        const branch = taskBranch(payload.taskId, payload.revision ?? "1", payload.attempt ?? 1);
        // Several blockers without a configured integration branch: the worker assembles the base (ADR 0011); the values here are the ones it will confirm.
        const stack = await resolveStackBase({ gitRoot, remote: project.repository.remote, targetBranch: project.repository.targetBranch, ...(project.repository.integratedBaseBranch ? { integratedBaseBranch: project.repository.integratedBaseBranch } : {}), branch, admittedBaseSha: admitted.baseSha, hasBlockers: payload.blockers.length > 0, parents: payload.parentPublications });
        repository = { remote: project.repository.remote, targetBranch: project.repository.targetBranch, branch, baseSha: stack.baseSha, prBaseBranch: stack.prBaseBranch, taskTitle: payload.taskTitle ?? payload.taskId, requiredSourcePaths: project.repository.requiredSourcePaths, ...(stack.integrateParents ? { integrateParents: true } : {}) };
        const contractSettings = (await loadBootstrapConfig()).contract;
        projectContract = codeWorkflow ? await projectContractBlock({ gitRoot, baseSha: stack.baseSha, settings: contractSettings }) : undefined;
      }
      const started = await startRun({ taskId: payload.taskId, taskRevision: payload.revision, attempt: payload.attempt, blockerIds: payload.blockers.map(item => item.id), parentPublications: payload.parentPublications, ...(projectContract ? { projectContract } : {}), projectId: project.id, profile: profileId, prompt: parsedPrompt.prompt, taskType: taskType?.id, documentsDir: taskType?.id === "architecture" ? project.documents.architectureDir : project.documents.researchDir, openSpec: taskType?.flow === "bug" ? (payload.openSpec ?? parsedPrompt.openSpec ?? false) : resolveOpenSpecEnabled(project.openSpec.enabled, payload.openSpec ?? parsedPrompt.openSpec), analysis: payload.analysis ?? parsedPrompt.analysis ?? project.analysis.enabled, analysisDocsDir: project.analysis.docsDir, uiUx: uiUx.config, uiUxFrameworks: uiUx.frameworks, visual: project.visual, provider: project.providers.default, providerRouting: project.providerRouting, providerTimeouts: project.providerTimeouts, ...(project.budget ? { budget: project.budget } : {}), projectRoot, repository, artifactsDir: path.join(artifactsRoot, "artifacts", payload.taskId), approval: payload.approval ?? (profiles[profileId]?.approvalBeforeMerge ?? project.policy.requireApprovalBeforeMerge), maxReviewRounds: project.policy.maxReviewRounds, maxRepairAttempts: project.policy.maxRepairAttempts, maxParallelism: project.policy.maxParallelism, injectReviewFailure: payload.injectReviewFailure ?? false, repeatReviewFailure: payload.repeatReviewFailure ?? false, injectActivityTimeout: payload.injectActivityTimeout ?? false, plugins: project.plugins, qualityCommands });
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
