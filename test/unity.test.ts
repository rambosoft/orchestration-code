import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectManifestSchema, VisualConfigSchema } from "../src/contracts.js";
import { captureUnityScreenshots, clearUnityEvidence, nunitProblem, unityEvidenceProblem, unityExitHint, unityTestResultPath, withUnityDefaults } from "../src/unity.js";

const roots: string[] = [];
async function tempRoot() { const root = await mkdtemp(path.join(os.tmpdir(), "orchestrator-unity-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const run = (total: number, passed: number, failed: number) => `<?xml version="1.0"?><test-run id="2" testcasecount="${total}" result="Passed" total="${total}" passed="${passed}" failed="${failed}" inconclusive="0" skipped="0"><test-suite/></test-run>`;

describe("withUnityDefaults", () => {
  it("adds a per-verb timeout and non-interactive mode", () => {
    expect(withUnityDefaults(["test", "--mode", "EditMode"])).toEqual(["test", "--mode", "EditMode", "--timeout", "900", "--non-interactive"]);
    expect(withUnityDefaults(["build", "--target", "Android"])).toEqual(["build", "--target", "Android", "--timeout", "1500", "--non-interactive"]);
    expect(withUnityDefaults(["recompile"])).toContain("300");
  });

  it("keeps a timeout the manifest already set, in both spellings", () => {
    expect(withUnityDefaults(["test", "--timeout", "60"])).toEqual(["test", "--timeout", "60", "--non-interactive"]);
    expect(withUnityDefaults(["test", "--timeout=60", "--non-interactive"])).toEqual(["test", "--timeout=60", "--non-interactive"]);
  });
});

describe("nunitProblem", () => {
  it("accepts a clean run with tests", () => expect(nunitProblem(run(3, 3, 0))).toBeUndefined());
  it("rejects an empty run, failures, a missing element and a missing count", () => {
    expect(nunitProblem(run(0, 0, 0))).toContain("0 tests");
    expect(nunitProblem(run(4, 3, 1))).toContain("1 of 4 tests failed");
    expect(nunitProblem("<html/>")).toContain("no <test-run>");
    expect(nunitProblem("<test-run result=\"Passed\">")).toContain("no test count");
    expect(nunitProblem(run(2, 0, 0))).toContain("no test passed");
  });
});

describe("unityEvidenceProblem", () => {
  it("requires a report for a green unity test, and clears a stale one before the run", async () => {
    const cwd = await tempRoot();
    const check = { executable: "unity", args: ["test", "--mode", "EditMode"] };
    expect(await unityEvidenceProblem(check, cwd, 0)).toContain("wrote no report");
    await writeFile(path.join(cwd, "test-results.xml"), run(2, 2, 0));
    expect(await unityEvidenceProblem(check, cwd, 0)).toBeUndefined();
    await clearUnityEvidence(check, cwd);
    expect(await unityEvidenceProblem(check, cwd, 0)).toContain("wrote no report");
  });

  it("honours --output (both spellings) and rejects an empty or failing report", async () => {
    const cwd = await tempRoot();
    await mkdir(path.join(cwd, "Logs"));
    await writeFile(path.join(cwd, "Logs", "edit.xml"), run(0, 0, 0));
    expect(unityTestResultPath({ executable: "unity", args: ["test", "--output=Logs/edit.xml"] }, cwd)).toBe(path.join(cwd, "Logs", "edit.xml"));
    expect(await unityEvidenceProblem({ executable: "unity", args: ["test", "--output", "Logs/edit.xml"] }, cwd, 0)).toContain("0 tests");
    await writeFile(path.join(cwd, "Logs", "edit.xml"), run(5, 4, 1));
    expect(await unityEvidenceProblem({ executable: "unity", args: ["test", "--output", "Logs/edit.xml"] }, cwd, 0)).toContain("1 of 5");
  });

  it("requires a declared build output to exist and be non-empty", async () => {
    const cwd = await tempRoot();
    const check = { executable: "unity", args: ["build", "--target", "Android", "-o", "Builds/app.aab"] };
    expect(await unityEvidenceProblem(check, cwd, 0)).toContain("produced no output");
    await mkdir(path.join(cwd, "Builds"));
    await writeFile(path.join(cwd, "Builds", "app.aab"), "");
    expect(await unityEvidenceProblem(check, cwd, 0)).toContain("is empty");
    await writeFile(path.join(cwd, "Builds", "app.aab"), "bytes");
    expect(await unityEvidenceProblem(check, cwd, 0)).toBeUndefined();
  });

  it("does not examine non-unity checks or non-zero exits, and a build without -o has no artifact rule", async () => {
    const cwd = await tempRoot();
    expect(await unityEvidenceProblem({ executable: "npm", args: ["test"] }, cwd, 0)).toBeUndefined();
    expect(await unityEvidenceProblem({ executable: "unity", args: ["test"] }, cwd, 8)).toBeUndefined();
    expect(await unityEvidenceProblem({ executable: "unity", args: ["build", "--profile", "ci"] }, cwd, 0)).toBeUndefined();
  });

  it("explains the Unity exit codes", () => {
    expect(unityExitHint({ executable: "unity", args: ["test"] }, 8)).toContain("tests failed");
    expect(unityExitHint({ executable: "unity", args: ["test"] }, 6)).toContain("CS####");
    expect(unityExitHint({ executable: "npm", args: ["test"] }, 6)).toBe("");
  });
});

describe("unity visual capture", () => {
  const config = (extra: object = {}) => VisualConfigSchema.parse({ engine: "unity", unityFilter: "CaptureTests", maxImages: 2, ...extra });

  it("validates the engine-specific fields", () => {
    expect(VisualConfigSchema.safeParse({ engine: "unity" }).success).toBe(false);
    expect(VisualConfigSchema.safeParse({ engine: "web" }).success).toBe(false);
    expect(VisualConfigSchema.safeParse({ command: { executable: "npm", args: ["run", "dev"] }, url: "http://127.0.0.1:5199/" }).success).toBe(true);
    const base = { id: "demo-project", name: "Demo", root: "demo", defaultProfile: "implementation", visual: { engine: "unity", unityFilter: "CaptureTests" } };
    expect(ProjectManifestSchema.safeParse(base).success).toBe(false);
    expect(ProjectManifestSchema.safeParse({ ...base, stack: { profile: "unity-mobile" } }).success).toBe(true);
  });

  it("runs the capture test and copies at most maxImages images", async () => {
    const cwd = await tempRoot(); const outDir = path.join(cwd, "out");
    const fakeRun = vi.fn(async (_args: string[], dir: string) => {
      await mkdir(path.join(dir, "Logs", "screenshots"), { recursive: true });
      for (const name of ["b-board.png", "a-menu.png", "c-over.png", "notes.txt"]) await writeFile(path.join(dir, "Logs", "screenshots", name), "x");
      return { code: 0, output: "", stderr: "" };
    });
    const result = await captureUnityScreenshots(config(), { cwd, outDir }, { run: fakeRun });
    expect(fakeRun.mock.calls[0]![0]).toEqual(expect.arrayContaining(["test", "--mode", "PlayMode", "--filter", "CaptureTests"]));
    expect(result.images.map(file => path.basename(file))).toEqual(["unity-a-menu.png", "unity-b-board.png"]);
    expect(result.warnings.join(" ")).toContain("limit of 2");
    expect((await readdir(outDir)).sort()).toEqual(["unity-a-menu.png", "unity-b-board.png"]);
  });

  it("warns instead of throwing when the run fails or draws nothing", async () => {
    const cwd = await tempRoot(); const outDir = path.join(cwd, "out");
    const failed = await captureUnityScreenshots(config(), { cwd, outDir }, { run: async () => ({ code: 6, output: "", stderr: "CS0246 missing" }) });
    expect(failed.images).toEqual([]);
    expect(failed.warnings[0]).toContain("exit 6");
    const silent = await captureUnityScreenshots(config(), { cwd, outDir }, { run: async () => ({ code: 0, output: "", stderr: "" }) });
    expect(silent.warnings[0]).toContain("no screenshots");
    const thrown = await captureUnityScreenshots(config(), { cwd, outDir }, { run: async () => { throw new Error("spawn unity ENOENT"); } });
    expect(thrown.warnings[0]).toContain("ENOENT");
  });
});
