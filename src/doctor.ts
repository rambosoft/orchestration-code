import { access, readdir, readFile, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { NODE_EXECUTABLE } from "./node-path.js";
import { runCommand, type CommandRunner } from "./command.js";
import { worktreesDir } from "./env.js";
import { ProjectManifestSchema } from "./contracts.js";
import { concurrencyError, temporalAddressError } from "./env-validation.js";
import { findBrowser } from "./visual.js";
import { diskProblem, MAX_WORKTREE_PATH_CHARS, worktreePathProblem } from "./preflight.js";
import { listEditorProcesses } from "./unity.js";

export type DoctorCheck = { name: string; ok: boolean; severity: "error" | "warn"; detail: string };
export type DoctorDeps = {
  run: CommandRunner;
  env: NodeJS.ProcessEnv;
  fetchJson: (url: string, headers?: Record<string, string>) => Promise<unknown>;
  pollersOnTaskQueue: () => Promise<number>;
  listDir: (dir: string) => Promise<string[]>;
  readManifestProviders: () => Promise<Map<string, string[]>>;
  /** A warning text when the compiled worker is older than the sources (a stale worker silently runs old code), else undefined. */
  buildStaleness: () => Promise<string | undefined>;
  /** Ids of projects whose manifest enables screenshot review, and the Chromium the worker would use for them (ADR 0007). */
  visualProjects?: () => Promise<string[]>;
  findBrowser?: () => string | undefined;
  /** The Project Bootstrap plugin (ADR 0009): whether it is built and which SDK version it is pinned to, against the Paperclip checkout it must match. Undefined when the plugin folder is absent. */
  pluginStatus?: () => Promise<PluginStatus | undefined>;
  /** Ids of projects with the unity-mobile stack profile and what the worker has for building them (docs/engineering/research/unity-game-support.md). */
  unityProjects?: () => Promise<string[]>;
  unityStatus?: () => Promise<UnityStatus>;
};
export type PluginStatus = { built: boolean; sdkPin?: string; hostVersion?: string };
export type UnityStatus = { cliVersion?: string; loggedIn: boolean; editors: Array<{ version: string; androidModule: boolean }>; pluginDir?: { path: string; exists: boolean }; /** Free bytes where task worktrees are created, the folder itself, Unity Editor processes running now, and the adb version (undefined: adb not installed). */ freeDiskBytes?: number; worktreesRoot?: string; runningEditors?: number; adbVersion?: string };

/** One check per thing a Unity project needs on the worker; a missing licence is the one that stops a scaffold, so it is an error. */
export function unityChecks(projects: string[], status: UnityStatus, required?: string): DoctorCheck[] {
  const used = projects.join(", ");
  const checks: DoctorCheck[] = [];
  checks.push(status.cliVersion ? pass("unity:cli", `Unity CLI ${status.cliVersion} (used by ${used})`) : fail("unity:cli", `the unity command is not on PATH (needed by ${used}); install the Unity CLI`));
  checks.push(status.loggedIn ? pass("unity:licence", "signed in; Editor batch runs can activate a licence (an Editor log line \"LicensingClient has failed validation; ignoring\" / \"Code 10 while verifying Licensing Client signature\" is a known harmless message of this machine and is filtered from check output)") : fail("unity:licence", `not signed in to Unity: Editor batch runs fail with "No valid Unity Editor license found" (${used}); sign in once through Unity Hub or "unity auth"`));
  const editor = required ? status.editors.find(item => item.version === required) : status.editors.find(item => item.version.startsWith("6000."));
  checks.push(editor ? pass("unity:editor", `${editor.version}${required ? "" : " (newest 6000.x found)"}`) : fail("unity:editor", `${required ? `Unity ${required}` : "a Unity 6 Editor"} is not installed (needed by ${used})`));
  if (editor) checks.push(editor.androidModule ? pass("unity:android", "the Android build module is installed") : fail("unity:android", `the Android module is not installed for ${editor.version}; Android builds fail`, "warn"));
  if (status.pluginDir) checks.push(status.pluginDir.exists ? pass("unity:plugin", `Unity agent plugin at ${status.pluginDir.path}`) : fail("unity:plugin", `UNITY_AGENT_PLUGIN_DIR points at ${status.pluginDir.path}, which does not exist; Claude runs without Unity's official skills`, "warn"));
  else checks.push(fail("unity:plugin", "UNITY_AGENT_PLUGIN_DIR is not set, so Claude runs without Unity's official skills; clone Unity-Technologies/unity-agent-plugin and set it", "warn"));
  // The same limits the task preflight enforces (src/preflight.ts), reported once before any task is queued.
  if (status.worktreesRoot) {
    const reach = worktreePathProblem(`${status.worktreesRoot}/${"x".repeat(36)}`);
    checks.push(reach ? fail("unity:worktree-path", reach) : pass("unity:worktree-path", `${status.worktreesRoot} (task worktrees stay under ${MAX_WORKTREE_PATH_CHARS} characters)`));
  }
  if (status.freeDiskBytes !== undefined) {
    const low = diskProblem(status.freeDiskBytes);
    checks.push(low ? fail("unity:disk", low) : pass("unity:disk", `${(status.freeDiskBytes / 1024 ** 3).toFixed(0)} GB free for task worktrees`));
  }
  if (status.runningEditors) checks.push(fail("unity:editors", `${status.runningEditors} Unity Editor process(es) are running; fine while you work in one, but a task on the same project fails with "instances cannot open the same project" (the task preflight stops Editors on its own worktree only)`, "warn"));
  checks.push(status.adbVersion ? pass("unity:adb", `adb ${status.adbVersion}`) : fail("unity:adb", "adb is not on PATH: a built AAB cannot be installed on a phone by the orchestrator, device-only criteria stay a manual checklist", "warn"));
  return checks;
}

/** The plugin SDK is pinned to the Paperclip release it was written against; a mismatch is what breaks a plugin after an upgrade, so it is checked here. */
export function pluginProblem(status: PluginStatus): string | undefined {
  if (!status.built) return 'plugins/project-bootstrap/dist is missing; run "npm run plugin:build"';
  const host = status.hostVersion?.replace(/^v/, "");
  if (status.sdkPin && host && status.sdkPin !== host) return `the plugin pins @paperclipai/plugin-sdk ${status.sdkPin} but the Paperclip checkout is ${host}; update the pin in plugins/project-bootstrap/package.json, then reinstall and rebuild the plugin`;
  return undefined;
}

const pass = (name: string, detail: string): DoctorCheck => ({ name, ok: true, severity: "error", detail });
const fail = (name: string, detail: string, severity: "error" | "warn" = "error"): DoctorCheck => ({ name, ok: false, severity, detail });

export function parseNodeVersion(version: string): [number, number] {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return [major, minor];
}

/** Which providers do the project manifests route stages to? Maps provider id to the projects using it. */
export async function manifestsWithVisual(sources: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const source of sources) {
    let files: string[];
    try { files = (await readdir(source)).filter(name => name.endsWith(".json")).map(name => path.join(source, name)); }
    catch { files = source.endsWith(".json") ? [source] : []; }
    for (const file of files) {
      try { const manifest = ProjectManifestSchema.parse(JSON.parse(await readFile(file, "utf8"))); if (manifest.visual?.enabled) ids.push(manifest.id); } catch { /* reported by the bridge at startup */ }
    }
  }
  return ids;
}

