import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApplicationFailure } from "@temporalio/activity";
import { buildManifest, type Blueprint, type BootstrapOutcome, type BootstrapRunInput, type Charter, type PlannedIssue, type StackDecision } from "./bootstrap.js";
import { loadBootstrapConfig } from "./bootstrap-config.js";
import { renderDocs } from "./bootstrap-docs.js";
import { projectSlug } from "./bootstrap-options.js";
import { usableTemplate, type ScaffoldTemplate } from "./bootstrap-templates.js";
import { runCommand, type CommandRunner } from "./command.js";
import { ProjectManifestSchema } from "./contracts.js";
import { childEnv } from "./env.js";
import { activitySignal, heartbeating, killOnAbort, toolCommand } from "./process-control.js";
import { isGame, type GameDesign } from "./game.js";
import { defaultUnityTools, scaffoldUnityProject, templateValues, type UnityTools } from "./unity-scaffold.js";

// Host-side steps of a project bootstrap (ADR 0009). They run on the Windows worker, where the GitHub login lives; the bridge container never sees it.
// Each step is a plain function with injectable dependencies so the tests run without npm, git remotes or a Paperclip server.
export type NpmRunner = (args: string[], cwd: string) => Promise<{ code: number | null; output: string }>;
export type ScaffoldDeps = { run: CommandRunner; npm: NpmRunner; env: NodeJS.ProcessEnv; /** Unity Editor and CLI access for game projects; the real tools when absent. */ unity?: UnityTools };
export type ScaffoldRequest = { runId: string; run: BootstrapRunInput; stack: StackDecision; charter: Charter; blueprint: Blueprint; /** Game projects: the approved game design, written to docs/GAME_DESIGN.md and docs/RULES_SPEC.md. */ design?: GameDesign };

const npmRunner: NpmRunner = (args, cwd) => new Promise((resolve, reject) => {
  const { command, args: commandArgs } = toolCommand("npm", args);
  const child = spawn(command, commandArgs, { cwd, shell: false, windowsHide: true, env: childEnv() }); const stopKill = killOnAbort(child, activitySignal());
  const chunks: Buffer[] = []; let size = 0;
  const collect = (chunk: Buffer) => { if (size < 200_000) { chunks.push(chunk); size += chunk.length; } };
  child.stdout.on("data", collect); child.stderr.on("data", collect);
  child.on("error", error => { stopKill(); reject(error); });
  child.on("close", code => { stopKill(); resolve({ code, output: Buffer.concat(chunks).toString("utf8") }); });
});
const defaultDeps = (): ScaffoldDeps => ({ run: runCommand, npm: npmRunner, env: process.env });

const COMMIT_IDENTITY = ["-c", "user.name=Paperclip Orchestrator", "-c", "user.email=paperclip-orchestrator@localhost"];
const fail = (message: string): never => { throw ApplicationFailure.nonRetryable(message, "BootstrapScaffoldError"); };
const tail = (value: string, max = 1500) => value.trim().slice(-max);

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try { return (await readdir(dir)).length === 0; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}
async function exists(file: string): Promise<boolean> { return stat(file).then(() => true, () => false); }
function inside(root: string, file: string): string {
  const resolved = path.resolve(root, file);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`refusing to write '${file}' outside the project folder`);
  return resolved;
}

const CI_WORKFLOW = `name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm test
`;

function packageJson(template: ScaffoldTemplate, slug: string): string {
  return `${JSON.stringify({ name: slug, private: true, version: "0.0.0", type: "module", scripts: template.scripts }, null, 2)}\n`;
}

