import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { excludeGeneratedPaths, findPublishViolations, worktreeProfile } from "../src/publish-guard.js";
import { publishWorktree, runCommand } from "../src/workspaces.js";

const roots: string[] = [];
async function repo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-guard-")); roots.push(root);
  await runCommand("git", ["init", "-b", "main"], root);
  await writeFile(path.join(root, "a.js"), "export const a = 1;\n");
  await runCommand("git", ["add", "--all"], root);
  await runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", "base"], root);
  return root;
}
async function stage(root: string, files: Record<string, string>) {
  for (const [name, body] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), body); }
  await runCommand("git", ["add", "--all"], root);
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("findPublishViolations", () => {
  it("allows ordinary source and env templates", async () => {
    const root = await repo(); await stage(root, { "src/b.js": "export const b = 2;\n", ".env.example": "KEY=\n" });
    expect(await findPublishViolations(root, "HEAD")).toEqual([]);
  });
  it("flags credential files, vendored dependencies, secret-looking content and huge files", async () => {
    const root = await repo();
    await stage(root, { ".env": "X=1\n", "keys/server.pem": "x", "node_modules/p/i.js": "x", "src/c.js": 'const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n', "big.bin": "x".repeat(6_000_000) });
    const violations = (await findPublishViolations(root, "HEAD")).join("\n");
    for (const expected of [".env", "server.pem", "node_modules/p/i.js", "src/c.js", "big.bin"]) expect(violations).toContain(expected);
    expect(violations).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });
});

describe("guard edge cases", () => {
  it("catches non-ASCII and quoted file names", async () => {
    const root = await repo(); await stage(root, { "é/.env": "X=1\n", "ключ.pem": "x" });
    const violations = (await findPublishViolations(root, "HEAD")).join("\n");
    expect(violations).toContain(".env"); expect(violations).toContain(".pem");
  });
  it("inspects commits the agent made itself", async () => {
    const root = await repo(); const base = await runCommand("git", ["rev-parse", "HEAD"], root);
    await writeFile(path.join(root, ".env"), "S=1\n"); await runCommand("git", ["add", "--all"], root);
    await runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", "agent commit"], root);
    expect((await findPublishViolations(root, base)).join()).toContain(".env");
    await expect(publishWorktree({ repository: { remote: "origin", targetBranch: "main", branch: "codex/x-a1", baseSha: base, prBaseBranch: "main", taskTitle: "t" }, worktree: root, taskId: "x", prompt: "p" })).rejects.toThrow(/publish guard/);
  });
});

describe("generated build output (Unity)", () => {
  const unityFiles = { "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.3.11f1\n", "Assets/Scripts/A.cs": "class A {}\n", "Assets/Library/Cards.cs": "class Cards {}\n" };
  const generated = { ".utmp/RelWithDebInfo/x/cache.json": "{}", "Library/Bee/x.dll": "x", "Builds/game.aab": "x", "Logs/screenshots/a.png": "x", "Game.csproj": "<x/>" };

  it("detects a Unity worktree from its project version file", async () => {
    const root = await repo();
    expect(worktreeProfile(root)).toBe("node-web");
    await stage(root, unityFiles);
    expect(worktreeProfile(root)).toBe("unity-mobile");
  });
  it("drops what the run added from the index and keeps source, including a game folder named Library under Assets", async () => {
    const root = await repo(); const base = await runCommand("git", ["rev-parse", "HEAD"], root);
    await stage(root, { ...unityFiles, ...generated });
    const dropped = await excludeGeneratedPaths(root, base, "unity-mobile");
    expect(dropped.sort()).toEqual(Object.keys(generated).sort());
    const staged = (await runCommand("git", ["diff", "--cached", "--name-only", base], root)).split(/\r?\n/).sort();
    expect(staged).toEqual(["Assets/Library/Cards.cs", "Assets/Scripts/A.cs", "ProjectSettings/ProjectVersion.txt"]);
  });
  it("leaves a node project alone and never drops a file the base already tracks", async () => {
    const root = await repo(); const base = await runCommand("git", ["rev-parse", "HEAD"], root);
    await stage(root, { "Library/x.js": "x" });
    expect(await excludeGeneratedPaths(root, base, "node-web")).toEqual([]);
    await runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", "tracked"], root);
    const tracked = await runCommand("git", ["rev-parse", "HEAD"], root);
    await writeFile(path.join(root, "Library", "x.js"), "changed");
    await runCommand("git", ["add", "--all"], root);
    expect(await excludeGeneratedPaths(root, tracked, "unity-mobile")).toEqual([]);
    expect(await runCommand("git", ["diff", "--cached", "--name-only", tracked], root)).toBe("Library/x.js");
  });
  it("removes generated files the agent committed itself, and the commit that publishWorktree makes no longer contains them", async () => {
    const root = await repo(); const base = await runCommand("git", ["rev-parse", "HEAD"], root);
    await stage(root, { ...unityFiles, ...generated });
    await runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", "agent commit"], root);
    const runner = async (command: string, args: string[], cwd: string) => { if (command === "git" && args[0] === "push") throw new Error("stop before push"); return runCommand(command, args, cwd); };
    await expect(publishWorktree({ repository: { remote: "origin", targetBranch: "main", branch: "codex/x-a1", baseSha: base, prBaseBranch: "main", taskTitle: "t" }, worktree: root, taskId: "x", prompt: "p" }, runner)).rejects.toThrow("stop before push");
    const files = (await runCommand("git", ["diff", "--name-only", base, "HEAD"], root)).split(/\r?\n/).sort();
    expect(files).toEqual(["Assets/Library/Cards.cs", "Assets/Scripts/A.cs", "ProjectSettings/ProjectVersion.txt"]);
  });
  it("fails the publish gate when nothing but generated files was added", async () => {
    const root = await repo(); const base = await runCommand("git", ["rev-parse", "HEAD"], root);
    await stage(root, { "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.3.11f1\n" });
    await runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", "project"], root);
    const projectBase = await runCommand("git", ["rev-parse", "HEAD"], root);
    await stage(root, generated);
    const runner = async (command: string, args: string[], cwd: string) => { if (command === "git" && args[0] === "push") throw new Error("must not reach push"); return runCommand(command, args, cwd); };
    await expect(publishWorktree({ repository: { remote: "origin", targetBranch: "main", branch: "codex/x-a1", baseSha: projectBase, prBaseBranch: "main", taskTitle: "t" }, worktree: root, taskId: "x", prompt: "p" }, runner)).rejects.toThrow(/no changes were committed/);
    expect(base).not.toBe(projectBase);
  });
});

describe("publishWorktree guard", () => {
  it("refuses to commit or push when a violation is staged", async () => {
    const root = await repo(); const sha = await runCommand("git", ["rev-parse", "HEAD"], root);
    await writeFile(path.join(root, ".env"), "SECRET=1\n");
    await expect(publishWorktree({ repository: { remote: "origin", targetBranch: "main", branch: "codex/x-a1", baseSha: sha, prBaseBranch: "main", taskTitle: "t" }, worktree: root, taskId: "x", prompt: "p" })).rejects.toThrow(/publish guard.*\.env/s);
    expect(await runCommand("git", ["rev-parse", "HEAD"], root)).toBe(sha);
  });
});
