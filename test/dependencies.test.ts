import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareProjectDependencies } from "../src/activities.js";

const clean = async () => ({ fixed: [] as string[], problems: [] as string[] });
const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchestrator-deps-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("installs locked npm dependencies in a task worktree", async () => {
  const root = await tempRoot();
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0" } } }));
  const runner = vi.fn(async () => ({ code: 0, output: "added 0 packages", stderr: "" }));

  await expect(prepareProjectDependencies(root, runner)).resolves.toMatchObject({ installed: true });
  expect(runner).toHaveBeenCalledWith("npm", ["ci"], root, 3000);
});

it("skips dependency installation when the project has no npm lockfile", async () => {
  const root = await tempRoot();
  await mkdir(root, { recursive: true });
  const runner = vi.fn();

  await expect(prepareProjectDependencies(root, runner)).resolves.toMatchObject({ installed: false });
  expect(runner).not.toHaveBeenCalled();
});

async function unityRoot(version = "6000.3.11f1") {
  const root = await tempRoot();
  await mkdir(path.join(root, "Assets"), { recursive: true });
  await mkdir(path.join(root, "ProjectSettings"), { recursive: true });
  await writeFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), `m_EditorVersion: ${version}\nm_EditorVersionWithRevision: ${version} (abc)\n`);
  return root;
}

it("imports a Unity project through the Unity CLI before anything else", async () => {
  const root = await unityRoot();
  const runner = vi.fn(async () => ({ code: 0, output: "", stderr: "" }));

  await expect(prepareProjectDependencies(root, runner, clean)).resolves.toMatchObject({ installed: true, summary: expect.stringContaining("6000.3.11f1") });
  expect(runner).toHaveBeenCalledTimes(1);
  expect(runner).toHaveBeenCalledWith("unity", ["run", root, "--timeout", "840", "--no-banner", "--non-interactive"], root, 3000);
});

it("also installs npm dependencies in a Unity project that has a lockfile", async () => {
  const root = await unityRoot();
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, "package-lock.json"), "{}");
  const runner = vi.fn(async () => ({ code: 0, output: "", stderr: "" }));

  await expect(prepareProjectDependencies(root, runner, clean)).resolves.toMatchObject({ installed: true, summary: expect.stringContaining("npm ci") });
  expect(runner.mock.calls.map(call => (call as unknown as string[])[0])).toEqual(["unity", "npm"]);
});

it("fails closed when the Unity import fails and never reaches npm", async () => {
  const root = await unityRoot();
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, "package-lock.json"), "{}");
  const runner = vi.fn(async () => ({ code: 6, output: "", stderr: "No valid Unity Editor license found" }));

  await expect(prepareProjectDependencies(root, runner, clean)).rejects.toThrow("Unity import of the isolated task worktree failed (editor 6000.3.11f1, exit 6): No valid Unity Editor license found");
  expect(runner).toHaveBeenCalledTimes(1);
});

it("rejects a Unity project whose version file has no editor version", async () => {
  const root = await unityRoot();
  await writeFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "garbage\n");

  await expect(prepareProjectDependencies(root, vi.fn())).rejects.toThrow("no m_EditorVersion");
});

it("does not treat an Assets folder alone as a Unity project", async () => {
  const root = await tempRoot();
  await mkdir(path.join(root, "Assets"), { recursive: true });
  const runner = vi.fn();

  await expect(prepareProjectDependencies(root, runner)).resolves.toMatchObject({ installed: false });
  expect(runner).not.toHaveBeenCalled();
});

it("fails closed when locked dependency installation fails", async () => {
  const root = await tempRoot();
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, "package-lock.json"), "{}");

  await expect(prepareProjectDependencies(root, async () => ({ code: 1, output: "", stderr: "registry unavailable" })))
    .rejects.toThrow("npm ci failed in the isolated task worktree: registry unavailable");
});

it("stops with a non-retryable preflight error before the Unity import when the environment is not usable", async () => {
  const root = await unityRoot();
  const runner = vi.fn(async () => ({ code: 0, output: "", stderr: "" }));
  const preflight = async () => ({ fixed: [], problems: ["only 2.0 GB are free where the worktree lives"] });

  await expect(prepareProjectDependencies(root, runner, preflight)).rejects.toMatchObject({ message: expect.stringContaining("Unity preflight failed: only 2.0 GB are free"), nonRetryable: true });
  expect(runner).not.toHaveBeenCalled();
});

it("reports what the preflight fixed in the summary", async () => {
  const root = await unityRoot();
  const runner = vi.fn(async () => ({ code: 0, output: "", stderr: "" }));
  const preflight = async () => ({ fixed: ["stopped 1 Unity process(es) that had the worktree open"], problems: [] });

  await expect(prepareProjectDependencies(root, runner, preflight)).resolves.toMatchObject({ summary: expect.stringContaining("Preflight fixed: stopped 1 Unity process(es)") });
});

it("does not run the Unity preflight for a project without Unity", async () => {
  const root = await tempRoot();
  const preflight = vi.fn(clean);
  await prepareProjectDependencies(root, vi.fn(), preflight);
  expect(preflight).not.toHaveBeenCalled();
});
