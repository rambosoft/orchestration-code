import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeStage } from "../src/activities.js";
import { findReusable, qualityKey, readPasses, treeFingerprint, writePass, type QualityPass } from "../src/quality-cache.js";
import { runCommand } from "../src/workspaces.js";

const dirs: string[] = [];
const temp = async (prefix: string) => { const dir = await mkdtemp(path.join(os.tmpdir(), prefix)); dirs.push(dir); return dir; };
async function gitRepo(files: Record<string, string> = { "a.txt": "one\n", ".gitignore": "ignored.log\n" }) {
  const root = await temp("orch-qc-repo-");
  await runCommand("git", ["init", "-b", "main"], root);
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(root, name), body);
  await runCommand("git", ["add", "--all"], root);
  await runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", "base"], root);
  return root;
}
const pass = (overrides: Partial<QualityPass> = {}): QualityPass => ({ key: "k", fingerprints: ["f"], attempt: 1, checks: [], warnings: [], ...overrides });
beforeEach(() => { delete process.env.ORCHESTRATOR_QUALITY_REUSE; });
afterEach(async () => { delete process.env.ORCHESTRATOR_QUALITY_REUSE; for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("qualityKey", () => {
  it("changes with the executable, arguments, cwd and severity, and not otherwise", () => {
    const base = { executable: "node", args: ["a"] };
    expect(qualityKey([base])).toBe(qualityKey([{ ...base }]));
    for (const other of [{ ...base, executable: "npm" }, { ...base, args: ["b"] }, { ...base, cwd: "sub" }, { ...base, severity: "warn" }]) expect(qualityKey([other])).not.toBe(qualityKey([base]));
    expect(qualityKey([base, base])).not.toBe(qualityKey([base]));
  });
});

describe("treeFingerprint", () => {
  it("is stable, and changes with edited content and with a new untracked file", async () => {
    const root = await gitRepo();
    const first = await treeFingerprint(root);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await treeFingerprint(root)).toBe(first);
    await writeFile(path.join(root, "a.txt"), "two\n");
    const edited = await treeFingerprint(root);
    expect(edited).not.toBe(first);
    await writeFile(path.join(root, "b.txt"), "new\n");
    expect(await treeFingerprint(root)).not.toBe(edited);
  });
  it("ignores files git ignores, and returns to the same value when an edit is reverted", async () => {
    const root = await gitRepo();
    const first = await treeFingerprint(root);
    await writeFile(path.join(root, "ignored.log"), "noise");
    expect(await treeFingerprint(root)).toBe(first);
    await writeFile(path.join(root, "a.txt"), "other\n");
    await writeFile(path.join(root, "a.txt"), "one\n");
    expect(await treeFingerprint(root)).toBe(first);
  });
  it("is undefined outside a git repository, so nothing is ever reused there", async () => {
    expect(await treeFingerprint(await temp("orch-qc-plain-"))).toBeUndefined();
  });
  it("hashes through the injected file list, in a stable order", async () => {
    const hashes: Record<string, string> = { "/r/x": "1", "/r/y": "2" };
    const a = await treeFingerprint("/r", { listFiles: async () => ["y", "x"], hashFile: async file => hashes[file.split("\\").join("/")]! });
    const b = await treeFingerprint("/r", { listFiles: async () => ["x", "y", "x"], hashFile: async file => hashes[file.split("\\").join("/")]! });
    expect(a).toBe(b);
  });
});

describe("pass storage", () => {
  it("reads nothing from a missing or corrupt file and drops malformed entries", async () => {
    const dir = await temp("orch-qc-store-");
    expect(await readPasses(dir)).toEqual([]);
    await writeFile(path.join(dir, "quality-pass.json"), "{ not json");
    expect(await readPasses(dir)).toEqual([]);
    await writeFile(path.join(dir, "quality-pass.json"), JSON.stringify([pass(), { nope: true }, "x"]));
    expect(await readPasses(dir)).toHaveLength(1);
  });
  it("keeps the last five passes and replaces a pass with the same key and fingerprint", async () => {
    const dir = await temp("orch-qc-store-");
    for (let n = 1; n <= 7; n++) await writePass(dir, pass({ key: `k${n}`, fingerprints: [`f${n}`], attempt: n }));
    expect((await readPasses(dir)).map(item => item.attempt)).toEqual([3, 4, 5, 6, 7]);
    await writePass(dir, pass({ key: "k7", fingerprints: ["f7", "f8"], attempt: 9 }));
    const passes = await readPasses(dir);
    expect(passes.filter(item => item.key === "k7")).toHaveLength(1);
    expect(passes.at(-1)!.attempt).toBe(9);
  });
  it("finds a pass only for the same key and one of its fingerprints, newest first", () => {
    const passes = [pass({ attempt: 1 }), pass({ attempt: 2, fingerprints: ["f", "g"] })];
    expect(findReusable(passes, "k", "g")!.attempt).toBe(2);
    expect(findReusable(passes, "k", "f")!.attempt).toBe(2);
    expect(findReusable(passes, "other", "f")).toBeUndefined();
    expect(findReusable(passes, "k", "zzz")).toBeUndefined();
  });
});

describe("verify activity reuse", () => {
  const base = { taskId: "t", projectId: "p", profile: "implementation", stage: "verify" as const, prompt: "task", attempt: 1, provider: "fake", plugins: [], verificationOnly: true };
  async function setup() {
    const root = await gitRepo();
    const outside = await temp("orch-qc-out-");
    const counter = path.join(outside, "runs.txt");
    const command = (exit = 0, tag = "") => ({ executable: "node" as const, args: ["-e", `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x'); process.exit(${exit})/*${tag}*/`] });
    const runs = async () => (await readFile(counter, "utf8").catch(() => "")).length;
    const verify = (runId: string, qualityCommands: ReturnType<typeof command>[], attempt = 1) => executeStage({ ...base, runId, projectRoot: root, artifactsDir: path.join(outside, "artifacts"), qualityCommands, attempt });
    return { root, command, runs, verify };
  }

  it("runs the commands once for an unchanged tree and says so when it reuses the pass", async () => {
    const { command, runs, verify } = await setup();
    const first = await verify("run", [command()]);
    expect(first.ok).toBe(true);
    expect(await runs()).toBe(1);
    const second = await verify("run", [command()], 2);
    expect(second.ok).toBe(true);
    expect(await runs()).toBe(1);
    expect((second.metadata as { warnings?: string[] }).warnings?.join(" ")).toContain("reused the passing result of verify attempt 1");
    expect((second.metadata as { deterministicQuality: { checks: Array<{ durationMs: number }> } }).deterministicQuality.checks[0]!.durationMs).toBe(0);
  });
  it("runs again after a file changed, after the commands changed, and for another run folder", async () => {
    const { root, command, runs, verify } = await setup();
    await verify("run", [command()]);
    await writeFile(path.join(root, "a.txt"), "changed\n");
    await verify("run", [command()], 2);
    expect(await runs()).toBe(2);
    await verify("run", [command(0), command(0, "second")], 3);
    expect(await runs()).toBe(4);
    await verify("another-run", [command()]);
    expect(await runs()).toBe(5);
  });
  it("never reuses a failure", async () => {
    const { command, runs, verify } = await setup();
    expect((await verify("run", [command(3)])).ok).toBe(false);
    expect((await verify("run", [command(3)], 2)).ok).toBe(false);
    expect(await runs()).toBe(2);
  });
  it("can be switched off", async () => {
    process.env.ORCHESTRATOR_QUALITY_REUSE = "0";
    const { command, runs, verify } = await setup();
    await verify("run", [command()]);
    await verify("run", [command()], 2);
    expect(await runs()).toBe(2);
  });
});
