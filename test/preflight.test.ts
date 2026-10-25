import { describe, expect, it, vi } from "vitest";
import { diskProblem, MAX_WORKTREE_PATH_CHARS, MIN_FREE_BYTES, unityPreflight, worktreePathProblem } from "../src/preflight.js";

const GB = 1024 ** 3;
const ok = { freeBytes: async () => 100 * GB, stopEditors: async () => [] as number[], waitUnlock: async () => 0 };

describe("worktreePathProblem", () => {
  it("accepts the short worktree root and rejects a path above the limit (FM-047)", () => {
    expect(worktreePathProblem("C:/w/553f55f3-92a4-4792-b9da-fc66725ca916")).toBeUndefined();
    expect(worktreePathProblem(`C:/${"a".repeat(MAX_WORKTREE_PATH_CHARS - 3)}`)).toBeUndefined();
    const long = worktreePathProblem(`C:/${"a".repeat(MAX_WORKTREE_PATH_CHARS - 2)}`);
    expect(long).toContain("ORCHESTRATOR_WORKTREES_DIR");
    expect(long).toContain(String(MAX_WORKTREE_PATH_CHARS + 1));
  });
});

describe("diskProblem", () => {
  it("fails below the threshold, passes at it, and ignores an unreadable disk", () => {
    expect(diskProblem(MIN_FREE_BYTES - 1)).toContain("GB are free");
    expect(diskProblem(MIN_FREE_BYTES)).toBeUndefined();
    expect(diskProblem(undefined)).toBeUndefined();
  });
});

describe("unityPreflight", () => {
  it("returns nothing to fix or report for a healthy worktree", async () => {
    await expect(unityPreflight("C:/w/abc", ok)).resolves.toEqual({ fixed: [], problems: [] });
  });
  it("lists the Editors it stopped as a fix", async () => {
    const stopEditors = vi.fn(async () => [11, 12]);
    const result = await unityPreflight("C:/w/abc", { ...ok, stopEditors });
    expect(result.fixed).toEqual(["stopped 2 Unity process(es) that had the worktree open"]);
    expect(stopEditors).toHaveBeenCalledWith("C:/w/abc");
  });
  it("removes a lock nobody released within the timeout and says so", async () => {
    const removeLock = vi.fn(async (_lockfile: string) => undefined);
    const result = await unityPreflight("C:/w/abc", { ...ok, waitUnlock: async (_root, timeout) => timeout, removeLock, lockTimeoutMs: 1000 });
    expect(result).toEqual({ fixed: ["removed a stale Temp/UnityLockfile"], problems: [] });
    expect(removeLock.mock.calls[0]![0]).toMatch(/Temp[\\/]UnityLockfile$/);
  });
  it("reports a lock that cannot be removed instead of fixing it", async () => {
    const result = await unityPreflight("C:/w/abc", { ...ok, waitUnlock: async (_root, timeout) => timeout, removeLock: async () => { throw new Error("EBUSY"); }, lockTimeoutMs: 1000 });
    expect(result.fixed).toEqual([]);
    expect(result.problems[0]).toContain("still held after 1s");
  });
  it("collects every problem it cannot fix: path, disk", async () => {
    const result = await unityPreflight(`C:/${"a".repeat(120)}`, { ...ok, freeBytes: async () => 2 * GB });
    expect(result.problems).toHaveLength(2);
    expect(result.problems.join(" ")).toContain("ORCHESTRATOR_WORKTREES_DIR");
    expect(result.problems.join(" ")).toContain("2.0 GB");
  });
  it("never throws when the disk or the process list cannot be read", async () => {
    const result = await unityPreflight("C:/w/abc", { freeBytes: async () => { throw new Error("no disk"); }, stopEditors: async () => { throw new Error("no wmi"); }, waitUnlock: async () => { throw new Error("no fs"); } });
    expect(result).toEqual({ fixed: [], problems: [] });
  });
});