export async function scaffoldProjectImpl(request: ScaffoldRequest, deps: ScaffoldDeps = defaultDeps()): Promise<Omit<BootstrapOutcome, "issues">> {
  const { form, options, provenance } = request.run;
  const config = await loadBootstrapConfig(deps.env);
  const projectsRoot = request.run.projectsRoot ?? deps.env.ORCHESTRATOR_PROJECTS_ROOT;
  if (!projectsRoot) return fail("no projects folder is configured: set ORCHESTRATOR_PROJECTS_ROOT for the bridge (and the worker, when it is run by hand), so there is somewhere to create the project");
  const slug = projectSlug(form.repoName ?? form.name);
  const base = path.resolve(projectsRoot);
  const root = inside(base, slug);
  const manifestDir = path.resolve(deps.env.ORCHESTRATOR_PROJECTS_DIR ?? "projects", "generated");
  const manifestPath = path.join(manifestDir, `${form.paperclip.projectId}.json`);
  if (await exists(manifestPath)) return fail(`this Paperclip project is already bootstrapped (${manifestPath} exists)`);
  if (!(await isEmptyOrMissing(root))) return fail(`the folder ${root} already exists and is not empty; choose another repository name`);
  const template = usableTemplate(request.stack.template_id, String(options.platform), request.stack.architecture, isGame(options));
  const unityProject = template?.ecosystem === "unity";
  const warnings: string[] = [];
  const repoCreate = options.repo_create === true;
  let repoCreated = false;
  try {
    // Unity creates its own project folder; every other stack starts from an empty folder made here.
    if (!unityProject) await mkdir(root, { recursive: true });
    const files: Record<string, string> = { ...renderDocs({ form, options, provenance, stack: request.stack, charter: request.charter, blueprint: request.blueprint, driftRules: config.contract.rules, ...(request.design ? { design: request.design } : {}), ...(template ? { template } : {}) }) };
    if (unityProject) {
      if (options.ci === "basic") warnings.push("no CI workflow was added: a Unity build in GitHub Actions needs licence activation secrets");
    } else if (template) {
      Object.assign(files, template.files({ name: form.name, slug, description: form.description }), { "package.json": packageJson(template, slug) });
      if (options.ci === "basic") files[".github/workflows/ci.yml"] = CI_WORKFLOW;
    } else files[".gitignore"] = "node_modules/\ndist/\nbuild/\n*.log\n.env\n.env.*\n!.env.example\ncoverage/\n";
    const writeRepositoryFiles = async () => { for (const [file, content] of Object.entries(files)) { const target = inside(root, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content, "utf8"); } };
    let verified = false; let editorVersion: string | undefined;
    if (unityProject) {
      // Unity writes the project, the template and docs are copied on top, one import pass writes the .meta files, and EditMode tests plus hygiene prove it before the commit.
      const result = await scaffoldUnityProject({ root, template: template!, values: templateValues(form.name, slug, options), tools: deps.unity ?? defaultUnityTools(deps.env), run: deps.run, env: deps.env, writeFiles: writeRepositoryFiles });
      editorVersion = result.editorVersion; verified = true;
    } else await writeRepositoryFiles();
    if (unityProject) { /* proven above */ } else if (template) {
      // Current releases are installed (and locked) now rather than pinned in a template that would age; the project is then proven to build and test before anything is committed.
      for (const [label, args] of [["dependencies", ["install", ...template.dependencies]], ["dev dependencies", ["install", "--save-dev", ...template.devDependencies]]] as const) {
        const installed = await deps.npm([...args], root);
        if (installed.code !== 0) return fail(`npm could not install the ${label}: ${tail(installed.output)}`);
      }
      const checks = options.test_depth === "none" ? [["run", "build"]] : [["test"], ["run", "build"]];
      for (const args of checks) {
        const result = await deps.npm(args, root);
        if (result.code !== 0) return fail(`the generated scaffold failed 'npm ${args.join(" ")}', so nothing was committed: ${tail(result.output)}`);
      }
      verified = true;
    } else warnings.push("no scaffold template exists for this stack: the repository holds the contract, plan and docs, and its first task initialises the project; the orchestrator can only run code tasks once quality commands exist in the project manifest");

    await deps.run("git", ["init", "-b", config.manifest.targetBranch], root);
    await deps.run("git", ["add", "--all"], root);
    await deps.run("git", [...COMMIT_IDENTITY, "commit", "-m", "chore: initial project scaffold", "-m", "Generated by the Paperclip project bootstrap."], root);
    const commit = await deps.run("git", ["rev-parse", "HEAD"], root);

    let repositoryUrl: string | undefined;
    if (repoCreate) {
      const target = `${form.repoOwner ? `${form.repoOwner}/` : ""}${slug}`;
      await deps.run("gh", ["repo", "create", target, options.repo_visibility === "public" ? "--public" : "--private", "--source", ".", "--remote", "origin", "--push", "--description", form.description.replace(/\s+/g, " ").slice(0, 300)], root);
      repoCreated = true;
      repositoryUrl = await deps.run("gh", ["repo", "view", target, "--json", "url", "-q", ".url"], root).catch(() => undefined);
    } else warnings.push("no GitHub repository was created, so the orchestrator cannot publish pull requests for this project");

    const manifest = ProjectManifestSchema.parse(buildManifest({ projectId: form.paperclip.projectId, form: { ...form, repoName: slug }, options, ...(template ? { template } : {}), hasRepository: repoCreate, config, ...(editorVersion ? { editorVersion } : {}) }));
    await mkdir(manifestDir, { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { projectRoot: root, ...(repositoryUrl ? { repositoryUrl } : {}), commit, manifestPath, template: template?.id ?? "none", verified, warnings };
  } catch (error) {
    // Before the repository exists everything created here is ours and safe to remove, so a corrected request can run again from scratch.
    if (!repoCreated) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof ApplicationFailure) throw error;
    return fail(`${error instanceof Error ? error.message : String(error)}${repoCreated ? ` (the GitHub repository was already created and the local folder ${root} was kept; finish the manifest by hand or delete both)` : ""}`);
  }
}

/**
 * Empty working directory for the read-only model stages, so they never see the orchestrator's own files. It is an initialised (empty) git repository because
 * Codex refuses to run outside one ("Not inside a trusted directory"), which a live run found.
 */
export async function prepareBootstrapSandboxImpl(runId: string, deps: { run: CommandRunner; env: NodeJS.ProcessEnv } = { run: runCommand, env: process.env }): Promise<string> {
  const dir = path.resolve(deps.env.ORCHESTRATOR_DATA_DIR ?? "data", "bootstrap-sandboxes", runId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 70));
  await mkdir(dir, { recursive: true });
  if (!(await exists(path.join(dir, ".git")))) await deps.run("git", ["init", "-q"], dir);
  return dir;
}