export async function manifestsWithUnity(sources: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const source of sources) {
    let files: string[];
    try { files = (await readdir(source)).filter(name => name.endsWith(".json")).map(name => path.join(source, name)); }
    catch { files = source.endsWith(".json") ? [source] : []; }
    for (const file of files) {
      try { const manifest = ProjectManifestSchema.parse(JSON.parse(await readFile(file, "utf8"))); if (manifest.stack?.profile === "unity-mobile") ids.push(manifest.id); } catch { /* reported by the bridge at startup */ }
    }
  }
  return ids;
}

export async function manifestProviders(sources: string[]): Promise<Map<string, string[]>> {
  const used = new Map<string, string[]>();
  for (const source of sources) {
    let files: string[];
    try { files = (await readdir(source)).filter(name => name.endsWith(".json")).map(name => path.join(source, name)); }
    catch { files = source.endsWith(".json") ? [source] : []; }
    for (const file of files) {
      try {
        const manifest = ProjectManifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
        const providers = new Set<string>([...(manifest.providers.default ? [manifest.providers.default] : []), ...Object.values(manifest.providerRouting).map(route => route!.provider)]);
        for (const provider of providers) used.set(provider, [...(used.get(provider) ?? []), manifest.id]);
      } catch { /* an invalid manifest is reported by the bridge at startup */ }
    }
  }
  return used;
}

