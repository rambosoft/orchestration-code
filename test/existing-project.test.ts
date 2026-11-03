// Adopting an existing repository (ADR 0032, B-107): the folder must stay inside the allowed roots and be a clean git repository with an origin remote. Real temp repositories, no mocks.
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OPTION_CATALOG, resolveOptions } from "../src/bootstrap-options.js";
import { browseRoots, inspectExistingFolder, listFolders, resolveInsideRoots } from "../src/existing-project.js";

const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" });
async function sandbox(): Promise<string> { const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "orch-existing-"))); dirs.push(dir); return dir; }
async function repo(root: string, name: string, options: { remote?: boolean; dirty?: boolean; react?: boolean } = {}): Promise<string> {
  const dir = path.join(root, name); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, dependencies: options.react ? { react: "19" } : {}, scripts: { test: "vitest run" } }));
  git(dir, "init", "-q", "-b", "main"); git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "init");
  if (options.remote !== false) git(dir, "remote", "add", "origin", "https://example.com/x/y.git");
  if (options.dirty) await writeFile(path.join(dir, "new.txt"), "x");
  return dir;
}

describe("roots", () => {
  it("reads ORCHESTRATOR_BROWSE_ROOTS and falls back to the parent of the working folder", () => {
    expect(browseRoots({ ORCHESTRATOR_BROWSE_ROOTS: " C:\\a ; ;D:\\b " } as NodeJS.ProcessEnv)).toEqual([path.resolve("C:\\a"), path.resolve("D:\\b")]);
    expect(browseRoots({})).toEqual([path.resolve("..")]);
  });
  it("refuses a missing folder, a file, a path outside the roots, '..' escapes and a symlink out of the roots", async () => {
    const root = await sandbox(); const outside = await sandbox(); const inner = path.join(root, "inner"); await mkdir(inner);
    await writeFile(path.join(root, "file.txt"), "x");
    expect(await resolveInsideRoots(inner, [root])).toEqual({ path: inner });
    expect(await resolveInsideRoots(root, [root])).toEqual({ path: root });
    expect(await resolveInsideRoots(path.join(root, "missing"), [root])).toEqual({ problem: "the folder does not exist" });
    expect(await resolveInsideRoots(path.join(root, "file.txt"), [root])).toEqual({ problem: "the path is not a folder" });
    expect((await resolveInsideRoots(outside, [root]) as { problem: string }).problem).toMatch(/outside the allowed roots/);
    expect((await resolveInsideRoots(path.join(inner, "..", "..", path.basename(outside)), [root]) as { problem: string }).problem).toMatch(/outside|does not exist/);
    expect(await resolveInsideRoots("", [root])).toEqual({ problem: "no folder given" });
    try { await symlink(outside, path.join(root, "link"), "junction"); expect((await resolveInsideRoots(path.join(root, "link"), [root]) as { problem: string }).problem).toMatch(/outside the allowed roots/); } catch { /* symlinks may be unavailable on this host */ }
  });
  it("does not treat a sibling that merely shares the root's prefix as inside it", async () => {
    const base = await sandbox(); const root = path.join(base, "work"); const sibling = path.join(base, "work-evil"); await mkdir(root); await mkdir(sibling);
    expect((await resolveInsideRoots(sibling, [root]) as { problem: string }).problem).toMatch(/outside/);
  });
});

describe("listFolders", () => {
  it("lists the roots first, then sub-folders without hidden or build folders, marking git repositories", async () => {
    const root = await sandbox(); await repo(root, "app"); await mkdir(path.join(root, "plain")); await mkdir(path.join(root, ".hidden")); await mkdir(path.join(root, "node_modules"));
    expect(await listFolders(undefined, [root])).toEqual({ folders: [{ name: root, path: root, git: false }] });
    const listed = await listFolders(root, [root]) as { folders: Array<{ name: string; git: boolean }>; parent?: string };
    expect(listed.folders.map(item => [item.name, item.git])).toEqual([["app", true], ["plain", false]]);
    expect(listed.parent).toBeUndefined();
    const deeper = await listFolders(path.join(root, "app"), [root]) as { parent?: string };
    expect(deeper.parent).toBe(root);
    expect(await listFolders(os.tmpdir(), [root])).toHaveProperty("problem");
  });
});

describe("inspectExistingFolder", () => {
  it("accepts a clean repository with an origin remote and reports branch, remote and stack", async () => {
    const root = await sandbox(); const dir = await repo(root, "ok", { react: true });
    expect(await inspectExistingFolder(dir, [root])).toMatchObject({ ok: true, problems: [], path: dir, branch: "main", remote: "https://example.com/x/y.git", profile: "react-ts", dirtyFiles: 0 });
  });
  it("reports every problem at once: uncommitted changes and no remote", async () => {
    const root = await sandbox(); const dir = await repo(root, "bad", { remote: false, dirty: true });
    const check = await inspectExistingFolder(dir, [root]);
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual([expect.stringMatching(/1 uncommitted change/), expect.stringMatching(/no 'origin' remote/)]);
  });
  it("refuses a plain folder, a sub-folder of a repository and a folder outside the roots", async () => {
    const root = await sandbox(); const dir = await repo(root, "r"); await mkdir(path.join(dir, "src")); await mkdir(path.join(root, "plain"));
    expect((await inspectExistingFolder(path.join(root, "plain"), [root])).problems[0]).toMatch(/not a git repository/);
    expect((await inspectExistingFolder(path.join(dir, "src"), [root])).problems[0]).toMatch(/choose its root/);
    expect((await inspectExistingFolder(os.tmpdir(), [root])).problems[0]).toMatch(/outside the allowed roots/);
  });
});

describe("project_mode option", () => {
  it("defaults to a new project and offers the four existing-project modes", () => {
    const mode = OPTION_CATALOG.find(option => option.id === "project_mode")!;
    expect(mode.default).toBe("new");
    expect(mode.choices!.map(choice => choice.value)).toEqual(["new", "maintain", "refactor", "migrate", "audit"]);
    expect(resolveOptions({}).errors).toEqual([]);
  });
  it("requires a folder for an existing project and ignores one for a new project", () => {
    expect(resolveOptions({ project_mode: "migrate" }).errors).toEqual(["choose the existing project's folder"]);
    expect(resolveOptions({ project_mode: "audit", existing_folder: "C:\\workspace\\luxus-app" }).errors).toEqual([]);
    expect(resolveOptions({ existing_folder: "C:\\x" }).warnings).toContain("a folder was given but the project is new; it was ignored");
    expect(resolveOptions({ project_mode: "nonsense" }).errors[0]).toMatch(/project_mode/);
  });
});
