// Preflight for a Unity task worktree: the environment problems of the first live game run (FM-047 long paths, FM-051 open Editors, stale project locks, a full disk) are checked and, where it is safe, fixed
// before the import and the agents start, so they cost seconds instead of a failed stage.
import { rm, statfs } from "node:fs/promises";
import path from "node:path";
import { stopProjectEditors, waitForProjectUnlock } from "./unity.js";

/** An Android IL2CPP build failed with 'ninja: build.ninja still dirty' from a worktree path around 150 characters; the short root C:/w gives about 41. */
export const MAX_WORKTREE_PATH_CHARS = 90;
/** Library, the Android build and the worktree's checkout together need well over this; below it builds fail late with confusing errors. */
export const MIN_FREE_BYTES = 15 * 1024 ** 3;

export type PreflightResult = { fixed: string[]; problems: string[] };
export type PreflightDeps = {
  freeBytes?: (dir: string) => Promise<number | undefined>;
  stopEditors?: (projectRoot: string) => Promise<number[]>;
  waitUnlock?: (projectRoot: string, timeoutMs: number) => Promise<number>;
  removeLock?: (lockfile: string) => Promise<void>;
  lockTimeoutMs?: number;
};

export const worktreePathProblem = (root: string): string | undefined => {
  const length = (/^[A-Za-z]:[\\/]|^[\\/]/.test(root) ? root : path.resolve(root)).length;
  return length > MAX_WORKTREE_PATH_CHARS ? `the worktree path is ${length} characters (limit ${MAX_WORKTREE_PATH_CHARS}); Android builds fail from long paths. Set ORCHESTRATOR_WORKTREES_DIR to a short folder such as C:/w and restart the worker` : undefined;
};
export const diskProblem = (freeBytes: number | undefined): string | undefined =>
  freeBytes !== undefined && freeBytes < MIN_FREE_BYTES ? `only ${(freeBytes / 1024 ** 3).toFixed(1)} GB are free where the worktree lives (need ${MIN_FREE_BYTES / 1024 ** 3} GB); clean old worktrees with "npm run cleanup" or free disk space` : undefined;

async function freeBytesOf(dir: string): Promise<number | undefined> {
  try { const stats = await statfs(dir); return Number(stats.bavail) * Number(stats.bsize); } catch { return undefined; }
}

/**
 * Stops Editors that hold the worktree, clears a project lock nobody holds, and reports what cannot be fixed (path too long, disk too small).
 * Never throws: an unreadable disk or process list must not stop a run that would have worked.
 */
export async function unityPreflight(projectRoot: string, deps: PreflightDeps = {}): Promise<PreflightResult> {
  const fixed: string[] = []; const problems: string[] = [];
  const pathProblem = worktreePathProblem(projectRoot);
  if (pathProblem) problems.push(pathProblem);
  const free = await (deps.freeBytes ?? freeBytesOf)(projectRoot).catch(() => undefined);
  const lowDisk = diskProblem(free);
  if (lowDisk) problems.push(lowDisk);
  const stopped = await (deps.stopEditors ?? stopProjectEditors)(projectRoot).catch(() => [] as number[]);
  if (stopped.length) fixed.push(`stopped ${stopped.length} Unity process(es) that had the worktree open`);
  const timeoutMs = deps.lockTimeoutMs ?? 30_000;
  const waited = await (deps.waitUnlock ?? ((root, timeout) => waitForProjectUnlock(root, timeout)))(projectRoot, timeoutMs).catch(() => 0);
  if (waited >= timeoutMs) {
    const lockfile = path.join(projectRoot, "Temp", "UnityLockfile");
    try { await (deps.removeLock ?? ((file: string) => rm(file, { force: true })))(lockfile); fixed.push("removed a stale Temp/UnityLockfile"); }
    catch { problems.push(`Temp/UnityLockfile is still held after ${Math.round(timeoutMs / 1000)}s and could not be removed; close the Unity process that has ${projectRoot} open`); }
  }
  return { fixed, problems };
}