async function providerCheck(provider: string, projects: string[], deps: DoctorDeps): Promise<DoctorCheck | undefined> {
  const name = `provider:${provider}`;
  const who = `used by ${projects.join(", ")}`;
  if (provider === "fake") return undefined;
  if (provider === "openrouter") return deps.env.OPENROUTER_API_KEY ? pass(name, `OPENROUTER_API_KEY set (${who})`) : fail(name, `OPENROUTER_API_KEY is not set in the worker environment (${who})`);
  try {
    if (provider === "codex") {
      const out = await deps.run(NODE_EXECUTABLE, [path.join("node_modules", "@openai", "codex", "bin", "codex.js"), "login", "status"], process.cwd());
      // The CLI reports on stderr and signals "not logged in" with a non-zero exit, which runCommand turns into a throw.
      return /not logged in/i.test(out) ? fail(name, `codex is not logged in; run "codex login" (${who})`) : pass(name, `logged in (${who})`);
    }
    if (provider === "claude") {
      const parsed = JSON.parse(await deps.run("claude", ["auth", "status"], process.cwd())) as { loggedIn?: boolean; authMethod?: string };
      return parsed.loggedIn ? pass(name, `logged in via ${parsed.authMethod ?? "unknown"} (${who})`) : fail(name, `claude is not logged in; run "claude auth login" (${who})`);
    }
    await deps.run(provider, ["--version"], process.cwd());
    return pass(name, `installed (${who})`);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 160) : String(error);
    return fail(name, /not logged in/i.test(message) ? `${provider} is not logged in; run "${provider} login" (${who})` : `${provider} check failed: ${message} (${who})`);
  }
}

