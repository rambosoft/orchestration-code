import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { heartbeatFile, heartbeatProblem, noteworthy, readHeartbeat, reconcileLoop, startReconcileService, type Heartbeat, type LoopDeps } from "../src/reconcile-service.js";
import { runDoctor } from "../src/doctor.js";
import type { Finding } from "../src/reconcile.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const finding = (action: Finding["action"], issue = "LOC-1"): Finding => ({ issue, action, detail: "d" });

function loop(cycles: Array<Finding[] | Error>) {
  const heartbeats: Heartbeat[] = []; const logs: string[] = []; const sleeps: number[] = [];
  let index = 0;
  const deps: LoopDeps = {
    cycle: async () => { const next = cycles[Math.min(index++, cycles.length - 1)]!; if (next instanceof Error) throw next; return next; },
    writeHeartbeat: async heartbeat => { heartbeats.push(heartbeat); },
    sleep: async ms => { sleeps.push(ms); },
    now: () => new Date("2026-10-26T10:00:00Z"), log: line => logs.push(line), pid: 42,
  };
  return { deps, heartbeats, logs, sleeps };
}

describe("reconcileLoop", () => {
  it("writes a heartbeat every cycle and stays quiet when nothing needs attention", async () => {
    const { deps, heartbeats, logs } = loop([[finding("already_reported"), finding("running")]]);
    await reconcileLoop(deps, { intervalSeconds: 120, maxCycles: 3 });
    expect(heartbeats.map(heartbeat => heartbeat.cycles)).toEqual([1, 2, 3]);
    expect(heartbeats[0]).toMatchObject({ at: "2026-10-26T10:00:00.000Z", intervalSeconds: 120, pid: 42, resumed: 0, lastSummary: "nothing to reconcile" });
    expect(logs).toEqual([]);
  });
  it("logs reports and automatic resumes and counts the resumes", async () => {
    const { deps, heartbeats, logs } = loop([[finding("reported", "LOC-2"), finding("auto_resumed", "LOC-3")], []]);
    await reconcileLoop(deps, { intervalSeconds: 60, maxCycles: 2 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("LOC-3");
    expect(heartbeats[0]!.lastSummary).toBe("reported LOC-2, auto_resumed LOC-3");
    expect(heartbeats[1]!.resumed).toBe(1);
  });
  it("survives a failing cycle, records the error and pauses longer with each consecutive failure", async () => {
    const { deps, heartbeats, sleeps } = loop([new Error("Paperclip down"), new Error("Paperclip down"), new Error("Paperclip down"), []]);
    await reconcileLoop(deps, { intervalSeconds: 100, maxCycles: 4 });
    expect(heartbeats.slice(0, 3).every(heartbeat => heartbeat.lastError === "Paperclip down")).toBe(true);
    expect(heartbeats[3]!.lastError).toBeUndefined();
    expect(sleeps).toEqual([100_000, 200_000, 400_000]);
  });
  it("stops when the signal aborts", async () => {
    const { deps, heartbeats } = loop([[]]);
    const controller = new AbortController();
    deps.sleep = async () => { controller.abort(); };
    await reconcileLoop(deps, { intervalSeconds: 10, signal: controller.signal });
    expect(heartbeats).toHaveLength(1);
  });
  it("filters the quiet findings", () => {
    expect(noteworthy([finding("already_reported"), finding("running"), finding("would_resume")]).map(item => item.action)).toEqual(["would_resume"]);
  });
});

describe("heartbeatProblem", () => {
  const beat = (overrides: Partial<Heartbeat> = {}): Heartbeat => ({ at: "2026-10-26T10:00:00Z", intervalSeconds: 120, cycles: 5, pid: 1, resumed: 0, lastSummary: "x", ...overrides });
  it("is fine for a recent heartbeat", () => {
    expect(heartbeatProblem(beat(), new Date("2026-10-26T10:04:00Z"))).toBeUndefined();
  });
  it("names a missing heartbeat, a stale one and a failing last cycle", () => {
    expect(heartbeatProblem(undefined, new Date())).toContain("never written a heartbeat");
    expect(heartbeatProblem(beat(), new Date("2026-10-26T11:00:00Z"))).toContain("60 minutes ago");
    expect(heartbeatProblem(beat({ lastError: "Paperclip POST /x returned 500" }), new Date("2026-10-26T10:01:00Z"))).toContain("last reconcile cycle failed");
  });
});

describe("heartbeat file and service start", () => {
  it("reads nothing from a missing or malformed file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "orch-hb-")); dirs.push(dir);
    expect(await readHeartbeat(heartbeatFile(dir))).toBeUndefined();
  });
  it("does not start without a Paperclip token, or when switched off", async () => {
    expect(await startReconcileService({}, () => undefined)).toBeUndefined();
    expect(await startReconcileService({ PAPERCLIP_API_TOKEN: "t", ORCHESTRATOR_RECONCILE: "0" }, () => undefined)).toBeUndefined();
  });
  it("starts with a token, writes the first heartbeat even when Paperclip is unreachable, and stops", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "orch-hb-")); dirs.push(dir);
    const logs: string[] = [];
    // No network: the cycle is injected and fails the way an unreachable Paperclip or Temporal would.
    const stop = await startReconcileService({ PAPERCLIP_API_TOKEN: "t", ORCHESTRATOR_DATA_DIR: dir }, line => logs.push(line), { cycle: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:1"); } });
    expect(stop).toBeTypeOf("function");
    expect(logs[0]).toContain("reconcile service started");
    let beat: Heartbeat | undefined;
    for (let attempt = 0; attempt < 50 && !beat; attempt++) { beat = await readHeartbeat(heartbeatFile(dir)); if (!beat) await new Promise(resolve => setTimeout(resolve, 100)); }
    stop!();
    expect(beat).toMatchObject({ cycles: 1, lastSummary: "cycle failed" });
    expect(JSON.parse(await readFile(heartbeatFile(dir), "utf8")).lastError).toBeTruthy();
  }, 30_000);
});

describe("doctor", () => {
  const base = { run: async () => "ok", env: { ORCHESTRATOR_API_TOKEN: "t" } as NodeJS.ProcessEnv, fetchJson: async () => ({ ok: true, projects: [] }), pollersOnTaskQueue: async () => 1, listDir: async () => [], readManifestProviders: async () => new Map<string, string[]>(), buildStaleness: async () => undefined };
  it("warns when the reconcile service has not run, and passes with a recent heartbeat", async () => {
    const missing = await runDoctor({ ...base, reconcileHeartbeat: async () => undefined });
    expect(missing.find(check => check.name === "reconcile:service")).toMatchObject({ ok: false, severity: "warn" });
    const fresh = await runDoctor({ ...base, reconcileHeartbeat: async () => ({ at: new Date().toISOString(), intervalSeconds: 120, cycles: 1, pid: 1, resumed: 0, lastSummary: "x" }) });
    expect(fresh.find(check => check.name === "reconcile:service")).toMatchObject({ ok: true });
    const off = await runDoctor({ ...base, env: { ...base.env, ORCHESTRATOR_RECONCILE: "0" }, reconcileHeartbeat: async () => undefined });
    expect(off.find(check => check.name === "reconcile:service")).toBeUndefined();
  });
});
