import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { admitRepository, dirtyEntries, prepareWorktree, publishWorktree, runCommand, syncMergedStack, taskBranch } from "../src/workspaces.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-git-fixture-")); roots.push(root);
  await runCommand("git", ["init", "-b", "main"], root);
  await runCommand("git", ["config", "user.name", "Fixture"], root);
  await runCommand("git", ["config", "user.email", "fixture@example.test"], root);
  await mkdir(path.join(root, "src")); await writeFile(path.join(root, "src", "app.js"), "export const value = 1;\n");
  await runCommand("git", ["add", "--all"], root); await runCommand("git", ["commit", "-m", "baseline"], root);
  const sha = await runCommand("git", ["rev-parse", "HEAD"], root);
  return { root, sha };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("Git workspace admission and publication", () => {
  it("rejects untracked files without staging or changing them", async () => {
    const { root } = await fixture(); const file = path.join(root, "new-source.js"); await writeFile(file, "must stay untracked");
    await expect(admitRepository({ projectRoot: root, remote: "origin", targetBranch: "main" }, async (command, args, cwd) => {
      if (command === "git" && args[0] === "remote") return "https://github.com/example/project.git";
      if (command === "git" && args[0] === "fetch") return "";
      return runCommand(command, args, cwd);
    })).rejects.toThrow("working tree is not clean");
    expect(await readFile(file, "utf8")).toBe("must stay untracked");
    expect(await runCommand("git", ["status", "--porcelain", "--untracked-files=all"], root)).toContain("new-source.js");
  });

  it("uses one committed snapshot and prepares a complete branch worktree", async () => {
    const { root, sha } = await fixture();
    const bare = await mkdtemp(path.join(os.tmpdir(), "orch-git-bare-")); roots.push(bare);
    await runCommand("git", ["init", "--bare", bare], root);
    await runCommand("git", ["remote", "add", "origin", bare], root);
    await runCommand("git", ["push", "--set-upstream", "origin", "main"], root);
    const admitted = await admitRepository({ projectRoot: root, remote: "origin", targetBranch: "main" }, async (command, args, cwd) => {
      if (command === "git" && args[0] === "remote" && args[1] === "get-url") return "https://github.com/example/project.git";
      if (command === "git" && args[0] === "fetch") return "";
      if (command === "git" && args[0] === "rev-parse" && args[1] === "FETCH_HEAD^{commit}") return sha;
      return runCommand(command, args, cwd);
    });
    expect(admitted.baseSha).toBe(sha);
    const oldData = process.env.ORCHESTRATOR_DATA_DIR; process.env.ORCHESTRATOR_DATA_DIR = path.join(root, "run-data");
    try {
      const worktree = await prepareWorktree({ runId: "fixture-run", projectRoot: root, baseSha: admitted.baseSha, branch: "codex/fixture-a1", requiredSourcePaths: ["src/app.js"] });
      expect(await readFile(path.join(worktree, "src", "app.js"), "utf8")).toContain("value = 1");
      await writeFile(path.join(worktree, "src", "app.js"), "export const value = 2;\n");
      let pushed = false;
      const ghRunner = async (command: string, args: string[], cwd: string) => {
        if (command === "gh" && args[0] === "pr" && args[1] === "view") {
          if (pushed) return JSON.stringify({ url: "https://github.com/example/project/pull/7", baseRefName: "main", state: "OPEN" });
          throw new Error("no pull requests found for branch 'codex/fixture-a1'");
        }
        if (command === "gh" && args[0] === "pr" && args[1] === "create") { pushed = true; return "https://github.com/example/project/pull/7"; }
        return runCommand(command, args, cwd);
      };
      const repository = { remote: "origin", targetBranch: "main", branch: "codex/fixture-a1", baseSha: sha, prBaseBranch: "main", taskTitle: "Fixture feature" };
      const first = await publishWorktree({ repository, worktree, taskId: "fixture", prompt: "Make the change" }, ghRunner);
      const second = await publishWorktree({ repository, worktree, taskId: "fixture", prompt: "Make the change" }, ghRunner);
      expect(first).toEqual(second);
      expect(first.headSha).not.toBe(sha);
      expect(first.prUrl).toBe("https://github.com/example/project/pull/7");
      expect(await runCommand("git", ["--git-dir", bare, "rev-parse", "refs/heads/codex/fixture-a1"], root)).toBe(first.headSha);
      const authWorktree = await prepareWorktree({ runId: "auth-failure", projectRoot: root, baseSha: sha, branch: "codex/auth-failure-a1", requiredSourcePaths: ["src/app.js"] });
      await writeFile(path.join(authWorktree, "src", "app.js"), "export const value = 3;\n");
      let createCalled = false;
      await expect(publishWorktree({ repository: { ...repository, branch: "codex/auth-failure-a1" }, worktree: authWorktree, taskId: "auth-failure", prompt: "Must not create" }, async (command, args, cwd) => {
        if (command === "gh" && args[0] === "pr" && args[1] === "view") throw new Error("gh auth status failed: HTTP 401");
        if (command === "gh" && args[0] === "pr" && args[1] === "create") createCalled = true;
        return runCommand(command, args, cwd);
      })).rejects.toThrow("could not verify existing draft PR");
      expect(createCalled).toBe(false);
    } finally {
      await runCommand("git", ["worktree", "remove", "--force", path.join(process.env.ORCHESTRATOR_DATA_DIR!, "worktrees", "fixture-run")], root).catch(() => {});
      await runCommand("git", ["worktree", "remove", "--force", path.join(process.env.ORCHESTRATOR_DATA_DIR!, "worktrees", "auth-failure")], root).catch(() => {});
      if (oldData === undefined) delete process.env.ORCHESTRATOR_DATA_DIR; else process.env.ORCHESTRATOR_DATA_DIR = oldData;
    }
  }, 30_000);

  it("creates stable task branch names per retry attempt", () => {
    expect(taskBranch("LOC-11", "rev 2", 1)).toBe("codex/loc-11-rev-2-a1");
    expect(taskBranch("LOC-11", "rev 2", 2)).not.toBe(taskBranch("LOC-11", "rev 2", 1));
  });

  it("fails source-presence admission when required committed files are missing", async () => {
    const { root, sha } = await fixture();
    const previous = process.env.ORCHESTRATOR_DATA_DIR; process.env.ORCHESTRATOR_DATA_DIR = path.join(root, "run-data");
    try {
      await expect(prepareWorktree({ runId: "missing-source", projectRoot: root, baseSha: sha, branch: "codex/missing-source-a1", requiredSourcePaths: ["index.html", "src/app.js"] })).rejects.toThrow("required committed project files are missing");
    } finally { if (previous === undefined) delete process.env.ORCHESTRATOR_DATA_DIR; else process.env.ORCHESTRATOR_DATA_DIR = previous; }
  });

  it("retargets and rebases a child after its parent merges, leaving conflicts for a human", async () => {
    const { root } = await fixture(); const calls: string[][] = [];
    const runner = async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view" && args[2] === "https://github.com/example/project/pull/4") return JSON.stringify({ state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" });
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ state: "OPEN", baseRefName: "codex/parent-a1" });
      if (args[0] === "rev-parse") return "a".repeat(40);
      return "";
    };
    const result = await syncMergedStack({ worktree: root, childBranch: "codex/child-a1", parentPrUrl: "https://github.com/example/project/pull/4", targetBranch: "main", remote: "origin" }, runner);
    expect(result).toEqual({ updated: true, headSha: "a".repeat(40) });
    expect(calls.some(args => args[0] === "rebase")).toBe(true);
    expect(calls.some(args => args[0] === "push" && args.includes("--force-with-lease"))).toBe(true);
    expect(calls.some(args => args[0] === "pr" && args[1] === "edit" && args.includes("main"))).toBe(true);
    await expect(syncMergedStack({ worktree: root, childBranch: "codex/child-a1", parentPrUrl: "https://github.com/example/project/pull/4", targetBranch: "main", remote: "origin" }, async (_command, args) => {
      if (args[0] === "pr" && args[1] === "view" && args[2]?.includes("pull/4")) return JSON.stringify({ state: "MERGED", mergedAt: "yes" });
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ state: "OPEN", baseRefName: "codex/parent-a1" });
      if (args[0] === "rebase") throw new Error("CONFLICT");
      return "";
    })).rejects.toThrow("CONFLICT");
  });
});

