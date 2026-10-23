import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NODE_EXECUTABLE } from "./node-path.js";
import { runCommand, type CommandRunner } from "./command.js";
import { ProjectManifestSchema } from "./contracts.js";
import { concurrencyError, temporalAddressError } from "./env-validation.js";
import { findBrowser } from "./visual.js";

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
};

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

  const worktrees = await deps.listDir(path.join(path.resolve(deps.env.ORCHESTRATOR_DATA_DIR ?? "data"), "worktrees")).catch(() => [] as string[]);
  checks.push(worktrees.length > 20 ? fail("worktrees", `${worktrees.length} task worktrees on disk; run "dev cleanup"`, "warn") : pass("worktrees", `${worktrees.length} on disk`));
  const stale = await deps.buildStaleness();
  checks.push(stale ? fail("build", stale, "warn") : pass("build", "dist is up to date with src"));
  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks.map(check => `${check.ok ? "PASS" : check.severity === "warn" ? "WARN" : "FAIL"}  ${check.name.padEnd(24)} ${check.detail}`).join("\n");
}

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
  readManifestProviders: () => manifestProviders([env.ORCHESTRATOR_PROJECTS_DIR ?? path.resolve("projects"), env.ORCHESTRATOR_PROJECT_FILE ?? "project.example.json"]),
  visualProjects: () => manifestsWithVisual([env.ORCHESTRATOR_PROJECTS_DIR ?? path.resolve("projects"), env.ORCHESTRATOR_PROJECT_FILE ?? "project.example.json"]),
  findBrowser: () => findBrowser(env),
});