/** Preflight: everything a run needs before it spends model time. Each failure names its fix. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const [major, minor] = parseNodeVersion(process.version);
  checks.push(major > 20 || (major === 20 && minor >= 19) ? pass("node", `${process.version} at ${NODE_EXECUTABLE}`) : fail("node", `${process.version} is older than the required 20.19`));
  try { await access(NODE_EXECUTABLE); } catch { checks.push(fail("node-path", `${NODE_EXECUTABLE} does not exist (version manager switched?)`)); }

  const concurrencyProblem = concurrencyError(deps.env);
  checks.push(concurrencyProblem ? fail("config:concurrency", concurrencyProblem) : pass("config:concurrency", deps.env.ORCHESTRATOR_MAX_ACTIVITY_CONCURRENCY ?? "2 (default)"));
  const address = deps.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
  const addressProblem = temporalAddressError(deps.env);
  checks.push(addressProblem ? fail("config:temporal-address", addressProblem) : pass("config:temporal-address", address));

  const bridge = (deps.env.ORCHESTRATOR_BRIDGE_URL ?? "http://127.0.0.1:3101").replace(/\/$/, "");
  const token = deps.env.ORCHESTRATOR_API_TOKEN;
  if (!token) checks.push(fail("bridge", "ORCHESTRATOR_API_TOKEN is not set in this shell, bridge health not checked", "warn"));
  else {
    try {
      const health = await deps.fetchJson(`${bridge}/health`, { authorization: `Bearer ${token}` }) as { ok?: boolean; projects?: string[] };
      checks.push(health.ok ? pass("bridge", `${bridge} ok, ${health.projects?.length ?? 0} projects`) : fail("bridge", `${bridge} responded but not ok`));
      try {
        const active = (await deps.fetchJson(`${bridge}/v1/runs`, { authorization: `Bearer ${token}` }) as Array<{ workflowId: string; status: string }>).filter(run => run.status === "RUNNING");
        checks.push(active.length ? fail("running-workflows", `${active.length} workflow(s) running (${active.map(run => run.workflowId.slice(0, 40)).join(", ")}); restarting the worker or bridge now would interrupt them`, "warn") : pass("running-workflows", "none"));
      } catch { /* the bridge check above already reports an unreachable bridge */ }
    } catch (error) { checks.push(fail("bridge", `${bridge} unreachable: ${error instanceof Error ? error.message : String(error)}`)); }
  }

  try {
    const pollers = await deps.pollersOnTaskQueue();
    checks.push(pollers > 0 ? pass("worker", `${pollers} poller(s) on the task queue`) : fail("worker", "no worker is polling the task queue; start the host worker"));
  } catch (error) { checks.push(fail("temporal", `cannot query Temporal at ${address}: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`)); }

  for (const tool of ["git", "gh"]) {
    try { await deps.run(tool, ["--version"], process.cwd()); checks.push(pass(`tool:${tool}`, "installed")); }
    catch { checks.push(fail(`tool:${tool}`, `${tool} is not on PATH`)); }
  }
  try { await deps.run("gh", ["auth", "status"], process.cwd()); checks.push(pass("gh-auth", "authenticated")); }
  catch { checks.push(fail("gh-auth", "gh is not authenticated; draft PR publication will fail")); }

  for (const [provider, projects] of await deps.readManifestProviders()) {
    const check = await providerCheck(provider, projects, deps);
    if (check) checks.push(check);
  }

  const visualProjects = await (deps.visualProjects?.() ?? Promise.resolve([] as string[]));
  if (visualProjects.length) {
    const browser = deps.findBrowser?.();
    checks.push(browser ? pass("visual:browser", `${browser} (used by ${visualProjects.join(", ")})`) : fail("visual:browser", `no Chromium found, so screenshot review is skipped with a warning (${visualProjects.join(", ")}); run "npx playwright install chromium" or set ORCHESTRATOR_BROWSER_PATH`, "warn"));
  }

  const unityProjects = await (deps.unityProjects?.() ?? Promise.resolve([] as string[]));
  if (unityProjects.length && deps.unityStatus) checks.push(...unityChecks(unityProjects, await deps.unityStatus().catch(() => ({ loggedIn: false, editors: [] } as UnityStatus))));

  const plugin = await (deps.pluginStatus?.() ?? Promise.resolve(undefined)).catch(() => undefined);
  if (plugin) {
    const problem = pluginProblem(plugin);
    checks.push(problem ? fail("plugin:project-bootstrap", problem, "warn") : pass("plugin:project-bootstrap", `built, SDK ${plugin.sdkPin ?? "unpinned"} matches Paperclip ${plugin.hostVersion ?? "unknown"}`));
    // The projects folder reaches the worker through the bridge; only the Paperclip token (to create the tasks) is the worker's own.
    checks.push(deps.env.PAPERCLIP_API_TOKEN ? pass("bootstrap:worker-env", "Paperclip token set") : fail("bootstrap:worker-env", "PAPERCLIP_API_TOKEN is not set in this shell; the worker needs it to create the project's tasks", "warn"));
  }

  const worktrees = await deps.listDir(worktreesDir(deps.env.ORCHESTRATOR_DATA_DIR ?? "data", deps.env)).catch(() => [] as string[]);
  checks.push(worktrees.length > 20 ? fail("worktrees", `${worktrees.length} task worktrees on disk; run "dev cleanup"`, "warn") : pass("worktrees", `${worktrees.length} on disk`));
  const stale = await deps.buildStaleness();
  checks.push(stale ? fail("build", stale, "warn") : pass("build", "dist is up to date with src"));
  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks.map(check => `${check.ok ? "PASS" : check.severity === "warn" ? "WARN" : "FAIL"}  ${check.name.padEnd(24)} ${check.detail}`).join("\n");
}

/** Hand-written manifests, manifests generated by a bootstrap (projects/generated), and the default project file. */
const manifestSources = (env: NodeJS.ProcessEnv): string[] => {
  const projects = env.ORCHESTRATOR_PROJECTS_DIR ?? path.resolve("projects");
  return [projects, path.join(projects, "generated"), env.ORCHESTRATOR_PROJECT_FILE ?? "project.example.json"];
};

