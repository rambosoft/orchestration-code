import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { runCommand, type CommandRunner } from "./command.js";

export type CleanupResult = { removed: string[]; kept: string[]; errors: string[] };

/**
 * Remove task worktrees left under `<dataDir>/worktrees`. Only worktrees older than `olderThanDays` are removed unless `all` is set;
 * branches are never deleted (they back pushed draft PRs). `dryRun` reports what would be removed.
 */
export async function cleanupWorktrees(options: { dataDir: string; olderThanDays?: number; all?: boolean; dryRun?: boolean; now?: number; run?: CommandRunner }): Promise<CleanupResult> {
  const run = options.run ?? runCommand;
  const base = path.join(path.resolve(options.dataDir), "worktrees");
  const cutoff = (options.now ?? Date.now()) - (options.olderThanDays ?? 7) * 86_400_000;
  const result: CleanupResult = { removed: [], kept: [], errors: [] };
  let entries: string[];
  try { entries = await readdir(base); } catch { return result; }
  for (const name of entries) {
    const dir = path.join(base, name);
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) continue;
      if (!options.all && info.mtimeMs > cutoff) { result.kept.push(dir); continue; }
      if (options.dryRun) { result.removed.push(dir); continue; }
      let mainRepo: string | undefined;
      try { mainRepo = path.resolve(dir, await run("git", ["rev-parse", "--git-common-dir"], dir)); mainRepo = path.dirname(mainRepo); } catch { mainRepo = undefined; }
      if (mainRepo) {
        await run("git", ["worktree", "remove", "--force", dir], mainRepo);
        await run("git", ["worktree", "prune"], mainRepo).catch(() => "");
      } else await rm(dir, { recursive: true, force: true });
      result.removed.push(dir);
    } catch (error) { result.errors.push(`${dir}: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`); }
  }
  return result;
}