describe("admission with Windows line endings (regression: bridge container vs Windows checkout)", () => {
  const gitOnlyRunner = async (command: string, args: string[], cwd: string) => {
    if (command === "git" && args[0] === "remote") return "https://github.com/example/project.git";
    if (command === "git" && args[0] === "fetch") return "";
    if (command === "git" && args[0] === "rev-parse" && args[1] === "FETCH_HEAD^{commit}") return runCommand("git", ["rev-parse", "HEAD"], cwd);
    return runCommand(command, args, cwd);
  };
  it("treats CRLF working files over an LF index as clean, but still rejects real edits", async () => {
    const { root } = await fixture();
    await runCommand("git", ["config", "core.autocrlf", "false"], root);
    await writeFile(path.join(root, "src", "app.js"), "export const value = 1;\r\n");
    expect(await runCommand("git", ["status", "--porcelain"], root)).toContain("src/app.js");
    await expect(admitRepository({ projectRoot: root, remote: "origin", targetBranch: "main" }, gitOnlyRunner)).resolves.toMatchObject({ baseSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
    await writeFile(path.join(root, "src", "app.js"), "export const value = 2;\r\n");
    await expect(admitRepository({ projectRoot: root, remote: "origin", targetBranch: "main" }, gitOnlyRunner)).rejects.toThrow("working tree is not clean");
  }, 30_000);
});

describe("dirtyEntries", () => {
  it("still counts deletions and untracked files as dirty", async () => {
    const { root } = await fixture();
    expect(await dirtyEntries(root)).toEqual([]);
    await rm(path.join(root, "src", "app.js"));
    expect((await dirtyEntries(root)).join()).toContain("src/app.js");
    await writeFile(path.join(root, "new.js"), "x");
    expect((await dirtyEntries(root)).join()).toContain("new.js");
  });
});
