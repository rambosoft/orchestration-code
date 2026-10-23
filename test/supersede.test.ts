import { describe, expect, it } from "vitest";
import { closeSupersededPullRequests, supersededPullRequests, taskBranch, type OpenPullRequest } from "../src/workspaces.js";

// Found in the Aurora Store build: Paperclip's review path reran tasks, each rerun got a new branch (the issue revision is part of the name) and opened a second PR.
const TASK = "6c3fb3d5-797e-4224-926e-6b0a90602670";
const pr = (number: number, branch: string, body = `Paperclip task: ${TASK}\n\nAutomated review and deterministic quality gates passed.`): OpenPullRequest => ({ number, url: `https://github.com/me/shop/pull/${number}`, headRefName: branch, body });
const first = taskBranch(TASK, "2026-10-23T17:49:10.666Z", 1);
const second = taskBranch(TASK, "2026-10-23T17:52:34.015Z", 1);

describe("superseded pull requests", () => {
  it("finds the open PRs of earlier runs of the same task, and never the current one", () => {
    const open = [pr(6, first), pr(7, second)];
    expect(supersededPullRequests(open, TASK, second).map(item => item.number)).toEqual([6]);
    expect(supersededPullRequests(open, TASK, first).map(item => item.number)).toEqual([7]);
    expect(supersededPullRequests([pr(7, second)], TASK, second)).toEqual([]);
  });
  it("leaves other tasks alone, even when their id starts the same way", () => {
    const other = taskBranch(`${TASK}-extra`, "rev", 1);
    const open = [pr(1, first), pr(2, other, `Paperclip task: ${TASK}-extra\n\nx`), pr(3, taskBranch("different", "rev", 1), "Paperclip task: different\n")];
    expect(supersededPullRequests(open, TASK, second).map(item => item.number)).toEqual([1]);
  });
  it("needs both the branch prefix and the task line in the body, so a hand-made PR is never closed", () => {
    expect(supersededPullRequests([pr(1, first, "Fix by hand, no task line")], TASK, second)).toEqual([]);
    expect(supersededPullRequests([pr(1, "feature/mine", `Paperclip task: ${TASK}\n`)], TASK, second)).toEqual([]);
    expect(supersededPullRequests([{ number: 1, url: "u", headRefName: first }], TASK, second)).toEqual([]);
  });
});

describe("closeSupersededPullRequests", () => {
  const run = (open: OpenPullRequest[]) => {
    const calls: string[][] = [];
    const runner = async (_command: string, args: string[]) => { calls.push(args); return args[1] === "list" ? JSON.stringify(open) : ""; };
    return { calls, runner };
  };
  it("closes each earlier attempt with a pointer to the new PR, keeps the branch, and reports what it closed", async () => {
    const { calls, runner } = run([pr(6, first), pr(7, second), pr(9, taskBranch("other", "r", 1), "Paperclip task: other\n")]);
    const closed = await closeSupersededPullRequests({ taskId: TASK, currentBranch: second, currentUrl: "https://github.com/me/shop/pull/7", worktree: "w" }, runner);
    expect(closed).toEqual(["https://github.com/me/shop/pull/6"]);
    const close = calls.filter(args => args[1] === "close");
    expect(close).toHaveLength(1);
    expect(close[0]!.slice(0, 3)).toEqual(["pr", "close", "6"]);
    expect(close[0]!.join(" ")).toContain("Superseded by https://github.com/me/shop/pull/7");
    expect(close[0]).not.toContain("--delete-branch");
  });
  it("does nothing when there is nothing to supersede", async () => {
    const { calls, runner } = run([pr(7, second)]);
    expect(await closeSupersededPullRequests({ taskId: TASK, currentBranch: second, currentUrl: "u", worktree: "w" }, runner)).toEqual([]);
    expect(calls.some(args => args[1] === "close")).toBe(false);
  });
  it("only ever lists open PRs", async () => {
    const { calls, runner } = run([]);
    await closeSupersededPullRequests({ taskId: TASK, currentBranch: second, currentUrl: "u", worktree: "w" }, runner);
    expect(calls[0]).toEqual(expect.arrayContaining(["--state", "open"]));
  });
});