export const defaultDoctorDeps = (env: NodeJS.ProcessEnv = process.env): DoctorDeps => ({
  run: runCommand,
  env,
  fetchJson: async (url, headers) => {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },
  pollersOnTaskQueue: async () => {
    const { Connection } = await import("@temporalio/client");
    const connection = await Connection.connect({ address: env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233", connectTimeout: 4000 });
    try {
      const result = await connection.workflowService.describeTaskQueue({ namespace: env.TEMPORAL_NAMESPACE ?? "default", taskQueue: { name: env.TEMPORAL_TASK_QUEUE ?? "orchestration" } });
      return result.pollers?.length ?? 0;
    } finally { await connection.close(); }
  },
  listDir: readdir,
  buildStaleness: async () => {
    const newest = async (dir: string): Promise<number> => {
      let latest = 0;
      for (const entry of await readdir(dir, { withFileTypes: true })) latest = Math.max(latest, entry.isDirectory() ? await newest(path.join(dir, entry.name)) : (await stat(path.join(dir, entry.name))).mtimeMs);
      return latest;
    };
    try {
      const built = (await stat(path.resolve("dist", "src", "worker.js"))).mtimeMs;
      return await newest(path.resolve("src")) > built ? 'src is newer than dist; run "npm run build" and restart the worker and bridge' : undefined;
    } catch { return 'dist/src/worker.js is missing; run "npm run build"'; }
  },
  readManifestProviders: () => manifestProviders(manifestSources(env)),
  visualProjects: () => manifestsWithVisual(manifestSources(env)),
  unityProjects: () => manifestsWithUnity(manifestSources(env)),
  unityStatus: async () => {
    const doctor = await runCommand("unity", ["doctor", "--no-banner", "--non-interactive"], process.cwd()).catch(() => "");
    const field = (name: string) => new RegExp(`^${name}\\t(.*)$`, "m").exec(doctor)?.[1]?.trim();
    const editors = [...doctor.matchAll(/^editor\.\d+\t(\S+)\t\S+\t(.+)$/gm)].map(match => ({ version: match[1]!, editor: match[2]!.trim() }));
    const withModules = await Promise.all(editors.map(async item => ({ version: item.version, androidModule: await access(path.join(path.dirname(item.editor), "Data", "PlaybackEngines", "AndroidPlayer")).then(() => true, () => false) })));
    const pluginPath = env.UNITY_AGENT_PLUGIN_DIR;
    const root = path.resolve(worktreesDir(env.ORCHESTRATOR_DATA_DIR ?? "data", env));
    const free = await statfs(await access(root).then(() => root, () => path.parse(root).root)).then(stats => Number(stats.bavail) * Number(stats.bsize), () => undefined);
    // adb is on PATH only when the Android SDK is installed separately; the Unity Android module ships its own copy, which is what a device stage would use.
    const bundledAdb = editors.map(item => path.join(path.dirname(item.editor), "Data", "PlaybackEngines", "AndroidPlayer", "SDK", "platform-tools", process.platform === "win32" ? "adb.exe" : "adb"));
    let adb: string | undefined;
    for (const candidate of ["adb", ...bundledAdb]) {
      const version = (await runCommand(candidate, ["version"], process.cwd()).catch(() => "")).match(/Android Debug Bridge version (\S+)/)?.[1];
      if (version) { adb = candidate === "adb" ? version : `${version} (bundled with Unity: ${candidate})`; break; }
    }
    const running = (await listEditorProcesses().catch(() => [])).length;
    return { ...(field("cliVersion") ? { cliVersion: field("cliVersion")! } : {}), loggedIn: field("auth\\.loggedIn") === "true", editors: withModules, worktreesRoot: root.split("\\").join("/"), runningEditors: running, ...(free !== undefined ? { freeDiskBytes: free } : {}), ...(adb ? { adbVersion: adb } : {}), ...(pluginPath ? { pluginDir: { path: pluginPath, exists: await access(pluginPath).then(() => true, () => false) } } : {}) };
  },
  pluginStatus: async () => {
    const folder = path.resolve("plugins", "project-bootstrap");
    let pin: string | undefined;
    try { pin = (JSON.parse(await readFile(path.join(folder, "package.json"), "utf8")) as { devDependencies?: Record<string, string> }).devDependencies?.["@paperclipai/plugin-sdk"]; }
    catch { return undefined; }
    const built = await access(path.join(folder, "dist", "worker.js")).then(() => true, () => false);
    // The checkout sits on a release tag (scripts/prepare-paperclip.ps1); the nearest reachable tag could be a beta, so only tags on HEAD itself count.
    const hostVersion = (await runCommand("git", ["tag", "--points-at", "HEAD"], path.resolve(".runtime", "paperclip")).catch(() => "")).split(/\r?\n/).find(tag => /^v\d{4}\.\d+\.\d+$/.test(tag.trim()))?.trim();
    return { built, ...(pin ? { sdkPin: pin } : {}), ...(hostVersion ? { hostVersion } : {}) };
  },
  findBrowser: () => findBrowser(env),
});
