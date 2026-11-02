// Opt-in parallel quality gates (B-131): consecutive commands marked `parallel` run at the same time, results stay in the configured order, the verdict is unchanged.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeStage } from "../src/activities.js";
import { gateBatches } from "../src/gate-batches.js";
import { QualityCommandSchema } from "../src/contracts.js";
import { runCommand } from "../src/workspaces.js";

const dirs: string[] = [];
const temp = async (prefix: string) => { const dir = await mkdtemp(path.join(os.tmpdir(), prefix)); dirs.push(dir); return dir; };
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("gateBatches", () => {
  const c = (name: string, extra: Record<string, unknown> = {}) => ({ executable: "node", args: [name], ...extra });
  it("keeps every command on its own unless it is marked parallel", () => {
    expect(gateBatches([])).toEqual([]);
    expect(gateBatches([c("a"), c("b")]).map(batch => batch.length)).toEqual([1, 1]);
  });
  it("groups consecutive parallel commands and keeps order and count", () => {
    const list = [c("a"), c("p1", { parallel: true }), c("p2", { parallel: true }), c("b"), c("p3", { parallel: true })];
    const batches = gateBatches(list);
    expect(batches.map(batch => batch.map(item => item.args[0]))).toEqual([["a"], ["p1", "p2"], ["b"], ["p3"]]);
    expect(batches.flat()).toEqual(list);
  });
  it("never runs a Unity command next to another one", () => {
    const list = [{ executable: "unity", args: ["test"], parallel: true }, c("p", { parallel: true }), c("q", { parallel: true })];
    expect(gateBatches(list).map(batch => batch.length)).toEqual([1, 2]);
  });
});

describe("the manifest schema", () => {
  it("accepts the parallel flag and stays valid without it", () => {
    expect(QualityCommandSchema.parse({ executable: "npm", args: ["run", "lint"], parallel: true }).parallel).toBe(true);
    expect(QualityCommandSchema.parse({ executable: "npm", args: ["test"] }).parallel).toBeUndefined();
  });
});

describe("verify with parallel gates", () => {
  const base = { taskId: "t", projectId: "p", profile: "implementation", stage: "verify" as const, prompt: "task", attempt: 1, provider: "fake", plugins: [], verificationOnly: true };
  async function setup() {
    const root = await temp("orch-pg-repo-");
    await runCommand("git", ["init", "-b", "main"], root);
    await writeFile(path.join(root, "a.txt"), "one\n");
    await runCommand("git", ["add", "--all"], root);
    await runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", "base"], root);
    const outside = await temp("orch-pg-out-");
    const flag = path.join(outside, "started.flag");
    // The waiter can only pass if the starter runs at the same time: run one after the other it times out and fails.
    const waiter = (extra: Record<string, unknown> = {}) => ({ executable: "node" as const, args: ["-e", `const fs=require('fs');const t=Date.now();(function w(){if(fs.existsSync(${JSON.stringify(flag)}))process.exit(0);if(Date.now()-t>1500)process.exit(1);setTimeout(w,20)})()`], ...extra });
    const starter = (extra: Record<string, unknown> = {}) => ({ executable: "node" as const, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(flag)},'x')`], ...extra });
    const exits = (code: number, extra: Record<string, unknown> = {}) => ({ executable: "node" as const, args: ["-e", `process.exit(${code})`], ...extra });
    const verify = (runId: string, qualityCommands: Array<Record<string, unknown>>) => executeStage({ ...base, runId, projectRoot: root, artifactsDir: path.join(outside, "artifacts"), qualityCommands } as never);
    return { waiter, starter, exits, verify };
  }
  it("runs marked commands at the same time and records them in the configured order", async () => {
    const { waiter, starter, verify } = await setup();
    const result = await verify("run-parallel", [waiter({ parallel: true }), starter({ parallel: true })]);
    expect(result.ok, result.summary).toBe(true);
    const file = result.artifactRefs.find(ref => /quality/.test(ref));
    const recorded = JSON.parse(await readFile(file!, "utf8")) as { checks: Array<{ exitCode: number; args: string[] }> };
    expect(recorded.checks.map(check => check.exitCode)).toEqual([0, 0]);
    expect(recorded.checks[0]!.args[1]).toContain("existsSync");
  }, 30_000);
  it("keeps the default sequential behaviour for commands that are not marked", async () => {
    const { waiter, starter, verify } = await setup();
    const result = await verify("run-sequential", [waiter(), starter()]);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("quality check failed");
  }, 30_000);
  it("fails on the first failing command in configured order and still reports the batch, honouring warn severity", async () => {
    const { exits, verify } = await setup();
    const failed = await verify("run-fail", [exits(0, { parallel: true }), exits(3, { parallel: true }), exits(4, { parallel: true })]);
    expect(failed.ok).toBe(false);
    expect(failed.summary).toContain("process.exit(3)");
    const checks = (failed.metadata as { checks: Array<{ exitCode: number }> }).checks;
    expect(checks.slice(0, 2).map(check => check.exitCode)).toEqual([0, 3]);
    const warned = await verify("run-warn", [exits(1, { parallel: true, severity: "warn" }), exits(0, { parallel: true })]);
    expect(warned.ok, warned.summary).toBe(true);
  }, 30_000);
});
