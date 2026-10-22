import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareProjectDependencies } from "../src/activities.js";

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

it("fails closed when locked dependency installation fails", async () => {
  const root = await tempRoot();
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, "package-lock.json"), "{}");

  await expect(prepareProjectDependencies(root, async () => ({ code: 1, output: "", stderr: "registry unavailable" })))
    .rejects.toThrow("npm ci failed in the isolated task worktree: registry unavailable");
});
