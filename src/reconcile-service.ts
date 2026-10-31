// Reconcile as a service (FM-037, FM-053): the loop that reports finished workflows to Paperclip and resumes failed runs whose failure was transient or machine-caused. It runs inside the worker
// process (already supervised and restarted, and it already has the Paperclip token), so it is on whenever tasks can run. Every cycle writes a heartbeat file that `doctor` reads: a service nobody
// can see is a service nobody notices has stopped (the earlier Start-Job version never ran and nothing said so).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatFindings, reconcile, type Finding, type ReconcileDeps, type RunDetail, type RunRow } from "./reconcile.js";

export type Heartbeat = { at: string; intervalSeconds: number; cycles: number; pid: number; /** Runs this process resumed automatically. */ resumed: number; lastSummary: string; lastError?: string };
export const heartbeatFile = (dataDir: string): string => path.join(dataDir, "logs", "reconcile-heartbeat.json");
export const DEFAULT_INTERVAL_SECONDS = 120;

export async function readHeartbeat(file: string): Promise<Heartbeat | undefined> {
  try { const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<Heartbeat>; return typeof parsed.at === "string" && typeof parsed.intervalSeconds === "number" ? parsed as Heartbeat : undefined; }
  catch { return undefined; }
}
async function writeHeartbeat(file: string, heartbeat: Heartbeat): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(heartbeat, null, 2)); await rename(temp, file);
}

/** A warning text when the service is not demonstrably running, else undefined. A missing file means it never started (or the data dir differs). */
export function heartbeatProblem(heartbeat: Heartbeat | undefined, now: Date): string | undefined {
  if (!heartbeat) return "the reconcile service has never written a heartbeat: finished runs are not reported to Paperclip and failed runs are not resumed on their own (start the worker with PAPERCLIP_API_TOKEN set, or run npm run reconcile:watch)";
  const ageSeconds = (now.getTime() - new Date(heartbeat.at).getTime()) / 1000;
  if (!(ageSeconds < heartbeat.intervalSeconds * 3 + 60)) return `the reconcile service last ran ${Math.round(ageSeconds / 60)} minutes ago (it runs every ${heartbeat.intervalSeconds}s); the worker is probably not running`;
  if (heartbeat.lastError) return `the last reconcile cycle failed: ${heartbeat.lastError.slice(0, 200)}`;
  return undefined;
}

export type LoopDeps = {
  cycle: () => Promise<Finding[]>;
  writeHeartbeat: (heartbeat: Heartbeat) => Promise<void>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => Date;
  log: (line: string) => void;
  pid?: number;
};
/** Findings worth a log line; "already reported" and "still running" are the normal quiet state. */
const REPEAT_LOG_CYCLES = 20;
export const noteworthy =(findings: Finding[]): Finding[] => findings.filter(finding => !["already_reported", "running"].includes(finding.action));

/**
 * Runs `cycle` every `intervalSeconds` until the signal aborts (or `maxCycles`, for tests). A failing cycle is recorded in the heartbeat and retried with a growing pause (up to 8x), never fatal.
 */