// --- Paperclip issues ---
export type IssueDeps = { fetch: typeof fetch; env: NodeJS.ProcessEnv };
export type MaterializeRequest = { companyId: string; projectId: string; agentId?: string; issues: PlannedIssue[] };
const LABEL_COLORS: Record<string, string> = { milestone: "#6366f1", "type:research": "#0ea5e9", "type:architecture": "#f59e0b" };

export async function materializeIssuesImpl(request: MaterializeRequest, deps: IssueDeps = { fetch, env: process.env }): Promise<BootstrapOutcome["issues"]> {
  const token = deps.env.PAPERCLIP_API_TOKEN;
  if (!token) return fail("PAPERCLIP_API_TOKEN is required on the worker to create the project's tasks");
  const base = (deps.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
  const call = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const response = await deps.fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Paperclip ${method} ${route} returned ${response.status}: ${tail(await response.text(), 400)}`);
    return await response.json() as T;
  };
  const created: BootstrapOutcome["issues"] = [];
  try {
    const existing = await call<Array<{ id: string; name: string }>>("GET", `/api/companies/${request.companyId}/labels`);
    const labelIds = new Map(existing.map(label => [label.name.toLowerCase(), label.id]));
    for (const name of new Set(request.issues.flatMap(issue => issue.labels))) {
      if (labelIds.has(name.toLowerCase())) continue;
      const label = await call<{ id: string }>("POST", `/api/companies/${request.companyId}/labels`, { name, color: LABEL_COLORS[name] ?? "#64748b" });
      labelIds.set(name.toLowerCase(), label.id);
    }
    const ids = new Map<string, string>();
    for (const issue of request.issues) {
      const status = issue.kind === "task" && issue.start ? "todo" : "backlog";
      const body = {
        projectId: request.projectId, title: issue.title, description: issue.description, status, priority: "medium",
        ...(issue.parentKey ? { parentId: ids.get(issue.parentKey) } : {}),
        ...(issue.blockedByKeys.length ? { blockedByIssueIds: issue.blockedByKeys.map(key => ids.get(key)).filter((id): id is string => id !== undefined) } : {}),
        ...(issue.labels.length ? { labelIds: issue.labels.map(name => labelIds.get(name.toLowerCase())).filter((id): id is string => id !== undefined) } : {}),
        ...(issue.kind === "task" && request.agentId ? { assigneeAgentId: request.agentId } : {}),
      };
      const result = await call<{ id: string; status?: string }>("POST", "/api/companies/" + request.companyId + "/issues", body);
      ids.set(issue.key, result.id);
      created.push({ key: issue.key, id: result.id, title: issue.title, kind: issue.kind, status: result.status ?? status });
    }
    return created;
  } catch (error) {
    return fail(`creating the Paperclip tasks stopped after ${created.length} of ${request.issues.length}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const prepareBootstrapSandbox = heartbeating(prepareBootstrapSandboxImpl);
export const scaffoldProject = heartbeating((request: ScaffoldRequest) => scaffoldProjectImpl(request));
export const materializeIssues = heartbeating((request: MaterializeRequest) => materializeIssuesImpl(request));
