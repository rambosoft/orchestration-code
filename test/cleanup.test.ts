import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanupWorktrees } from "../src/cleanup.js";
import { runCommand } from "../src/command.js";

const roots: string[] = [];
const exists = (p: string) => access(p).then(() => true, () => false);
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "orch-clean-")); roots.push(root);
  const repo = path.join(root, "repo"); const data = path.join(root, "data");
  await mkdir(repo); await mkdir(path.join(data, "worktrees"), { recursive: true });
  await runCommand("git", ["init", "-b", "main"], repo);
  await writeFile(path.join(repo, "a.txt"), "a");
  await runCommand("git", ["add", "--all"], repo);
  await runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", "base"], repo);
  const add = async (name: string, ageDays: number) => {
    const dir = path.join(data, "worktrees", name);
    await runCommand("git", ["worktree", "add", "-b", `codex/${name}`, dir], repo);
    const when = new Date(Date.now() - ageDays * 86_400_000); await utimes(dir, when, when);
    return dir;
  };
  return { repo, data, add };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("cleanupWorktrees", () => {
  it("removes only worktrees older than the threshold and keeps their branches", async () => {
    const { repo, data, add } = await setup();
    const old = await add("old-run", 10); const fresh = await add("fresh-run", 0);
    const result = await cleanupWorktrees({ dataDir: data, olderThanDays: 7 });
    expect(result.errors).toEqual([]);
    expect(result.removed).toEqual([old]); expect(result.kept).toEqual([fresh]);
    expect(await exists(old)).toBe(false); expect(await exists(fresh)).toBe(true);
    expect(await runCommand("git", ["branch", "--list", "codex/old-run"], repo)).toContain("codex/old-run");
    expect(await runCommand("git", ["worktree", "list", "--porcelain"], repo)).not.toContain("old-run");
  }, 30_000);
  it("dry run changes nothing and --all ignores age", async () => {
    const { data, add } = await setup();
    const fresh = await add("fresh-run", 0);
    const dry = await cleanupWorktrees({ dataDir: data, all: true, dryRun: true });
    expect(dry.removed).toEqual([fresh]); expect(await exists(fresh)).toBe(true);
    const real = await cleanupWorktrees({ dataDir: data, all: true });
    expect(real.removed).toEqual([fresh]); expect(await exists(fresh)).toBe(false);
  }, 30_000);
  it("is a no-op when there is no worktrees directory", async () => {
    expect(await cleanupWorktrees({ dataDir: path.join(os.tmpdir(), "orch-clean-missing-dir") })).toEqual({ removed: [], kept: [], errors: [] });
  });
});