export async function reconcileLoop(deps: LoopDeps, options: { intervalSeconds: number; signal?: AbortSignal; maxCycles?: number }): Promise<void> {
  let cycles = 0; let resumed = 0; let failures = 0;
  const loggedAt = new Map<string, number>();
  while (!options.signal?.aborted && (options.maxCycles === undefined || cycles < options.maxCycles)) {
    let lastSummary = "nothing to reconcile"; let lastError: string | undefined;
    try {
      const findings = await deps.cycle();
      failures = 0;
      resumed += findings.filter(finding => finding.action === "auto_resumed").length;
      const notes = noteworthy(findings);
      if (notes.length) lastSummary = notes.map(note => `${note.action} ${note.issue}`).join(", ");
      // A finding that waits for a person (a Paperclip recovery hold) repeats every cycle: log it when it appears and then once per REPEAT_LOG_CYCLES, not every few minutes.
      const key = (note: Finding): string => `${note.action}|${note.issue}|${note.workflowId ?? ""}`;
      const fresh = notes.filter(note => cycles - (loggedAt.get(key(note)) ?? -Infinity) >= REPEAT_LOG_CYCLES);
      for (const note of fresh) loggedAt.set(key(note), cycles);
      for (const logged of [...loggedAt.keys()]) if (!notes.some(note => key(note) === logged)) loggedAt.delete(logged);
      if (fresh.length) deps.log(`reconcile: ${formatFindings(fresh, true).split("\n").join(" | ")}`);
    } catch (error) {
      failures++; lastError = error instanceof Error ? error.message : String(error);
      lastSummary = "cycle failed"; deps.log(`reconcile: cycle failed (${lastError.slice(0, 300)})`);
    }
    cycles++;
    await deps.writeHeartbeat({ at: deps.now().toISOString(), intervalSeconds: options.intervalSeconds, cycles, pid: deps.pid ?? process.pid, resumed, lastSummary, ...(lastError ? { lastError } : {}) }).catch(() => undefined);
    if (options.maxCycles !== undefined && cycles >= options.maxCycles) break;
    // Pause grows with consecutive failures: 1x, 1x, 2x, 4x, 8x (a Paperclip that is down is not hammered).
    await deps.sleep(options.intervalSeconds * 1000 * Math.min(8, 2 ** Math.max(0, failures - 1)), options.signal).catch(() => undefined);
  }
}

/** The Paperclip HTTP client the reconcile step uses. */
export function paperclipClient(base: string, token: string): ReconcileDeps["paperclip"] {
  const root = base.replace(/\/$/, "");
  return async <T>(method: "GET" | "POST" | "PATCH", route: string, body?: unknown) => {
    const response = await fetch(`${root}${route}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Paperclip ${method} ${route} returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return await response.json() as T;
  };
}

/**
 * Starts the loop inside this process when a Paperclip token is configured. ORCHESTRATOR_RECONCILE=0 turns it off, ORCHESTRATOR_AUTO_RESUME=0 keeps the reporting but not the automatic resume,
 * ORCHESTRATOR_RECONCILE_SECONDS sets the interval. Returns a stop function, or undefined when it did not start.
 */
export async function startReconcileService(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = line => console.log(line), overrides: { /** Replaces the real reconcile cycle (tests: no Temporal, no Paperclip). */ cycle?: () => Promise<Finding[]> } = {}): Promise<(() => void) | undefined> {
  const token = env.PAPERCLIP_API_TOKEN;
  if (!token || env.ORCHESTRATOR_RECONCILE === "0") return undefined;
  // Loaded here so the pure parts of this module stay importable without a Temporal client.
  const real = overrides.cycle ? undefined : await import("./client.js");
  const configured = Number(env.ORCHESTRATOR_RECONCILE_SECONDS);
  const intervalSeconds = Number.isFinite(configured) && configured >= 15 ? configured : DEFAULT_INTERVAL_SECONDS;
  const autoResume = env.ORCHESTRATOR_AUTO_RESUME !== "0";
  const paperclip = paperclipClient(env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100", token);
  const file = heartbeatFile(env.ORCHESTRATOR_DATA_DIR ?? "data");
  const controller = new AbortController();
  void reconcileLoop({
    cycle: overrides.cycle ?? (() => reconcile({ paperclip, listRuns: async () => await real!.listRuns() as RunRow[], inspect: async id => await real!.inspectRun(id) as RunDetail, resume: async id => (await real!.resumeRun(id)).workflowId }, { apply: true, autoResume, workerStartedAt: new Date(Date.now() - process.uptime() * 1000) })),
    writeHeartbeat: heartbeat => writeHeartbeat(file, heartbeat),
    sleep: (ms, signal) => new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("stopped")); }, { once: true }); }),
    now: () => new Date(),
    log,
  }, { intervalSeconds, signal: controller.signal });
  log(`reconcile service started: every ${intervalSeconds}s${autoResume ? ", automatic resume of transient failures on" : ""}; heartbeat ${file}`);
  return () => controller.abort();
}
